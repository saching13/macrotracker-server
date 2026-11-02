import { createHash, randomBytes } from 'node:crypto';
import { PAT_PREFIX } from '@macrotracker/shared';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A new personal access token: 256 random bits behind a recognizable prefix. */
export function generatePat(): { token: string; prefix: string; hash: string } {
  const token = PAT_PREFIX + randomBytes(32).toString('base64url');
  return { token, prefix: token.slice(0, PAT_PREFIX.length + 6), hash: hashToken(token) };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
