import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { EdgeTTS } from 'node-edge-tts';
import portAudio from 'naudiodon';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let playbackQueue = Promise.resolve();

function enqueue(task) {
  playbackQueue = playbackQueue
    .then(() => task())
    .catch((err) => {
      console.error('Playback queue error:', err);
    });

  return playbackQueue;
}

export default function textToSpeech(text) {
  return enqueue(() => playTTS(text));
}

async function streamToSpeaker(filePath) {
  return new Promise((resolve, reject) => {
    const devices = portAudio.getDevices();
    const bluetoothSpeaker = devices.find((d) =>
      d.name.includes('soundcore Select 2S'),
    );

    if (!bluetoothSpeaker) {
      console.log('Bluetooth speaker not found, cancelling playback.');
      resolve();
      return;
    }

    const DEVICE_ID = bluetoothSpeaker.id;

    // Spawn ffmpeg to decode MP3 → raw PCM
    const ffmpeg = spawn(
      'ffmpeg',
      ['-i', filePath, '-f', 's16le', '-ac', '2', '-ar', '44100', '-'],
      { windowsHide: true },
    );

    ffmpeg.stderr.on('data', () => {}); // keep stderr drainable

    let settled = false;
    const safeResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const safeReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
      // Best-effort cleanup
      try {
        ffmpeg.kill('SIGKILL');
      } catch (_) {}
      try {
        ao.abort();
      } catch (_) {}
    };

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg error:', err);
      safeReject(err);
    });

    ffmpeg.on('close', (code, signal) => {
      if (code !== 0) {
        safeReject(
          new Error(
            `FFmpeg exited with code ${code}, signal ${signal || 'none'}`,
          ),
        );
      }
      // If code === 0, we *don't* resolve here; we wait for ao 'close'
      // so we know playback has fully finished.
    });

    // Create audio output stream
    const ao = new portAudio.AudioIO({
      outOptions: {
        channelCount: 2,
        sampleFormat: portAudio.SampleFormat16Bit,
        sampleRate: 44100,
        deviceId: DEVICE_ID,
        closeOnError: true,
      },
    });

    ao.on('error', (err) => {
      console.error('Audio error:', err);
      safeReject(err);
    });

    // Optional: detect audio end
    ao.on('close', () => {
      console.log('Playback finished');
      safeResolve();
    });

    ao.start();

    // Handle backpressure
    ffmpeg.stdout.on('data', (chunk) => {
      if (!ao.write(chunk)) {
        ffmpeg.stdout.pause();
        ao.once('drain', () => ffmpeg.stdout.resume());
      }
    });

    // When ffmpeg finishes producing PCM
    ffmpeg.stdout.on('end', () => {
      ao.end(); // allow PortAudio to drain buffers
    });
  });
}

async function playTTS(text) {
  let outputPath;

  try {
    const tts = new EdgeTTS({
      voice: 'ru-RU-SvetlanaNeural',
      lang: 'ru-RU',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    });

    const id = crypto.randomUUID();
    const chimePath = path.join(__dirname, 'chime.mp3');
    outputPath = path.join(__dirname, `output-${id}.mp3`);

    await tts.ttsPromise(text, outputPath);

    await streamToSpeaker(chimePath);
    await streamToSpeaker(outputPath);
  } catch (error) {
    console.error('TTS Synthesis Error:', error);
  } finally {
    if (outputPath) {
      try {
        await fs.unlink(outputPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error('Failed to cleanup TTS file:', err);
        }
      }
    }
  }
}

// Prevent speaker from going to sleep by playing silence periodically
const silencePath = path.join(__dirname, 'silence.mp3');

function queueSilencePlayback() {
  console.log('Queuing silence playback to keep speaker awake');
  return enqueue(() => streamToSpeaker(silencePath));
}
setInterval(
  () => {
    queueSilencePlayback();
  },
  10 * 60 * 1000,
); // every 10 minutes
