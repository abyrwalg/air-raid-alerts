import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import synthesizeSpeech from '../helpers/synthesizeSpeech.js';

describe('isolated speech synthesis', () => {
  let worker;
  let createWorker;

  beforeEach(() => {
    vi.useFakeTimers();
    worker = new EventEmitter();
    worker.terminate = vi.fn(async () => {
      worker.emit('exit', 1);
      return 1;
    });
    createWorker = vi.fn(() => worker);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('waits for successful completion and exit before releasing the output file', async () => {
    const result = synthesizeSpeech('synthetic text', 'synthetic.mp3', {
      createWorker,
    });
    const done = vi.fn();
    result.then(done);
    expect(createWorker).toHaveBeenCalledWith(expect.any(URL), {
      workerData: { text: 'synthetic text', outputPath: 'synthetic.mp3' },
    });
    expect(createWorker.mock.calls[0][0].pathname).toMatch(/\/ttsWorker\.js$/);
    worker.emit('message', { type: 'complete' });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    worker.emit('exit', 0);
    await expect(result).resolves.toBeUndefined();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('turns an unhandled WebSocket 403 into a sanitized rejection', async () => {
    const result = synthesizeSpeech('private speech text', 'synthetic.mp3', {
      createWorker,
    });
    const checked = expect(result).rejects.toMatchObject({
      code: 'TTS_SYNTHESIS_FAILED',
      httpStatus: 403,
    });
    worker.emit(
      'error',
      new Error(
        'Unexpected server response: 403 wss://private.invalid/?token=secret',
      ),
    );
    await checked;
    const error = await result.catch((failure) => failure);
    expect(String(error)).not.toMatch(/private|secret|wss:/);
    expect(error.cause).toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for worker termination before rejecting a failed job', async () => {
    let stop;
    worker.terminate.mockImplementation(
      () =>
        new Promise((resolve) => {
          stop = resolve;
        }),
    );
    const result = synthesizeSpeech('test', 'synthetic.mp3', { createWorker });
    const failed = vi.fn();
    const observed = result.catch(failed);
    worker.emit('error', new Error('Unexpected server response: 403'));
    // A second error while stopping must still have a listener.
    worker.emit('error', new Error('another connection failure'));
    await Promise.resolve();
    expect(failed).not.toHaveBeenCalled();
    worker.emit('exit', 1);
    stop(1);
    await observed;
    expect(failed).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates a stalled handshake at the overall deadline', async () => {
    const result = synthesizeSpeech('test', 'synthetic.mp3', {
      createWorker,
      timeoutMs: 25,
    });
    const checked = expect(result).rejects.toMatchObject({
      code: 'TTS_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(25);
    await checked;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1])(
    'rejects exit %s without a completion message',
    async (code) => {
      const result = synthesizeSpeech('test', 'synthetic.mp3', {
        createWorker,
      });
      const checked = expect(result).rejects.toMatchObject({
        code: 'TTS_WORKER_EXIT',
      });
      worker.emit('exit', code);
      await checked;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not treat a completion message followed by a crash as success', async () => {
    const result = synthesizeSpeech('test', 'synthetic.mp3', { createWorker });
    const checked = expect(result).rejects.toMatchObject({
      code: 'TTS_WORKER_EXIT',
    });
    worker.emit('message', { type: 'complete' });
    worker.emit('exit', 1);
    await checked;
  });

  it('sanitizes worker startup failures', async () => {
    createWorker.mockImplementation(() => {
      throw new Error('private local path');
    });
    await expect(
      synthesizeSpeech('test', 'synthetic.mp3', { createWorker }),
    ).rejects.toMatchObject({
      code: 'TTS_WORKER_START_FAILED',
      httpStatus: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles worker termination rejection without an unhandled promise', async () => {
    worker.terminate.mockRejectedValue(new Error('private shutdown detail'));
    const result = synthesizeSpeech('test', 'synthetic.mp3', {
      createWorker,
      timeoutMs: 25,
    });
    const checked = expect(result).rejects.toMatchObject({
      code: 'TTS_WORKER_EXIT',
    });
    await vi.advanceTimersByTimeAsync(25);
    await checked;
  });

  it('contains a real worker unhandled error without touching network or audio', async () => {
    vi.useRealTimers();
    // Explicitly bypass the worker guard only for this self-contained fixture.
    // It imports no app modules and makes no HTTP, filesystem, or audio calls.
    const { Worker } = await vi.importActual('node:worker_threads');
    const createFixtureWorker = () =>
      new Worker(
        `
      import('node:events').then(({ EventEmitter }) => {
        const socket = new EventEmitter();
        setImmediate(() => socket.emit('error', new Error('Unexpected server response: 403')));
      });
    `,
        { eval: true },
      );
    await expect(
      synthesizeSpeech('test', 'unused.mp3', {
        createWorker: createFixtureWorker,
        timeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ code: 'TTS_SYNTHESIS_FAILED', httpStatus: 403 });
    // Reaching this assertion proves the unhandled event did not exit the host.
    expect(true).toBe(true);
  });
});
