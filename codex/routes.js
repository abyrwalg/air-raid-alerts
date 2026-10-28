import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getAIConfig } from '../aiConfig.js';
import { getCodexService } from './service.js';

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function localAuthGuard(req, res, next) {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  });
  let host;
  try {
    host = new URL(`http://${req.headers.host}`);
  } catch {
    /* reject */
  }
  const fetchSite = req.get('Sec-Fetch-Site');
  if (
    !loopback.has(req.socket.remoteAddress) ||
    !host ||
    host.host !== req.headers.host ||
    !localHosts.has(host.hostname) ||
    host.port !== String(req.socket.localPort) ||
    (fetchSite && !['same-origin', 'none'].includes(fetchSite))
  ) {
    return res.status(403).json({
      error:
        'Codex setup is available only from this computer using its local address.',
    });
  }
  const origin = req.get('Origin');
  if (
    (origin && origin !== host.origin) ||
    (req.method !== 'GET' && origin !== host.origin)
  ) {
    return res.status(403).json({ error: 'Same-origin access is required.' });
  }
  next();
}

export function createCodexRouter({
  config = getAIConfig,
  service = getCodexService,
} = {}) {
  const router = express.Router();
  // This token stays in memory and is readable only through the guarded local
  // page. Together with Origin/Host checks it prevents cross-site mutations.
  const csrfToken = randomBytes(32).toString('hex');
  router.use((req, res, next) => {
    if (!config().codexAuthEnabled) return res.sendStatus(404);
    next();
  });
  router.use(localAuthGuard);
  router.use((req, res, next) => {
    if (req.method === 'GET') return next();
    const token = req.get('X-CSRF-Token') || '';
    const expected = Buffer.from(csrfToken);
    const actual = Buffer.from(token);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return res
        .status(403)
        .json({ error: 'Invalid setup token. Reload the setup page.' });
    }
    next();
  });
  const publicFile = (name) =>
    fileURLToPath(new URL(`../public/${name}`, import.meta.url));
  router.get('/', (req, res) => res.sendFile(publicFile('codex.html')));
  router.get('/app.js', (req, res) =>
    res.sendFile(publicFile('codex-auth.js')),
  );
  router.get('/style.css', (req, res) =>
    res.sendFile(publicFile('codex-auth.css')),
  );
  router.get('/session', (req, res) => {
    const { analysisProvider, triageProvider, triageEnabled } = config();
    res.json({ csrfToken, analysisProvider, triageProvider, triageEnabled });
  });
  const action = (method) => async (req, res) => {
    try {
      res.json(await service()[method]());
    } catch {
      // No raw errors, credentials, account details, or subprocess output.
      res.status(503).json({
        error:
          'Codex is unavailable. Check your connection, retry sign-in, and ensure device-code authorization is enabled in ChatGPT settings.',
      });
    }
  };
  router.get('/status', action('status'));
  router.post('/login', action('startLogin'));
  router.post('/cancel', action('cancelLogin'));
  router.post('/logout', action('logout'));
  return router;
}
