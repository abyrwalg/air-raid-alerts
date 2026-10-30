import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { synthesizeSpeech, unlink, getDevices } = vi.hoisted(() => ({
  synthesizeSpeech: vi.fn(),
  unlink: vi.fn(),
  getDevices: vi.fn(),
}));
vi.unmock('../tts.js');
vi.mock('../helpers/synthesizeSpeech.js', () => ({
  default: synthesizeSpeech,
}));
vi.mock('fs/promises', () => ({ default: { unlink } }));
vi.mock('naudiodon', () => ({ default: { getDevices } }));

describe('TTS queue failure recovery', () => {
  let textToSpeech;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    synthesizeSpeech.mockReset().mockResolvedValue(undefined);
    unlink.mockReset().mockResolvedValue(undefined);
    getDevices.mockReset().mockReturnValue([]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    ({ default: textToSpeech } = await import('../tts.js'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips playback and cleans up after a rejected synthesis', async () => {
    synthesizeSpeech.mockRejectedValue(
      Object.assign(new Error('private request text and token'), {
        httpStatus: 403,
      }),
    );
    await expect(textToSpeech('private speech text')).resolves.toBeUndefined();
    expect(getDevices).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledExactlyOnceWith(
      synthesizeSpeech.mock.calls[0][1],
    );
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      'TTS synthesis failed; announcement skipped.',
      expect.objectContaining({ httpStatus: 403, timedOut: false }),
    );
    expect(JSON.stringify(console.error.mock.calls)).not.toMatch(
      /private|token/,
    );
  });

  it('continues with a later queued announcement after a failed job', async () => {
    synthesizeSpeech.mockRejectedValueOnce(
      Object.assign(new Error('test'), { httpStatus: 403 }),
    );
    const first = textToSpeech('first');
    const second = textToSpeech('second');
    await Promise.all([first, second]);
    expect(synthesizeSpeech.mock.calls.map(([text]) => text)).toEqual([
      'first',
      'second',
    ]);
    expect(getDevices).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(synthesizeSpeech.mock.calls[0][1]).not.toBe(
      synthesizeSpeech.mock.calls[1][1],
    );
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('does not start the next synthesis until the previous one has settled', async () => {
    let failFirst;
    synthesizeSpeech.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          failFirst = reject;
        }),
    );
    const first = textToSpeech('first');
    const second = textToSpeech('second');
    await Promise.resolve();
    expect(synthesizeSpeech).toHaveBeenCalledOnce();
    failFirst(Object.assign(new Error('test'), { code: 'TTS_TIMEOUT' }));
    await Promise.all([first, second]);
    expect(synthesizeSpeech).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      'TTS synthesis failed; announcement skipped.',
      expect.objectContaining({ timedOut: true }),
    );
  });

  it('ignores missing temporary output after an early connection failure', async () => {
    synthesizeSpeech.mockRejectedValue(new Error('test'));
    unlink.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    await expect(textToSpeech('test')).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('identifies playback errors separately from synthesis errors', async () => {
    getDevices.mockImplementation(() => {
      throw new Error('device unavailable');
    });
    await expect(textToSpeech('test')).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      'TTS playback failed; announcement skipped. Check the audio device and FFmpeg.',
    );
    expect(unlink).toHaveBeenCalledOnce();
  });
});
