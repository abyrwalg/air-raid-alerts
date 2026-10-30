import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { evaluateMessage, notify } = vi.hoisted(() => ({
  evaluateMessage: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../openai.js', () => ({ evaluateMessage }));
vi.mock('../notify.js', () => ({ default: notify }));

import processMessage from '../helpers/processMessage.js';

const analysis = { relevant: true, risk_level: 'high' };

describe('Telegram message source attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    evaluateMessage.mockResolvedValue({
      triage: { status: 'disabled' },
      analysis,
    });
    notify.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['realtime', 'poll'])(
    'labels %s reports with their channel username and preserves the body',
    async (source) => {
      const text = 'Сміла уважно\nРакета на місто!';
      await processMessage(
        { message: text },
        { name: 'threat_updates' },
        source,
      );

      expect(evaluateMessage).toHaveBeenCalledExactlyOnceWith(
        `Telegram channel: @threat_updates\n\n${text}`,
      );
      expect(notify).toHaveBeenCalledExactlyOnceWith(analysis);
    },
  );

  it('does not duplicate an existing @ prefix', async () => {
    await processMessage(
      { message: 'Сміла уважно' },
      { name: '@threat_updates' },
      'realtime',
    );

    expect(evaluateMessage).toHaveBeenCalledExactlyOnceWith(
      'Telegram channel: @threat_updates\n\nСміла уважно',
    );
  });

  it('does not let the channel name satisfy the inclusion filter', async () => {
    await processMessage(
      { message: 'Звичайне повідомлення' },
      { name: 'Сміла' },
      'realtime',
    );

    expect(evaluateMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not let the channel name trigger the exclusion filter', async () => {
    await processMessage(
      { message: 'Сміла уважно' },
      { name: 'Київ' },
      'realtime',
    );

    expect(evaluateMessage).toHaveBeenCalledExactlyOnceWith(
      'Telegram channel: @Київ\n\nСміла уважно',
    );
    expect(notify).toHaveBeenCalledExactlyOnceWith(analysis);
  });

  it('still skips excluded report bodies', async () => {
    await processMessage(
      { message: 'Сміла Київ' },
      { name: 'threat_updates' },
      'realtime',
    );

    expect(evaluateMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('still skips messages with no text', async () => {
    await processMessage({}, { name: 'threat_updates' }, 'realtime');

    expect(evaluateMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not notify when triage rejects an attributed report', async () => {
    evaluateMessage.mockResolvedValue({
      triage: { status: 'rejected' },
      analysis: null,
    });
    await processMessage(
      { message: 'Сміла уважно' },
      { name: 'threat_updates' },
      'realtime',
    );

    expect(evaluateMessage).toHaveBeenCalledExactlyOnceWith(
      'Telegram channel: @threat_updates\n\nСміла уважно',
    );
    expect(notify).not.toHaveBeenCalled();
  });
});
