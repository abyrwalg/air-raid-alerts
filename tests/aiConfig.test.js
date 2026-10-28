import { describe, expect, it, vi } from 'vitest';
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
import {
  getAIConfig,
  validateAICredentials,
  removedAISettings,
} from '../aiConfig.js';
import { codexEnvironment, codexOverrides } from '../codex/client.js';
import { parseAnalysis } from '../providers/validateAnalysis.js';

describe('stage-based AI configuration', () => {
  it('resolves independent OpenAI defaults with triage disabled', () => {
    expect(getAIConfig({})).toMatchObject({
      analysisProvider: 'openai',
      analysisModel: 'gpt-6-luna',
      analysisTimeoutMs: 600000,
      triageProvider: 'openai',
      triageEnabled: false,
      triageModel: 'gpt-6-luna',
      triageThreshold: 0.5,
      triageTimeoutMs: 8000,
      codexAuthEnabled: false,
    });
  });

  it.each([
    ['openai', 'openai'],
    ['openai', 'codex'],
    ['codex', 'openai'],
    ['codex', 'codex'],
  ])(
    'configures %s analysis and %s triage independently',
    (analysis, triage) => {
      const config = getAIConfig({
        ANALYSIS_PROVIDER: analysis,
        ANALYSIS_MODEL: 'analysis-model',
        ANALYSIS_TIMEOUT_MS: '42000',
        TRIAGE_ENABLED: 'true',
        TRIAGE_PROVIDER: triage,
        TRIAGE_MODEL: 'triage-model',
        TRIAGE_TIMEOUT_MS: '9000',
        TRIAGE_THRESHOLD: '0.7',
      });
      expect(config).toMatchObject({
        analysisProvider: analysis,
        analysisModel: 'analysis-model',
        analysisTimeoutMs: 42000,
        triageEnabled: true,
        triageProvider: triage,
        triageModel: 'triage-model',
        triageTimeoutMs: 9000,
        triageThreshold: 0.7,
      });
      if (analysis === 'openai' || triage === 'openai') {
        expect(() => validateAICredentials(config)).toThrow('OPENAI_API_KEY');
      } else {
        expect(() => validateAICredentials(config)).not.toThrow();
      }
    },
  );

  it('never inherits the analysis model or timeout for Codex triage', () => {
    expect(
      getAIConfig({
        ANALYSIS_PROVIDER: 'codex',
        ANALYSIS_MODEL: 'analysis-model',
        ANALYSIS_TIMEOUT_MS: '42000',
        TRIAGE_PROVIDER: 'codex',
        TRIAGE_MODEL: ' ',
        TRIAGE_TIMEOUT_MS: '',
      }),
    ).toMatchObject({
      analysisModel: 'analysis-model',
      analysisTimeoutMs: 42000,
      triageModel: null,
      triageTimeoutMs: 120000,
    });
  });

  it('never inherits triage settings into analysis', () => {
    expect(
      getAIConfig({
        ANALYSIS_PROVIDER: 'codex',
        TRIAGE_PROVIDER: 'codex',
        TRIAGE_MODEL: 'triage-model',
        TRIAGE_TIMEOUT_MS: '9000',
      }),
    ).toMatchObject({
      analysisModel: null,
      analysisTimeoutMs: 120000,
      triageModel: 'triage-model',
      triageTimeoutMs: 9000,
    });
  });

  it('requires credentials only for enabled OpenAI stages and enables Codex setup as needed', () => {
    const codex = getAIConfig({ ANALYSIS_PROVIDER: ' CODEX ' });
    expect(() => validateAICredentials(codex)).not.toThrow();
    expect(codex.codexAuthEnabled).toBe(true);
    expect(() =>
      validateAICredentials({ ...codex, triageEnabled: true }),
    ).toThrow('OPENAI_API_KEY');
    expect(() =>
      validateAICredentials({
        ...codex,
        triageEnabled: true,
        triageProvider: 'codex',
      }),
    ).not.toThrow();
    const mixed = getAIConfig({
      ANALYSIS_PROVIDER: 'openai',
      TRIAGE_ENABLED: 'true',
      TRIAGE_PROVIDER: 'codex',
    });
    expect(mixed.codexAuthEnabled).toBe(true);
    expect(() =>
      validateAICredentials({ ...mixed, apiKey: 'analysis-key' }),
    ).not.toThrow();
    expect(getAIConfig({ TRIAGE_PROVIDER: 'codex' }).codexAuthEnabled).toBe(
      false,
    );
    expect(
      getAIConfig({ ANALYSIS_PROVIDER: 'codex', ENABLE_CODEX_AUTH_UI: 'false' })
        .codexAuthEnabled,
    ).toBe(false);
  });

  it.each([
    ['ANALYSIS_PROVIDER', 'other'],
    ['TRIAGE_PROVIDER', 'other'],
    ['TRIAGE_ENABLED', 'yes'],
    ['ENABLE_CODEX_AUTH_UI', '1'],
    ['TRIAGE_THRESHOLD', '-1'],
    ['TRIAGE_THRESHOLD', '1.1'],
    ['TRIAGE_TIMEOUT_MS', 'NaN'],
    ['ANALYSIS_TIMEOUT_MS', '0'],
    ['ANALYSIS_TIMEOUT_MS', '1.5'],
    ['TRIAGE_TIMEOUT_MS', '0'],
    ['TRIAGE_TIMEOUT_MS', 'Infinity'],
    ['CODEX_LOGIN_TIMEOUT_MS', '1000000'],
  ])('rejects invalid %s', (name, value) => {
    expect(() => getAIConfig({ [name]: value })).toThrow(name);
  });

  it.each(Object.entries(removedAISettings))(
    'rejects removed %s and identifies its replacement',
    (oldName, newName) => {
      expect(() =>
        getAIConfig({ [oldName]: 'private-value', [newName]: 'also-set' }),
      ).toThrow(`${oldName} -> ${newName}`);
      expect(() => getAIConfig({ [oldName]: '' })).toThrow(oldName);
      try {
        getAIConfig({ [oldName]: 'private-value' });
      } catch (error) {
        expect(error.message).not.toContain('private-value');
      }
    },
  );

  it('isolates Codex from API keys, application secrets and runtime overrides', () => {
    expect(
      codexEnvironment('/app/auth', {
        PATH: 'bin',
        USERPROFILE: 'profile',
        OPENAI_API_KEY: 'triage-key',
        CODEX_API_KEY: 'other-key',
        TG_SESSION: 'secret',
        CODEX_HOME: 'other-home',
        NODE_OPTIONS: '--require unsafe',
        OPENAI_BASE_URL: 'https://example.com',
      }),
    ).toEqual({ PATH: 'bin', USERPROFILE: 'profile', CODEX_HOME: '/app/auth' });
    expect(codexOverrides).toMatchObject({
      forced_login_method: 'chatgpt',
      approval_policy: 'never',
      sandbox_mode: 'read-only',
      web_search: 'disabled',
      'features.shell_tool': false,
      'features.unified_exec': false,
    });
  });
});

describe('analysis validation', () => {
  const valid = {
    relevant: true,
    risk_level: 'medium',
    threat_type: 'drone',
    location_match: [],
    trajectory_threat: false,
    reason: 'test',
    summary: 'test',
    language: 'ru',
  };
  it('accepts the existing schema', () =>
    expect(parseAnalysis(JSON.stringify(valid))).toEqual(valid));
  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...valid, relevant: 'true' }),
    JSON.stringify({ ...valid, risk_level: 'critical' }),
    JSON.stringify({ ...valid, location_match: [5] }),
    JSON.stringify({ ...valid, extra: 'data' }),
  ])('rejects malformed or schema-invalid output', (content) => {
    expect(() => parseAnalysis(content)).toThrow('Analysis provider');
  });
});
