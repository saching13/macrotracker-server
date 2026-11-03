// The OAuth consent page: shows which app asks for what, takes the person's
// password, and sends them back to the app with a code (or a refusal).
const $ = (id) => document.getElementById(id);
const query = Object.fromEntries(new URLSearchParams(location.search));

function fail(message) {
  const e = $('error');
  e.textContent = message;
  e.hidden = false;
}

async function decide(approve) {
  $('approve').disabled = true;
  $('deny').disabled = true;
  try {
    const res = await fetch('/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        approve,
        ...(approve ? { email: $('email').value.trim(), password: $('password').value } : {}),
      }),
    });
    const body = await res.json();
    if (res.ok && body.redirect) {
      location.assign(body.redirect);
      return;
    }
    fail(body.error_description ?? 'Something went wrong.');
  } catch {
    fail('Can’t reach the server.');
  }
  $('approve').disabled = false;
  $('deny').disabled = false;
}

async function load() {
  const res = await fetch(`/oauth/authorize/info?${new URLSearchParams(query)}`);
  const info = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('title').textContent = 'This link doesn’t work';
    $('lead').textContent = info.error_description ?? 'The app sent an invalid request.';
    return;
  }
  $('title').textContent = `Allow ${info.client_name}?`;
  $('lead').textContent =
    `${info.client_name} (${info.redirect_host}) wants to use your MacroTracker account. It will be able to:`;
  for (const s of info.scopes) {
    const li = document.createElement('li');
    li.textContent = s.text;
    $('scopes').append(li);
  }
  $('form').hidden = false;
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    decide(true);
  });
  $('deny').addEventListener('click', () => decide(false));
  $('email').focus();
}

load();
