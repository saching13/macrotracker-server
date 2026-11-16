import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError, unwrap } from '../api/client';
import { useAuth } from '../auth';

type Mode = 'signIn' | 'signUp';

/** Sign in, or (when the server allows it) create an account. */
export function LoginPage() {
  const { signIn, signUp } = useAuth();
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => unwrap(api.GET('/v1/meta')) });
  const open = meta.data?.signup === 'open';
  const [mode, setMode] = useState<Mode>('signIn');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creating = open && mode === 'signUp';

  function switchTo(m: Mode) {
    setMode(m);
    setError(null);
    setConfirm('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (creating && password !== confirm) {
      setError('The passwords don’t match.');
      return;
    }
    setBusy(true);
    try {
      if (creating) {
        await signUp(email.trim(), password, name.trim() || undefined);
      } else {
        await signIn(email.trim(), password);
      }
    } catch (err) {
      setError(messageFor(err, creating));
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <h1>MacroTracker</h1>
      <p className="secondary">
        {creating
          ? 'Create an account to sync your diary, weight and targets across your phone and the web.'
          : open
            ? 'Sign in to see your diary, weight and targets.'
            : 'Sign in to see your diary, weight and targets. Accounts are by invite: ask the person who runs ' +
              'this server.'}
      </p>
      <form onSubmit={submit}>
        {creating && (
          <label className="field">
            <span>Name (optional)</span>
            <input
              className="input"
              type="text"
              autoComplete="name"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
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
            autoComplete={creating ? 'new-password' : 'current-password'}
            required
            minLength={creating ? 10 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {creating && (
          <label className="field">
            <span>Confirm password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        )}
        {creating && <p className="secondary">At least 10 characters.</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p>
          <button className="button wide" type="submit" disabled={busy}>
            {creating ? (busy ? 'Creating account…' : 'Create account') : busy ? 'Signing in…' : 'Sign in'}
          </button>
        </p>
      </form>
      {open && (
        <p className="secondary">
          {creating ? 'Already have an account? ' : 'New here? '}
          <button
            className="button plain"
            type="button"
            onClick={() => switchTo(creating ? 'signIn' : 'signUp')}
          >
            {creating ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      )}
    </main>
  );
}

function messageFor(err: unknown, creating: boolean): string {
  if (err instanceof ApiError) {
    if (!creating && err.status === 401) return 'Wrong email or password.';
    if (creating && err.status === 409) return 'An account with this email already exists. Sign in instead.';
    if (creating && err.status === 403) return 'This server doesn’t allow new accounts.';
    if (err.status === 429) return 'Too many attempts. Try again in a few minutes.';
  }
  return err instanceof Error ? err.message : creating ? 'Couldn’t create the account.' : 'Couldn’t sign in.';
}
