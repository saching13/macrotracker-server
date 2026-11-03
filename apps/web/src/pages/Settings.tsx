import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, type Schemas, unwrap } from '../api/client';
import { useAuth } from '../auth';
import { OrbLoader, Section } from '../components/ui';

const SCOPE_LABELS: Record<string, string> = {
  'mcp:read': 'Read',
  'mcp:write': 'Log and edit',
  'mcp:destroy': 'Delete',
};

const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
    : 'Never';

export function SettingsPage() {
  const { signOut, session } = useAuth();
  return (
    <>
      <h1>Settings</h1>
      <p className="secondary">Signed in as {session?.user.email}</p>
      <Units />
      <Devices />
      <Tokens />
      <Password />
      {session?.user.role === 'admin' && <Admin />}
      <p>
        <button className="button tonal wide" type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </p>
    </>
  );
}

function Units() {
  const qc = useQueryClient();
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => unwrap(api.GET('/v1/profile')) });
  const set = useMutation({
    mutationFn: (b: { unit_mass?: 'kg' | 'lb'; unit_energy?: 'kcal' | 'kj' }) =>
      unwrap(api.PATCH('/v1/profile', { body: b })),
    onSuccess: () => qc.invalidateQueries(),
  });
  const p = profile.data?.profile;
  if (!p) return null;
  return (
    <Section
      header="Units"
      footer="Changes how values are shown here and on your phones. History stays in kg and kcal."
    >
      <div className="row">
        <span className="grow">Weight & height</span>
        <div className="segmented" role="group" aria-label="Weight units">
          {(['kg', 'lb'] as const).map((u) => (
            <button
              key={u}
              type="button"
              aria-pressed={p.unit_mass === u}
              onClick={() => set.mutate({ unit_mass: u })}
            >
              {u === 'kg' ? 'kg · cm' : 'lb · ft'}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <span className="grow">Energy</span>
        <div className="segmented" role="group" aria-label="Energy units">
          {(['kcal', 'kj'] as const).map((u) => (
            <button
              key={u}
              type="button"
              aria-pressed={p.unit_energy === u}
              onClick={() => set.mutate({ unit_energy: u })}
            >
              {u === 'kcal' ? 'kcal' : 'kJ'}
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}

function Devices() {
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => unwrap(api.GET('/v1/devices')) });
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/v1/devices/{id}', { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  });
  const live = (devices.data ?? []).filter((d) => !d.revoked_at);
  return (
    <Section
      header="Signed-in devices"
      footer="Signing a device out stops it at once; it has to sign in again."
    >
      {devices.isPending && <OrbLoader />}
      {live.map((d) => (
        <div className="row" key={d.id}>
          <span className="grow">
            <div className="name">{d.name}</div>
            <div className="secondary small">
              {d.current ? 'This browser' : `Last seen ${when(d.last_seen_at)}`}
            </div>
          </span>
          {!d.current && (
            <button className="button danger" type="button" onClick={() => revoke.mutate(d.id)}>
              Sign out
            </button>
          )}
        </div>
      ))}
    </Section>
  );
}

function Tokens() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => unwrap(api.GET('/v1/tokens')) });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['mcp:read']);
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/v1/tokens', {
          body: { name: name.trim(), scopes: scopes as Schemas['ApiToken']['scopes'] },
        }),
      ),
    onSuccess: async (t) => {
      setCreated(t.token);
      setName('');
      await qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/v1/tokens/{id}', { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }),
  });
  const live = (tokens.data ?? []).filter((t) => !t.revoked_at);
  return (
    <Section
      header="Access tokens"
      footer="For AI agents and scripts (MCP). A token can only do what its scopes allow, and never manage your account."
    >
      {live.map((t) => (
        <div className="row" key={t.id}>
          <span className="grow">
            <div className="name">{t.name}</div>
            <div className="secondary small">
              {t.scopes.map((s) => SCOPE_LABELS[s] ?? s).join(' · ')} · used {when(t.last_used_at)}
            </div>
          </span>
          <button className="button danger" type="button" onClick={() => revoke.mutate(t.id)}>
            Revoke
          </button>
        </div>
      ))}
      {created && (
        <div className="row">
          <span className="grow">
            <div>Copy this token now; it won’t be shown again.</div>
            <div className="token" data-testid="new-token">
              {created}
            </div>
          </span>
        </div>
      )}
      <form
        className="row"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (name.trim() && scopes.length > 0) create.mutate();
        }}
      >
        <span className="grow">
          <input
            className="input"
            placeholder="Name, e.g. Claude"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Token name"
          />
          <div className="small" style={{ marginTop: 'var(--space-s)' }}>
            {Object.entries(SCOPE_LABELS).map(([s, label]) => (
              <label key={s} style={{ marginRight: 'var(--space-l)' }}>
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={(e) =>
                    setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))
                  }
                />{' '}
                {label}
              </label>
            ))}
          </div>
        </span>
        <button className="button tonal" type="submit" disabled={!name.trim() || scopes.length === 0}>
          Create
        </button>
      </form>
      {create.isError && <div className="row error">{create.error.message}</div>}
    </Section>
  );
}

