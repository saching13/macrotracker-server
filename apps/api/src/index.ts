import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';

async function main() {
  const config = loadConfig();
  if (config.MIGRATION_DATABASE_URL) await runMigrations(config.MIGRATION_DATABASE_URL);

  const app = await buildApp({ config });
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      app.log.info({ signal }, 'shutting down');
      const force = setTimeout(() => process.exit(1), 10_000);
      force.unref();
      app.close().then(
        () => process.exit(0),
        (err) => {
          app.log.error({ err }, 'shutdown failed');
          process.exit(1);
        },
      );
    });
  }
  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
