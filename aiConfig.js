import dotenv from 'dotenv';
import path from 'node:path';
import { triageThreshold, triageTimeoutMs } from './config.js';

dotenv.config({ path: '.env.local', quiet: true });

// These are migration hints, not aliases. Reject even blank removed settings so
// an old local file cannot silently change providers, models, or thresholds.
export const removedAISettings = {
  AI_PROVIDER: 'ANALYSIS_PROVIDER',
  OPENAI_MODEL: 'ANALYSIS_MODEL',
  CODEX_MODEL: 'ANALYSIS_MODEL',
  CODEX_TIMEOUT_MS: 'ANALYSIS_TIMEOUT_MS',
  ENABLE_OPENAI_TRIAGE: 'TRIAGE_ENABLED',
  OPENAI_TRIAGE_MODEL: 'TRIAGE_MODEL',
  CODEX_TRIAGE_MODEL: 'TRIAGE_MODEL',
  OPENAI_TRIAGE_THRESHOLD: 'TRIAGE_THRESHOLD',
  OPENAI_TRIAGE_TIMEOUT_MS: 'TRIAGE_TIMEOUT_MS',
  CODEX_TRIAGE_TIMEOUT_MS: 'TRIAGE_TIMEOUT_MS',
};

function boolean(env, name, fallback) {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${name} must be true or false.`);
  }
  return value === 'true';
}

function number(env, name, fallback, min, max, integer = false) {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(
      `${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`,
    );
  }
  return value;
}

function provider(env, name) {
  const value = env[name]?.trim().toLowerCase() || 'openai';
  if (!['openai', 'codex'].includes(value)) {
    throw new Error(`${name} must be openai or codex.`);
  }
  return value;
}

export function getAIConfig(env = process.env) {
  const removed = Object.entries(removedAISettings).filter(
    ([name]) => env[name] !== undefined,
  );
  if (removed.length) {
    throw new Error(
      `Removed AI settings: ${removed.map(([oldName, newName]) => `${oldName} -> ${newName}`).join(', ')}. Update .env.local and remove the old names; legacy aliases are not supported.`,
    );
  }
  const analysisProvider = provider(env, 'ANALYSIS_PROVIDER');
  const triageProvider = provider(env, 'TRIAGE_PROVIDER');
  const triageEnabled = boolean(env, 'TRIAGE_ENABLED', false);
  return {
    analysisProvider,
    analysisModel:
      env.ANALYSIS_MODEL?.trim() ||
      (analysisProvider === 'openai' ? 'gpt-6-luna' : null),
    analysisTimeoutMs: number(
      env,
      'ANALYSIS_TIMEOUT_MS',
      analysisProvider === 'openai' ? 600000 : 120000,
      1,
      2147483647,
      true,
    ),
    triageEnabled,
    triageProvider,
    triageModel:
      env.TRIAGE_MODEL?.trim() ||
      (triageProvider === 'openai' ? 'gpt-6-luna' : null),
    triageThreshold: number(env, 'TRIAGE_THRESHOLD', triageThreshold, 0, 1),
    triageTimeoutMs: number(
      env,
      'TRIAGE_TIMEOUT_MS',
      triageProvider === 'openai' ? triageTimeoutMs : 120000,
      1,
      2147483647,
      true,
    ),
    apiKey: env.OPENAI_API_KEY?.trim() || '',
    codexLoginTimeoutMs: number(
      env,
      'CODEX_LOGIN_TIMEOUT_MS',
      600000,
      1000,
      900000,
      true,
    ),
    codexAuthEnabled: boolean(
      env,
      'ENABLE_CODEX_AUTH_UI',
      analysisProvider === 'codex' ||
        (triageEnabled && triageProvider === 'codex'),
    ),
    codexHome: path.resolve(env.CODEX_HOME_DIR?.trim() || '.codex-alerts'),
  };
}

export function validateAICredentials(config) {
  if (
    (config.analysisProvider === 'openai' ||
      (config.triageEnabled && config.triageProvider === 'openai')) &&
    !config.apiKey
  ) {
    throw new Error(
      'OPENAI_API_KEY is required for OpenAI analysis or enabled Decisions API triage.',
    );
  }
}
