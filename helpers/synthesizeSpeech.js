import { Worker } from 'node:worker_threads';

const workerUrl = new URL('../ttsWorker.js', import.meta.url);
const createDefaultWorker = (url, options) => new Worker(url, options);

function synthesisError(code, httpStatus = null) {
  const error = new Error('Speech synthesis failed; announcement skipped.');
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function connectionError(error) {
  // Do not forward SDK errors: they may contain text, URLs, or credentials.
  const match =
    typeof error?.message === 'string'
      ? error.message.match(/Unexpected server response: ([1-5]\d{2})\b/)
      : null;
  return synthesisError(
    'TTS_SYNTHESIS_FAILED',
    match ? Number(match[1]) : null,
  );
}

export default function synthesizeSpeech(
  text,
  outputPath,
  { createWorker = createDefaultWorker, timeoutMs = 20000 } = {},
) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = createWorker(workerUrl, { workerData: { text, outputPath } });
    } catch {
      reject(synthesisError('TTS_WORKER_START_FAILED'));
      return;
    }

    let settled = false;
    let completed = false;
    let timer;
    const finish = async (error, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Wait for termination before callers delete the partially written file
      // or start the next job. Keep the error listener until the worker stops.
      if (terminate) {
        try {
          await worker.terminate();
        } catch {
          error = synthesisError('TTS_WORKER_EXIT');
        }
      }
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message) => {
      if (message?.type === 'complete') completed = true;
    };
    const onError = (error) => {
      void finish(connectionError(error), true);
    };
    const onExit = (code) => {
      // Waiting for exit also lets the old client's file stream finish flushing.
      void finish(
        code === 0 && completed ? null : synthesisError('TTS_WORKER_EXIT'),
      );
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    timer = setTimeout(() => {
      void finish(synthesisError('TTS_TIMEOUT'), true);
    }, timeoutMs);
  });
}
