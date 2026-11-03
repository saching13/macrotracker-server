import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  onSessionChange,
  refreshSession,
  type Session,
  setSession,
  unwrap,
} from './api/client';

interface Auth {
  /** Undefined while the first refresh is in flight. */
  session: Session | null | undefined;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<Auth | null>(null);

export function useAuth(): Auth {
  const a = use(AuthContext);
  if (!a) throw new Error('useAuth outside AuthProvider');
  return a;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setState] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    const off = onSessionChange(setState);
    void refreshSession().then((s) => setState(s));
    return () => {
      off();
    };
  }, []);

  const value: Auth = {
    session,
    async signIn(email, password) {
      const s = await unwrap(
        api.POST('/v1/auth/login', {
          body: { email, password, device: { name: browserName(), platform: 'web' }, client: 'web' },
        }),
      );
      setSession(s);
    },
    async signOut() {
      try {
        await unwrap(api.POST('/v1/auth/logout'));
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
      }
      setSession(null);
    },
  };
  return <AuthContext value={value}>{children}</AuthContext>;
}

/** "Safari on macOS": how this browser shows up in the device list. */
function browserName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}
