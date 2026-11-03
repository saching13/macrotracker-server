import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';

export type Schemas = components['schemas'];
export type Session = Schemas['Session'];

/**
 * The access token lives only in memory. The refresh token is an httpOnly
 * cookie the browser sends to /v1/auth (never readable by scripts); refresh
 * proves it's us with the `mt_csrf` cookie echoed in a header.
 */
let accessToken: string | null = null;
let expiresAt = 0;
let refreshing: Promise<Session | null> | null = null;
const listeners = new Set<(s: Session | null) => void>();

export function onSessionChange(fn: (s: Session | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setSession(s: Session | null): void {
  accessToken = s?.access_token ?? null;
  expiresAt = s ? s.expires_at * 1000 : 0;
  for (const fn of listeners) fn(s);
}

function csrfToken(): string {
  const m = /(?:^|;\s*)mt_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : '';
}

/** Exchanges the refresh cookie for a new session; null when signed out. */
export function refreshSession(): Promise<Session | null> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/v1/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': csrfToken() },
      });
      const s = res.ok ? ((await res.json()) as Session) : null;
      setSession(s);
      return s;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * A random v4 UUID. `crypto.randomUUID` needs a secure context, and a server
 * on a tailnet or LAN address may be plain HTTP.
 */
function requestId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Calls that authenticate by themselves (password, link, refresh cookie). */
const NO_BEARER = /\/v1\/auth\/(login|refresh|complete-link)$/;

const auth: Middleware = {
  async onRequest({ request }) {
    if (NO_BEARER.test(new URL(request.url).pathname)) return request;
    if (!accessToken || Date.now() > expiresAt - 60_000) await refreshSession();
    if (accessToken) request.headers.set('authorization', `Bearer ${accessToken}`);
    request.headers.set('x-request-id', requestId());
    return request;
  },
  async onResponse({ request, response }) {
    // The token stopped working early: refresh, and retry reads (a body
    // can't be sent twice; a failed write is reported instead).
    if (response.status !== 401 || NO_BEARER.test(new URL(request.url).pathname)) return response;
    const s = await refreshSession();
    if (!s || (request.method !== 'GET' && request.method !== 'DELETE')) return response;
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${s.access_token}`);
    return fetch(request.url, { method: request.method, headers, credentials: 'include' });
  },
};

export const api = createClient<paths>({ baseUrl: '', credentials: 'include' });
api.use(auth);

/** The error the server sent (`{error: {code, message}}`), as an Error. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Unwraps an openapi-fetch result, throwing ApiError on failure. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (response.ok) return data as T;
  const e = (error as { error?: { code?: string; message?: string } } | undefined)?.error;
  throw new ApiError(
    response.status,
    e?.code ?? 'error',
    e?.message ?? `Request failed (${response.status})`,
  );
}
