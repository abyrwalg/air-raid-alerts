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
import { formatModelResponse, formatRequest } from '../public/logs-format.js';
import {
  highlightJsonElement,
  tokenizeJson,
} from '../public/logs-highlight.js';
import { initializeTheme } from '../public/logs-theme.js';

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

  it('formats OpenAI and Codex JSON output while retaining the original payload', () => {
    const modelOutput = JSON.stringify({
      summary: 'Загроза',
      risk_level: 'medium',
    });
    for (const providerResponse of [
      { text: modelOutput },
      { choices: [{ message: { content: modelOutput } }] },
    ]) {
      const view = formatModelResponse(providerResponse);
      expect(view.formatted).toBe(
        JSON.stringify(JSON.parse(modelOutput), null, 2),
      );
      expect(view.raw).toBe(JSON.stringify(providerResponse, null, 2));
      expect(view.raw).not.toBe(view.formatted);
    }
  });

  it('formats structured triage responses, preserves plain text, and handles missing output', () => {
    const triage = { answers: [{ type: 'predicate', probability: 0.8 }] };
    expect(formatModelResponse(triage).formatted).toBe(
      JSON.stringify(triage, null, 2),
    );
    expect(
      formatModelResponse({ text: 'A plain response\nwith lines.' }).formatted,
    ).toBe('A plain response\nwith lines.');
    expect(formatModelResponse({ text: 'not valid {json' }).formatted).toBe(
      'not valid {json',
    );
    expect(formatModelResponse(null)).toEqual({
      formatted: '',
      raw: 'No response captured.',
    });
  });

  it('formats logged requests as readable text while retaining raw JSON', () => {
    const actualNewlines = 'First line\n\nSecond line';
    const literalEscapes = String.raw`literal \\n stays literal`;
    const requests = [
      {
        instructions: `Rules\n\n${actualNewlines}`,
        input: 'Український текст',
      },
      {
        body: {
          messages: [
            { role: 'system', content: `Rules\n${actualNewlines}` },
            { role: 'user', content: literalEscapes },
          ],
        },
      },
      {
        body: {
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: `Rules\n${actualNewlines}` },
              ],
            },
          ],
          questions: [{ instructions: 'Assess the message.' }],
        },
      },
    ];

    for (const request of requests) {
      const view = formatRequest(request);
      expect(view.raw).toBe(JSON.stringify(request, null, 2));
      expect(view.sections.map(({ text }) => text).join('\n')).toContain(
        actualNewlines,
      );
    }
    expect(formatRequest(requests[0]).sections).toEqual([
      { label: 'Input', text: 'Український текст' },
      { label: 'Instructions', text: `Rules\n\n${actualNewlines}` },
    ]);
    expect(formatRequest(requests[1]).sections[1].text).toBe(literalEscapes);
    expect(formatRequest(requests[2]).sections.at(-1)).toEqual({
      label: 'Question instructions',
      text: 'Assess the message.',
    });
  });

  it('safely falls back to raw JSON for unknown and missing requests', () => {
    const unknown = { opaque: '<img src=x onerror=alert(1)>' };
    expect(formatRequest(unknown)).toEqual({
      sections: [
        { label: 'Request payload', text: JSON.stringify(unknown, null, 2) },
      ],
      raw: JSON.stringify(unknown, null, 2),
    });
    expect(formatRequest(null)).toEqual({
      sections: [],
      raw: 'No payload captured.',
    });
  });

  it('tokenizes all JSON value types and preserves nested Unicode JSON exactly', () => {
    const json =
      '{"ключ":"Значення","count":-2.5e2,"ok":true,"empty":null,"items":[false,{}]}';
    const tokens = tokenizeJson(json);
    expect(tokens.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        'key',
        'string',
        'number',
        'boolean',
        'null',
        'punctuation',
      ]),
    );
    expect(tokens.map(({ text }) => text).join('')).toBe(json);
    expect(tokenizeJson('not { valid json')).toBeNull();
  });

  it('uses text nodes for highlighted content instead of interpreting HTML-like strings', () => {
    const hostile = '{"message":"<img src=x onerror=alert(1)>"}';
    const makeNode = (tagName = '#text') => ({
      tagName,
      children: [],
      append(...nodes) {
        this.children.push(...nodes);
      },
      set textContent(value) {
        this.text = value;
      },
      get textContent() {
        return (
          this.text ?? this.children.map((child) => child.textContent).join('')
        );
      },
    });
    const document = {
      createDocumentFragment: () => makeNode('#fragment'),
      createTextNode: (text) => Object.assign(makeNode('#text'), { text }),
      createElement: (tag) =>
        Object.assign(makeNode(tag), { ownerDocument: document }),
    };
    const element = Object.assign(makeNode('pre'), { ownerDocument: document });
    element.replaceChildren = (...children) => {
      element.children = children;
    };
    expect(highlightJsonElement(element, hostile)).toBe(true);
    expect(element.textContent).toBe(hostile);
    const tags = [];
    const visit = (node) => {
      tags.push(node.tagName);
      node.children.forEach(visit);
    };
    visit(element);
    expect(tags).not.toContain('img');
  });

  it('applies and persists System/Light/Dark themes and tolerates unavailable storage', () => {
    const createSelector = (initialValue = '') => ({
      value: initialValue,
      handlers: {},
      addEventListener(name, handler) {
        this.handlers[name] = handler;
      },
    });
    const root = { dataset: {} };
    const saved = { getItem: () => 'dark', setItem: vi.fn() };
    const selector = createSelector();
    initializeTheme(selector, { root, storage: saved, media: null });
    expect(selector.value).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    selector.value = 'light';
    selector.handlers.change();
    expect(root.dataset.theme).toBe('light');
    expect(saved.setItem).toHaveBeenCalledWith('aiLogsTheme', 'light');

    const noStorageSelector = createSelector();
    const noStorageRoot = { dataset: {} };
    initializeTheme(noStorageSelector, {
      root: noStorageRoot,
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
      media: null,
    });
    expect(noStorageRoot.dataset.theme).toBe('system');
    noStorageSelector.value = 'dark';
    expect(() => noStorageSelector.handlers.change()).not.toThrow();
    expect(noStorageRoot.dataset.theme).toBe('dark');

    const systemSelector = createSelector();
    const systemRoot = { dataset: {} };
    const mediaListener = vi.fn();
    initializeTheme(systemSelector, {
      root: systemRoot,
      storage: { getItem: () => null },
      media: {
        addEventListener: (_event, listener) =>
          mediaListener.mockImplementation(listener),
      },
    });
    expect(systemRoot.dataset.theme).toBe('system');
    mediaListener();
    expect(systemRoot.dataset.theme).toBe('system');
  });

  it('renders readable request sections and collapsed raw request and response', async () => {
    const viewerScript = await readFile(
      new URL('../public/logs.js', import.meta.url),
      'utf8',
    );
    const responsePosition = viewerScript.indexOf("payload('Response'");
    const rawPosition = viewerScript.indexOf(
      "summary.textContent = 'Raw response'",
    );
    const requestPosition = viewerScript.indexOf('formatRequest(item.request)');
    const rawRequestPosition = viewerScript.indexOf(
      "rawRequestSummary.textContent = 'Raw request'",
    );
    expect(responsePosition).toBeGreaterThan(-1);
    expect(responsePosition).toBeLessThan(rawPosition);
    expect(rawPosition).toBeLessThan(requestPosition);
    expect(requestPosition).toBeLessThan(rawRequestPosition);
    expect(viewerScript).toContain("document.createElement('details')");
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
    expect(viewerHtml).toContain('/logs/theme-init.js');
    expect(viewerHtml).toContain('id="theme"');
    const viewerStyles = await readFile(
      new URL('../public/logs.css', import.meta.url),
      'utf8',
    );
    expect(viewerStyles).toContain(":root[data-theme='light']");
    expect(viewerStyles).toContain('--json-key:');
    expect(viewerStyles).toContain('--json-string:');
    expect(viewerStyles).toContain('@media (prefers-color-scheme: light)');
    app.use('/logs', aiLogRoutes);
    app.use('/api/ai-logs', aiLogApiRouter);
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const highlightScript = await fetch(`${base}/logs/logs-highlight.js`);
      expect(highlightScript.status).toBe(200);
      expect(await highlightScript.text()).toContain('highlightJsonElement');
      const themeScript = await fetch(`${base}/logs/logs-theme.js`);
      expect(themeScript.status).toBe(200);
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
