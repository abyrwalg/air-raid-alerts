import { beforeEach, describe, expect, it, vi } from 'vitest';

const { EdgeTTS, ttsPromise, postMessage } = vi.hoisted(() => ({
  EdgeTTS: vi.fn(),
  ttsPromise: vi.fn(),
  postMessage: vi.fn(),
}));
vi.mock('node-edge-tts', () => ({ EdgeTTS }));
vi.mock('node:worker_threads', () => ({
  workerData: { text: 'synthetic text', outputPath: 'synthetic.mp3' },
  parentPort: { postMessage },
}));

describe('speech worker entry point', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    EdgeTTS.mockImplementation(function () {
      this.ttsPromise = ttsPromise;
    });
    ttsPromise.mockReset().mockResolvedValue(undefined);
  });

  it('preserves speech settings and reports completion after synthesis', async () => {
    await import('../ttsWorker.js');
    expect(EdgeTTS).toHaveBeenCalledExactlyOnceWith({
      voice: 'ru-RU-SvetlanaNeural',
      lang: 'ru-RU',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    });
    expect(ttsPromise).toHaveBeenCalledExactlyOnceWith(
      'synthetic text',
      'synthetic.mp3',
    );
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'complete' });
  });

  it('does not signal completion when synthesis fails', async () => {
    ttsPromise.mockRejectedValue(new Error('test synthesis failure'));
    await expect(import('../ttsWorker.js')).rejects.toThrow(
      'test synthesis failure',
    );
    expect(postMessage).not.toHaveBeenCalled();
  });
});
