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
