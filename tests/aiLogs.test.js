import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { AiLogStore } from '../aiLogs/store.js';
import { AiLogRecorder, sanitize } from '../aiLogs/recorder.js';
import { getLogConfig } from '../aiLogs/config.js';
import {
  closeAiLogs,
  getAiLogStore,
  initializeAiLogs,
} from '../aiLogs/runtime.js';
import aiLogRoutes, { aiLogApiRouter } from '../aiLogs/routes.js';
import { readApiResponse } from '../public/logs-api.js';

const directories = [];
async function temporaryFile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-logs-test-'));
  directories.push(directory);
  return path.join(directory, 'nested', 'entries.json');
}
afterEach(async () => {
  await closeAiLogs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('local AI log storage', () => {
  it('persists completed requests, sanitizes credential fields, and reloads them', async () => {
    const filePath = await temporaryFile();
    const store = new AiLogStore({ filePath });
    await store.initialize();
    const recorder = new AiLogRecorder({ store, logger: { error: vi.fn() } });
    const call = recorder.start({
      evaluationId: 'evaluation-1',
      provider: 'openai',
      task: 'analysis',
      model: 'test-model',
      request: {
        prompt: 'sample prompt',
        api_key: 'do-not-store',
        nested: { access_token: 'secret', keep: true },
      },
    });
    await call.success({
      answer: 'sample response',
      usage: { total_tokens: 7 },
    });
    await store.close();

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      status: 'success',
      evaluationId: 'evaluation-1',
      task: 'analysis',
    });
    expect(JSON.stringify(persisted)).not.toContain('do-not-store');
    expect(JSON.stringify(persisted)).not.toContain('secret');
    const reloaded = new AiLogStore({ filePath });
    await reloaded.initialize();
    expect(reloaded.get(call.id).response.answer).toBe('sample response');
    await reloaded.close();
  });

  it('prunes expired entries on load and bounds retention configuration', async () => {
    let now = Date.parse('2026-01-31T00:00:00.000Z');
    const filePath = await temporaryFile();
    const store = new AiLogStore({
      filePath,
      retentionDays: 30,
      clock: () => now,
    });
    await store.initialize();
    await store.upsert({
      id: 'old',
      startedAt: '2025-12-31T23:59:59.000Z',
      status: 'success',
    });
    await store.upsert({
      id: 'recent',
      startedAt: '2026-01-01T00:00:01.000Z',
      status: 'success',
    });
    now += 1;
    const restarted = new AiLogStore({
      filePath,
      retentionDays: 30,
      clock: () => now,
    });
    await restarted.initialize();
    expect(restarted.list().map((entry) => entry.id)).toEqual(['recent']);
    await restarted.close();
    expect(getLogConfig({}).retentionDays).toBe(30);
    expect(() => getLogConfig({ AI_LOG_RETENTION_DAYS: '0' })).toThrow(
      'AI_LOG_RETENTION_DAYS',
    );
  });

  it('stores only safe error categories and strips credential-like keys recursively', () => {
    expect(
      sanitize({
        message: 'content',
        authorization: 'Bearer key',
        nested: { password: 'secret', value: 1 },
      }),
    ).toEqual({
      message: 'content',
      nested: { value: 1 },
    });
  });

  it('explains non-JSON and malformed API responses without leaking their bodies', async () => {
    const htmlResponse = {
      ok: false,
      status: 404,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html>private server page</html>',
    };
    await expect(
      readApiResponse(htmlResponse, 'Unable to load logs'),
    ).rejects.toThrow('HTTP 404 with a non-JSON response');
    await expect(
      readApiResponse(htmlResponse, 'Unable to load logs'),
    ).rejects.not.toThrow('private server page');
    await expect(
      readApiResponse(
        {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => {
            throw new Error('bad json');
          },
        },
        'Unable to load logs',
      ),
    ).rejects.toThrow('returned invalid JSON');
  });

  it('keeps provider execution independent from log-storage failures', async () => {
    const errors = vi.fn();
    const recorder = new AiLogRecorder({
      store: { upsert: vi.fn().mockRejectedValue(new Error('disk failure')) },
      logger: { error: errors },
    });
    const call = recorder.start({
      provider: 'codex',
      task: 'analysis',
      request: {},
    });
    await call.success({ text: 'captured' });
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0][0]).not.toContain('disk failure');
  });

  it('marks unfinished requests interrupted after a restart', async () => {
    const filePath = await temporaryFile();
    const config = { enabled: true, filePath, retentionDays: 30 };
    await initializeAiLogs({ config });
    await getAiLogStore().upsert({
      id: 'unfinished',
      startedAt: new Date().toISOString(),
      status: 'in_progress',
    });
    await closeAiLogs();
    await initializeAiLogs({ config });
    expect(getAiLogStore().get('unfinished').status).toBe('interrupted');
  });

  it('serves read-only filtered summaries and full details over the LAN route', async () => {
    const filePath = await temporaryFile();
    await initializeAiLogs({
      config: { enabled: true, filePath, retentionDays: 30 },
    });
    const store = getAiLogStore();
    const today = new Date().toISOString().slice(0, 10);
    await store.upsert({
      id: 'visible',
      evaluationId: 'group-1',
      provider: 'codex',
      task: 'analysis',
      model: 'model-x',
      status: 'success',
      startedAt: `${today}T10:00:00.000Z`,
      request: { input: 'searchable prompt' },
      response: { text: 'answer' },
      durationMs: 10,
    });
    const app = express();
    const viewerScript = await readFile(
      new URL('../public/logs.js', import.meta.url),
      'utf8',
    );
    expect(viewerScript).toContain('fetch(`/api/ai-logs?${params()}`');
    expect(viewerScript).toContain(
      'fetch(`/api/ai-logs/${encodeURIComponent(id)}`)',
    );
    expect(viewerScript).not.toContain('/logs/api/ai-logs');
    const viewerHtml = await readFile(
      new URL('../public/logs.html', import.meta.url),
      'utf8',
    );
    expect(viewerHtml).toContain('type="module"');
    app.use('/logs', aiLogRoutes);
    app.use('/api/ai-logs', aiLogApiRouter);
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const listResponse = await fetch(
        `${base}/api/ai-logs?provider=codex&search=searchable&from=${today}&to=${today}`,
      );
      expect(listResponse.status).toBe(200);
      expect(listResponse.headers.get('cache-control')).toBe('no-store');
      const list = await listResponse.json();
      expect(list.total).toBe(1);
      expect(list.items[0]).not.toHaveProperty('request');
      const detail = await fetch(`${base}/api/ai-logs/visible`);
      expect((await detail.json()).request.input).toBe('searchable prompt');
      const invalid = await fetch(`${base}/api/ai-logs?task=login`);
      expect(invalid.status).toBe(400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
