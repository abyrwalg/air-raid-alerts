// Standalone handshake probe: no dotenv, application startup, text, or audio.
// Only allowlisted metadata is logged; never log URLs, tokens, or raw errors.
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const entry = require.resolve('node-edge-tts');
const ttsRequire = createRequire(entry);
const { WebSocket } = ttsRequire('ws');
const drm = ttsRequire('./drm');
const { version } = require(
  path.join(path.dirname(entry), '..', 'package.json'),
);
const useV2 = typeof drm.generateSecMsGecToken_V2 === 'function';
const endpoint = useV2
  ? 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1'
  : 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const url = new URL(endpoint);
url.searchParams.set(
  useV2 ? 'Ocp-Apim-Subscription-Key' : 'TrustedClientToken',
  drm.TRUSTED_CLIENT_TOKEN,
);
url.searchParams.set(
  'Sec-MS-GEC',
  useV2 ? drm.generateSecMsGecToken_V2() : drm.generateSecMsGecToken(),
);
url.searchParams.set(
  'Sec-MS-GEC-Version',
  useV2 ? drm.SEC_MS_GEC_VERSION_V2 : `1-${drm.CHROMIUM_FULL_VERSION}`,
);

console.log('[tts-diagnostic] Starting handshake', {
  dependencyVersion: version,
  endpoint,
  protocol: useV2 ? 'v2' : 'v1',
  localTime: new Date().toISOString(),
});

const major = useV2 ? drm.CHROMIUM_FULL_VERSION.split('.')[0] : '140';
const headers = {
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
};
if (useV2)
  Object.assign(headers, {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
  });

const socket = new WebSocket(url, {
  host: 'speech.platform.bing.com',
  origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  headers,
  handshakeTimeout: 15000,
});
let rejected = false;
socket.on('unexpected-response', (request, response) => {
  rejected = true;
  process.exitCode = 1;
  const serverTime = Date.parse(response.headers.date);
  console.error('[tts-diagnostic] Handshake rejected', {
    status: response.statusCode,
    serverTime: Number.isFinite(serverTime)
      ? new Date(serverTime).toISOString()
      : null,
    clockSkewSeconds: Number.isFinite(serverTime)
      ? Math.round((Date.now() - serverTime) / 1000)
      : null,
  });
  response.resume();
  // Handling unexpected-response disables ws's default abort behavior.
  socket.terminate();
});
socket.on('error', () => {
  process.exitCode = 1;
  if (!rejected)
    console.error(
      '[tts-diagnostic] Connection failed before upgrade; check DNS, TLS, firewall, and connectivity.',
    );
});
socket.on('open', () => {
  console.log('[tts-diagnostic] WebSocket upgrade accepted (HTTP 101).');
  socket.close();
});