function Password() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/v1/auth/change-password', { body: { current_password: current, new_password: next } }),
      ),
    onSuccess: () => {
      setDone(true);
      setCurrent('');
      setNext('');
    },
  });
  return (
    <Section header="Password" footer="Changing it signs out every other device.">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
      >
        <span className="grow">
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder="Current password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            aria-label="Current password"
          />
          <input
            className="input"
            style={{ marginTop: 'var(--space-s)' }}
            type="password"
            autoComplete="new-password"
            placeholder="New password (10+ characters)"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-label="New password"
          />
        </span>
        <button className="button tonal" type="submit" disabled={!current || next.length < 10}>
          Change
        </button>
      </form>
      {change.isError && <div className="row error">{change.error.message}</div>}
      {done && <div className="row secondary">Password changed.</div>}
    </Section>
  );
}

function Admin() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => unwrap(api.GET('/v1/admin/users')) });
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const invite = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/v1/admin/invites', { body: { email: email.trim(), role: 'member' } })),
    onSuccess: async (r) => {
      setLink({ email: email.trim(), url: r.url });
      setEmail('');
      await qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });
  const reset = useMutation({
    mutationFn: (u: { id: string; email: string }) =>
      unwrap(api.POST('/v1/admin/users/{id}/reset-link', { params: { path: { id: u.id } } })).then((r) => ({
        email: u.email,
        url: r.url,
      })),
    onSuccess: setLink,
  });
  return (
    <Section
      header="People on this server"
      footer="No email is sent: pass invite and reset links on yourself. They work once, for 24 hours."
    >
      {(users.data ?? []).map((u) => (
        <div className="row" key={u.id}>
          <span className="grow">
            <div className="name">{u.display_name ?? u.email}</div>
            <div className="secondary small">
              {u.role === 'admin' ? 'Admin' : 'Member'} ·{' '}
              {u.pending ? 'invited' : `last sign-in ${when(u.last_sign_in_at)}`}
            </div>
          </span>
          <button className="button plain" type="button" onClick={() => reset.mutate(u)}>
            {u.pending ? 'New link' : 'Reset link'}
          </button>
        </div>
      ))}
      {link && (
        <div className="row">
          <span className="grow">
            <div>Link for {link.email}:</div>
            <div className="token" data-testid="action-link">
              {link.url}
            </div>
          </span>
        </div>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) invite.mutate();
        }}
      >
        <input
          className="input"
          type="email"
          placeholder="Invite by email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Email to invite"
        />
        <button className="button tonal" type="submit" disabled={!email.trim()}>
          Invite
        </button>
      </form>
      {(invite.isError || reset.isError) && (
        <div className="row error">{(invite.error ?? reset.error)!.message}</div>
      )}
    </Section>
  );
}
