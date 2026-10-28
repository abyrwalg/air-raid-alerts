import { afterEach, beforeEach, vi } from 'vitest';
import nock from 'nock';

// Unit tests may parse synthetic env text, but must never load local files.
vi.mock('dotenv', async (importOriginal) => {
  const actual = await importOriginal();
  const config = vi.fn(() => ({ parsed: {} }));
  return {
    ...actual,
    config,
    configDotenv: config,
    default: { ...actual.default, config, configDotenv: config },
  };
});
vi.mock('dotenv/config', () => ({}));

// Real effects require an explicit per-test mock, never the user's devices or
// Codex process. Tests of the transport inject their own fake spawn function.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const blocked = () => {
    throw new Error('Real child processes are disabled in automated tests.');
  };
  const overrides = Object.fromEntries(
    [
      'spawn',
      'spawnSync',
      'exec',
      'execSync',
      'execFile',
      'execFileSync',
      'fork',
    ].map((name) => [name, blocked]),
  );
  return {
    ...actual,
    ...overrides,
    default: { ...actual.default, ...overrides },
  };
});
vi.mock('open', () => ({
  default: () => {
    throw new Error('Real browser launches are disabled in automated tests.');
  },
}));
vi.mock('../tts.js', () => ({
  default: () => {
    throw new Error('Real audio is disabled in automated tests.');
  },
}));
vi.mock('../db.js', () => {
  throw new Error(
    'Real persistence is disabled in automated tests; provide an explicit database mock.',
  );
});

const applicationEnvNames = [
  'ANALYSIS_PROVIDER',
  'ANALYSIS_MODEL',
  'ANALYSIS_TIMEOUT_MS',
  'TRIAGE_ENABLED',
  'TRIAGE_PROVIDER',
  'TRIAGE_MODEL',
  'TRIAGE_THRESHOLD',
  'TRIAGE_TIMEOUT_MS',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'ENABLE_CODEX_AUTH_UI',
  'CODEX_LOGIN_TIMEOUT_MS',
  'CODEX_HOME_DIR',
  'CODEX_HOME',
  'HA_WEBHOOK_URL',
  'HA_LOGS_WEBHOOK_URL',
  'TG_API_ID',
  'TG_API_HASH',
  'TG_CHANNELS',
  'TG_SESSION',
  'ENABLE_TELEGRAM',
  'ENABLE_CHANNEL_POLLING',
  'PORT',
  'AI_PROVIDER',
  'OPENAI_MODEL',
  'CODEX_MODEL',
  'CODEX_TIMEOUT_MS',
  'ENABLE_OPENAI_TRIAGE',
  'OPENAI_TRIAGE_MODEL',
  'CODEX_TRIAGE_MODEL',
  'OPENAI_TRIAGE_THRESHOLD',
  'OPENAI_TRIAGE_TIMEOUT_MS',
  'CODEX_TRIAGE_TIMEOUT_MS',
  'AI_LOGS_ENABLED',
  'AI_LOG_RETENTION_DAYS',
  'AI_LOGS_PATH',
];
function clearApplicationEnv() {
  for (const name of applicationEnvNames) delete process.env[name];
}

export function isLoopbackAuthority(authority) {
  try {
    const { hostname } = new URL(`http://${authority}`);
    return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

function restrictNetwork() {
  // Nock 14 covers node:http, node:https, Axios, and native fetch. Only actual
  // loopback test servers may receive unmocked HTTP requests.
  nock.disableNetConnect();
  nock.enableNetConnect(isLoopbackAuthority);
}

clearApplicationEnv();
restrictNetwork();
beforeEach(() => {
  clearApplicationEnv();
  restrictNetwork();
});
afterEach(() => {
  nock.cleanAll();
});
