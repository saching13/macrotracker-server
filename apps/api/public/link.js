// Redeems an invite or reset link. The token arrives in the URL fragment, so
// it is never sent to the server in a request line or logged.
const params = new URLSearchParams(location.hash.slice(1));
const type = params.get('type');
const tokenHash = params.get('token_hash');
history.replaceState(null, '', location.pathname);

const $ = (id) => document.getElementById(id);

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

document.addEventListener('DOMContentLoaded', () => {
  $('server').textContent = location.origin;
  if (type === 'recovery') {
    $('title').textContent = 'Reset your password';
    $('lead').textContent =
      'Choose a new password. Every device signed in to your account will be signed out.';
  }
  if (!tokenHash || (type !== 'invite' && type !== 'recovery')) {
    $('form').hidden = true;
    showError('This link is incomplete. Ask the server admin for a new one.');
    return;
  }

  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('error').hidden = true;
    const password = $('password').value;
    if (password.length < 10) return showError('Use at least 10 characters.');
    if (password !== $('confirm').value) return showError('The passwords do not match.');

    $('submit').disabled = true;
    try {
      const res = await fetch('/v1/auth/complete-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type,
          token_hash: tokenHash,
          password,
          device: { name: 'Web browser', platform: 'web' },
          client: 'web',
        }),
      });
      if (res.ok) {
        $('form').hidden = true;
        $('lead').hidden = true;
        $('done').hidden = false;
        return;
      }
      const body = await res.json().catch(() => null);
      const code = body?.error?.code;
      if (code === 'link_invalid')
        showError('This link has expired or was already used. Ask the admin for a new one.');
      else if (code === 'weak_password' || code === 'validation_error')
        showError('Choose a longer, less common password.');
      else showError(body?.error?.message ?? 'Something went wrong. Try again.');
    } catch {
      showError('Could not reach the server. Check your connection and try again.');
    } finally {
      $('submit').disabled = false;
    }
  });
});
