import { type FormEvent, useState } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../auth';

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Wrong email or password.'
          : err instanceof Error
            ? err.message
            : 'Couldn’t sign in.',
      );
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <h1>MacroTracker</h1>
      <p className="secondary">
        Sign in to see your diary, weight and targets. Accounts are by invite: ask the person who runs this
        server.
      </p>
      <form onSubmit={submit}>
        <label className="field">
          <span>Email</span>
          <input
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p>
          <button className="button wide" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </p>
      </form>
    </main>
  );
}
