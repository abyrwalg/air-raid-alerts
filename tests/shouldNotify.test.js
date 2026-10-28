import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { post, envConfig, audioImported } = vi.hoisted(() => ({
  post: vi.fn(),
  envConfig: vi.fn(),
  audioImported: vi.fn(),
}));
vi.mock('axios', () => ({ default: { post } }));
vi.mock('dotenv', () => ({ default: { config: envConfig } }));
vi.mock('../tts.js', () => {
  audioImported();
  return { default: vi.fn() };
});
import { shouldNotify } from '../helpers/shouldNotify.js';

describe('pure notification policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('HA_LOGS_WEBHOOK_URL', 'https://logs.invalid/webhook');
    vi.stubEnv('HA_WEBHOOK_URL', 'https://alerts.invalid/webhook');
  });
  afterEach(() => {
    expect(post).not.toHaveBeenCalled();
    expect(envConfig).not.toHaveBeenCalled();
    expect(audioImported).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it.each([
    undefined,
    null,
    { relevant: false },
    { relevant: true, risk_level: 'none' },
    { relevant: true, risk_level: 'low' },
    { relevant: true, risk_level: 'unknown' },
  ])(
    'rejects irrelevant, low-risk, or unsupported analyses without effects',
    (analysis) => {
      expect(shouldNotify(analysis)).toBe(false);
    },
  );

  it('allows high risk regardless of time, without sending anything', () => {
    expect(
      shouldNotify(
        { relevant: true, risk_level: 'high' },
        new Date('2025-02-01T23:30:00'),
      ),
    ).toBe(true);
  });

  it.each([
    ['07:59', false],
    ['08:00', true],
    ['09:00', true],
    ['21:59', true],
    ['22:00', false],
    ['23:30', false],
  ])('evaluates medium risk at %s without effects', (time, expected) => {
    expect(
      shouldNotify(
        { relevant: true, risk_level: 'medium' },
        new Date(`2025-02-01T${time}:00`),
      ),
    ).toBe(expected);
  });
});
