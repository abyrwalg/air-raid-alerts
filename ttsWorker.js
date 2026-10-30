// Some versions of the speech client emit uncaught WebSocket errors instead
// of rejecting ttsPromise. A worker confines those errors to this one job.
import { parentPort, workerData } from 'node:worker_threads';
import { EdgeTTS } from 'node-edge-tts';

const tts = new EdgeTTS({
  voice: 'ru-RU-SvetlanaNeural',
  lang: 'ru-RU',
  outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
});

await tts.ttsPromise(workerData.text, workerData.outputPath);
parentPort.postMessage({ type: 'complete' });
