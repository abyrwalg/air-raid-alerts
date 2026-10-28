import { getLogConfig } from './config.js';
import { AiLogRecorder } from './recorder.js';
import { AiLogStore } from './store.js';

let store;
let recorder;
let cleanupTimer;

export async function initializeAiLogs({ config = getLogConfig() } = {}) {
  if (!config.enabled) return null;
  if (!store) store = new AiLogStore(config);
  await store.initialize();
  for (const entry of store.list()) {
    if (entry.status === 'in_progress') {
      entry.status = 'interrupted';
      entry.finishedAt = new Date().toISOString();
    }
  }
  await store.pruneAndSave();
  recorder ||= new AiLogRecorder({ store });
  cleanupTimer ||= setInterval(() => void store.pruneAndSave(), 60 * 60 * 1000);
  cleanupTimer.unref?.();
  return store;
}

export function getAiLogRecorder() {
  return recorder;
}
export function getAiLogStore() {
  return store;
}

export async function closeAiLogs() {
  clearInterval(cleanupTimer);
  cleanupTimer = null;
  if (store) await store.close();
  store = null;
  recorder = null;
}
