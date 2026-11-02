import { SignJWT } from 'jose';

/** A failed GoTrue call. `status` and `code` are GoTrue's own. */
export class GoTrueError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GoTrueError';
  }
}

export interface GoTrueUser {
  id: string;
  email?: string;
  created_at: string;
  invited_at?: string | null;
  confirmed_at?: string | null;
  email_confirmed_at?: string | null;
  last_sign_in_at?: string | null;
}

export interface GoTrueSession {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: GoTrueUser;
}

export interface GeneratedLink extends GoTrueUser {
  hashed_token: string;
  verification_type: string;
}

export type LinkType = 'invite' | 'recovery';

interface CallOptions {
  body?: unknown;
  token?: string;
  admin?: boolean;
  clientIp?: string;
}

/**
 * Thin client for the GoTrue (Supabase Auth) REST API. GoTrue is reachable only
 * from inside the deployment; every client talks to our API, which calls this.
 */
export class GoTrue {
  private readonly key: Uint8Array;

  constructor(
    private readonly baseUrl: string,
    jwtSecret: string,
    private readonly issuer: string,
    private readonly timeoutMs = 10_000,
  ) {
    this.key = new TextEncoder().encode(jwtSecret);
  }

  /** Short-lived service-role token for GoTrue's admin endpoints. */
  private adminToken(): Promise<string> {
    return new SignJWT({ role: 'service_role' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.issuer)
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(this.key);
  }

  private async call<T>(method: string, path: string, opts: CallOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const bearer = opts.admin ? await this.adminToken() : opts.token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (opts.clientIp) headers['x-client-ip'] = opts.clientIp;

    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new GoTrueError(503, 'auth_unavailable', `GoTrue unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: Record<string, unknown> | null = null;
    if (text) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const code = String(data?.error_code ?? data?.error ?? 'auth_error');
      const message = String(
        data?.msg ?? data?.error_description ?? data?.message ?? `GoTrue HTTP ${res.status}`,
      );
      throw new GoTrueError(res.status, code, message);
    }
    return data as T;
  }

  health(): Promise<unknown> {
    return this.call('GET', '/health');
  }

  passwordGrant(email: string, password: string, clientIp?: string): Promise<GoTrueSession> {
    return this.call('POST', '/token?grant_type=password', { body: { email, password }, clientIp });
  }

  refreshGrant(refreshToken: string, clientIp?: string): Promise<GoTrueSession> {
    return this.call('POST', '/token?grant_type=refresh_token', {
      body: { refresh_token: refreshToken },
      clientIp,
    });
  }

  /** Redeems an invite/recovery link's token hash for a session. */
  verify(type: LinkType, tokenHash: string, clientIp?: string): Promise<GoTrueSession> {
    return this.call('POST', '/verify', { body: { type, token_hash: tokenHash }, clientIp });
  }

  setPassword(accessToken: string, password: string): Promise<GoTrueUser> {
    return this.call('PUT', '/user', { token: accessToken, body: { password } });
  }

  /** `local`: this session; `others`: every other session of the user. */
  async logout(accessToken: string, scope: 'local' | 'others' | 'global'): Promise<void> {
    await this.call('POST', `/logout?scope=${scope}`, { token: accessToken });
  }

  adminCreateUser(email: string, password: string): Promise<GoTrueUser> {
    return this.call('POST', '/admin/users', { admin: true, body: { email, password, email_confirm: true } });
  }

  adminGenerateLink(type: LinkType, email: string): Promise<GeneratedLink> {
    return this.call('POST', '/admin/generate_link', { admin: true, body: { type, email } });
  }

  adminGetUser(id: string): Promise<GoTrueUser> {
    return this.call('GET', `/admin/users/${encodeURIComponent(id)}`, { admin: true });
  }

  async adminListUsers(): Promise<GoTrueUser[]> {
    const all: GoTrueUser[] = [];
    for (let page = 1; ; page++) {
      const res = await this.call<{ users: GoTrueUser[] }>('GET', `/admin/users?page=${page}&per_page=200`, {
        admin: true,
      });
      all.push(...res.users);
      if (res.users.length < 200) return all;
    }
  }

  async adminDeleteUser(id: string): Promise<void> {
    await this.call('DELETE', `/admin/users/${encodeURIComponent(id)}`, { admin: true });
  }
}
