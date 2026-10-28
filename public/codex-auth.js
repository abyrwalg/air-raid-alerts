const elements = Object.fromEntries(
  [
    'provider',
    'status',
    'device',
    'code',
    'authorize',
    'expiry',
    'login',
    'cancel',
    'logout',
    'refresh',
  ].map((id) => [id, document.getElementById(id)]),
);
let csrfToken;
let busy = false;

async function request(endpoint, method = 'GET') {
  const response = await fetch(`/auth/codex/${endpoint}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: method === 'POST' ? { 'X-CSRF-Token': csrfToken } : {},
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}

function render(state) {
  const pending = state.status === 'pending';
  const connected = state.status === 'connected';
  elements.status.textContent =
    state.message ||
    {
      pending: 'Waiting for authorization…',
      connected: 'Connected to Codex with ChatGPT.',
      signed_out: 'Not signed in.',
      error: 'Sign-in failed. Please retry.',
    }[state.status] ||
    'Unknown connection status.';
  elements.device.hidden = !pending;
  elements.code.textContent = pending ? state.userCode : '';
  elements.authorize.removeAttribute('href');
  if (pending) {
    const url = new URL(state.verificationUrl);
    if (url.origin !== 'https://auth.openai.com')
      throw new Error('Unexpected authorization address.');
    elements.authorize.href = url.href;
  }
  elements.expiry.textContent = pending
    ? `Expires by ${new Date(state.expiresAt).toLocaleTimeString()}.`
    : '';
  elements.login.hidden = pending || connected;
  elements.login.textContent =
    state.status === 'error' ? 'Retry sign-in' : 'Sign in with ChatGPT';
  elements.login.disabled = !csrfToken;
  elements.cancel.hidden = !pending;
  elements.logout.hidden = !connected;
}

async function update(endpoint = 'status', method = 'GET') {
  if (busy) return;
  busy = true;
  for (const id of ['login', 'cancel', 'logout', 'refresh'])
    elements[id].disabled = true;
  try {
    render(await request(endpoint, method));
  } catch (error) {
    render({ status: 'error', message: error.message });
  } finally {
    busy = false;
    for (const id of ['login', 'cancel', 'logout', 'refresh'])
      elements[id].disabled = !csrfToken;
  }
}

elements.login.addEventListener('click', () => update('login', 'POST'));
elements.cancel.addEventListener('click', () => update('cancel', 'POST'));
elements.logout.addEventListener('click', () => update('logout', 'POST'));
elements.refresh.addEventListener('click', () => update());

async function initialize() {
  try {
    const session = await request('session');
    csrfToken = session.csrfToken;
    elements.provider.textContent = `Configured analysis provider: ${session.analysisProvider}. Triage: ${session.triageEnabled ? session.triageProvider : 'disabled'}.`;
    await update();
    setInterval(() => {
      if (!document.hidden) void update();
    }, 3000);
  } catch {
    elements.status.textContent =
      'Setup unavailable. Use this computer’s local address and reload.';
  }
}
void initialize();
