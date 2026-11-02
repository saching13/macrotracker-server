// Creates an admin account. Run inside the api container:
//   docker compose exec api node dist/cli/create-admin.js --email you@example.com [--name "You"]
// Prints an invite link to set the password, or with --password-stdin reads the
// password from standard input instead.
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createDatabase, withContext } from '../db/client.js';
import { appUsers, auditEvents } from '../db/schema.js';
import { actionUrl } from '../routes/admin.js';
import { GoTrue } from '../services/gotrue.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    'password-stdin': { type: 'boolean', default: false },
  },
});

if (!values.email) {
  console.error('usage: create-admin --email <email> [--name <display name>] [--password-stdin]');
  process.exit(2);
}

const config = loadConfig();
const gotrue = new GoTrue(config.GOTRUE_URL, config.JWT_SECRET, config.JWT_ISSUER);
const database = createDatabase(config.DATABASE_URL, 1);
const email = values.email.toLowerCase();

try {
  let userId: string;
  let url: string | null = null;
  if (values['password-stdin']) {
    const password = await readStdin();
    if (password.length < 10) throw new Error('password must be at least 10 characters');
    userId = (await gotrue.adminCreateUser(email, password)).id;
  } else {
    const link = await gotrue.adminGenerateLink('invite', email);
    userId = link.id;
    url = actionUrl(config.PUBLIC_URL, 'invite', link.hashed_token);
  }

  await withContext(database.db, { userId, isAdmin: true }, async (tx) => {
    await tx
      .insert(appUsers)
      .values({ userId, role: 'admin', displayName: values.name ?? null })
      .onConflictDoUpdate({ target: appUsers.userId, set: { role: 'admin' } });
    await tx
      .insert(auditEvents)
      .values({ event: 'admin.bootstrap', userId, actorId: null, details: { email } });
  });

  console.log(`Admin ${email} created (${userId}).`);
  if (url) console.log(`Open this link to set the password (valid 24 hours):\n${url}`);
} catch (err) {
  console.error(`Failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await database.close();
}
