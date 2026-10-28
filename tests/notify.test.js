import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { axiosPost, audioImported, defaultAudio } = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  audioImported: vi.fn(),
  defaultAudio: vi.fn(),
}));
vi.mock('axios', () => ({ default: { post: axiosPost } }));
vi.mock('../tts.js', () => {
  audioImported();
  return { default: defaultAudio };
});
import defaultNotify, { createNotifier, shouldNotify } from '../notify.js';

describe('runtime notification delivery with mocked effects', () => {
  let post;
  let audio;
  let logger;
  let config;
  let notify;
  const high = { relevant: true, risk_level: 'high', summary: 'Test warning' };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-01T09:00:00'));
    post = vi.fn().mockResolvedValue({});
    audio = vi.fn().mockResolvedValue(undefined);
    logger = { warn: vi.fn(), error: vi.fn() };
    config = {
      webhookUrl: 'https://alerts.invalid/webhook',
      logsWebhookUrl: 'https://logs.invalid/webhook',
    };
    notify = createNotifier({
      post,
      textToSpeech: audio,
      getConfig: () => config,
      logger,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('imports the compatibility decision export without environment or audio initialization', () => {
    expect(shouldNotify(high)).toBe(true);
    expect(audioImported).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('sends an analysis log, alert webhook, and audio once for a qualifying report', async () => {
    await notify(high);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith(config.logsWebhookUrl, {
      text: JSON.stringify(high, null, 2),
    });
    expect(post).toHaveBeenCalledWith(config.webhookUrl, {
      risk_level: 'High',
      text: high.summary,
    });
    expect(audio).toHaveBeenCalledExactlyOnceWith(high.summary);
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it.each([
    { relevant: false, risk_level: 'none' },
    { relevant: true, risk_level: 'none' },
    { relevant: true, risk_level: 'low' },
  ])(
    'preserves analysis logging for skipped reports without alerting or audio',
    async (analysis) => {
      await notify(analysis);
      expect(post).toHaveBeenCalledExactlyOnceWith(config.logsWebhookUrl, {
        text: JSON.stringify(analysis, null, 2),
      });
      expect(audio).not.toHaveBeenCalled();
      expect(audioImported).not.toHaveBeenCalled();
    },
  );

  it('logs medium risk outside the allowed time without an alert', async () => {
    vi.setSystemTime(new Date('2025-02-01T23:30:00'));
    await notify({ ...high, risk_level: 'medium' });
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0][0]).toBe(config.logsWebhookUrl);
    expect(audio).not.toHaveBeenCalled();
  });

  it.each([undefined, null])(
    'does nothing for absent analysis',
    async (analysis) => {
      await notify(analysis);
      expect(post).not.toHaveBeenCalled();
      expect(audio).not.toHaveBeenCalled();
    },
  );

  it('respects independently absent alert and log webhook settings', async () => {
    config.logsWebhookUrl = '';
    await notify(high);
    expect(post).toHaveBeenCalledExactlyOnceWith(config.webhookUrl, {
      risk_level: 'High',
      text: high.summary,
    });
    post.mockClear();
    config.webhookUrl = '';
    await notify(high);
    expect(post).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(audio).toHaveBeenCalledTimes(2);
  });

  it('does not suppress alerts when best-effort analysis logging fails', async () => {
    post.mockImplementation((url) =>
      url === config.logsWebhookUrl
        ? Promise.reject(new Error('private webhook credentials'))
        : Promise.resolve({}),
    );
    await notify(high);
    await Promise.resolve();
    expect(audio).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(config.webhookUrl, expect.anything());
    expect(logger.error).toHaveBeenCalledWith('Error triggering logs webhook.');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'private webhook credentials',
    );
  });

  it('does not wait for the logs webhook before completing alert delivery', async () => {
    post.mockImplementation((url) =>
      url === config.logsWebhookUrl
        ? new Promise(() => {})
        : Promise.resolve({}),
    );
    await notify(high);
    expect(audio).toHaveBeenCalledOnce();
  });

  it('handles notification delivery failures without exposing request secrets', async () => {
    audio.mockRejectedValue(new Error('private request data'));
    await expect(notify(high)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'Error triggering notification webhook or audio.',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'private request data',
    );
  });

  it('uses synthetic runtime configuration and imports audio only when a real alert is requested', async () => {
    vi.stubEnv('HA_WEBHOOK_URL', 'https://alerts.invalid/default');
    vi.stubEnv('HA_LOGS_WEBHOOK_URL', 'https://logs.invalid/default');
    axiosPost.mockResolvedValue({});
    await defaultNotify({ relevant: true, risk_level: 'low' });
    expect(axiosPost).toHaveBeenCalledOnce();
    expect(audioImported).not.toHaveBeenCalled();
    await defaultNotify(high);
    expect(axiosPost).toHaveBeenCalledTimes(3);
    expect(defaultAudio).toHaveBeenCalledExactlyOnceWith(high.summary);
    expect(audioImported).toHaveBeenCalledOnce();
  });
});
