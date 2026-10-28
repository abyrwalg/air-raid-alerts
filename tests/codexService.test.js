import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
import { CodexService, validateDeviceLogin } from '../codex/service.js';
import { prompt, schema } from '../config.js';
import { getAIConfig } from '../aiConfig.js';
import {
  buildTriageInput,
  codexTriageInstructions,
  triageOutputSchema,
} from '../providers/triage.js';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.cwd = 'isolated-workspace';
    this.child = {};
    this.account = null;
    this.limits = null;
    this.counter = 0;
    this.request = vi.fn(async (method) => {
      if (method === 'account/read') return { account: this.account };
      if (method === 'account/rateLimits/read')
        return { rateLimits: this.limits };
      if (method === 'account/login/start')
        return {
          type: 'chatgptDeviceCode',
          loginId: 'login-1',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-1234',
        };
      if (method === 'thread/start')
        return { thread: { id: `thread-${++this.counter}` } };
      return {};
    });
    this.close = vi.fn(() => {
      this.child = null;
      this.emit('disconnected');
    });
  }
  notify(method, params) {
    this.emit('notification', { method, params });
  }
}

describe('Codex authentication lifecycle', () => {
  let client;
  let service;
  beforeEach(() => {
    client = new FakeClient();
    service = new CodexService(
      {
        codexLoginTimeoutMs: 1000,
        analysisTimeoutMs: 2000,
        analysisModel: 'test-model',
        triageModel: 'triage-model',
        triageTimeoutMs: 1000,
      },
      client,
    );
  });
  afterEach(() => {
    service.close();
    vi.useRealTimers();
  });

  it('reports signed-out status without starting interactive login', async () => {
    expect(await service.status()).toEqual({ status: 'signed_out' });
    expect(client.request).toHaveBeenCalledExactlyOnceWith('account/read', {
      refreshToken: false,
    });
  });

  it('allows startup readiness checks to refresh a stored token', async () => {
    client.account = { type: 'chatgpt' };
    expect(await service.status({ refreshToken: true })).toEqual({
      status: 'connected',
    });
    expect(client.request).toHaveBeenCalledWith('account/read', {
      refreshToken: true,
    });
  });

  it('returns validated quota windows for a connected ChatGPT account', async () => {
    client.account = { type: 'chatgpt' };
    client.limits = {
      primary: {
        usedPercent: 25,
        windowDurationMins: 300,
        resetsAt: 1_800_000_000,
      },
      secondary: {
        usedPercent: 90,
        windowDurationMins: 10080,
        resetsAt: 1_800_000_000_000,
      },
      unknown: { usedPercent: 3 },
    };
    expect(await service.rateLimits()).toEqual([
      {
        label: 'Short-term',
        usedPercent: 25,
        windowDurationMins: 300,
        resetsAt: new Date(1_800_000_000_000).toISOString(),
      },
      {
        label: 'Long-term',
        usedPercent: 90,
        windowDurationMins: 10080,
        resetsAt: new Date(1_800_000_000_000).toISOString(),
      },
    ]);
    expect(client.request).toHaveBeenCalledWith(
      'account/rateLimits/read',
      undefined,
      5000,
      { closeOnTimeout: false },
    );
  });

  it('returns unavailable when signed out or when reported windows are invalid', async () => {
    expect(await service.rateLimits()).toBeNull();
    expect(client.request).not.toHaveBeenCalledWith(
      'account/rateLimits/read',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    client.account = { type: 'chatgpt' };
    client.limits = {
      primary: { usedPercent: 101, windowDurationMins: 5, resetsAt: 1000 },
    };
    expect(await service.rateLimits()).toBeNull();
  });

  it('reuses a saved ChatGPT session but not API-key authentication', async () => {
    client.account = { type: 'chatgpt', email: 'private@example.com' };
    expect(await service.startLogin()).toEqual({ status: 'connected' });
    client.account = { type: 'apiKey' };
    expect(await service.status()).toEqual({ status: 'signed_out' });
  });

  it('shares one active attempt and returns only safe device-flow data', async () => {
    const [a, b] = await Promise.all([
      service.startLogin(),
      service.startLogin(),
    ]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 'pending', userCode: 'ABCD-1234' });
    expect(a).not.toHaveProperty('loginId');
    expect(
      client.request.mock.calls.filter(
        ([method]) => method === 'account/login/start',
      ),
    ).toHaveLength(1);
    expect(await service.status()).toEqual(a);
  });

  it('updates connection status on successful completion and removes device codes', async () => {
    await service.startLogin();
    client.notify('account/login/completed', {
      loginId: 'login-1',
      success: true,
    });
    expect(service.publicState()).toEqual({ status: 'connected' });
  });

  it('handles completion delivered before the login-start response', async () => {
    const original = client.request.getMockImplementation();
    client.request.mockImplementation(async (method, params) => {
      const response = await original(method, params);
      if (method === 'account/login/start')
        client.notify('account/login/completed', {
          loginId: 'login-1',
          success: true,
        });
      return response;
    });
    expect(await service.startLogin()).toEqual({ status: 'connected' });
  });

  it('cancels pending sign-in and ignores stale completion events', async () => {
    await service.startLogin();
    expect(await service.cancelLogin()).toEqual({ status: 'signed_out' });
    expect(client.request).toHaveBeenCalledWith('account/login/cancel', {
      loginId: 'login-1',
    });
    client.notify('account/login/completed', {
      loginId: 'login-1',
      success: true,
    });
    expect(service.publicState()).toEqual({ status: 'signed_out' });
  });

  it('expires pending attempts and clears the authorization code', async () => {
    vi.useFakeTimers();
    await service.startLogin();
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.publicState()).toMatchObject({
      status: 'error',
      message: expect.stringContaining('expired'),
    });
    expect(service.publicState()).not.toHaveProperty('userCode');
    expect(client.request).toHaveBeenCalledWith('account/login/cancel', {
      loginId: 'login-1',
    });
  });

  it('signs out through Codex and closes its connection', async () => {
    await service.startLogin();
    expect(await service.logout()).toEqual({ status: 'signed_out' });
    expect(client.request).toHaveBeenCalledWith('account/logout');
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('redacts login failures and permits retry', async () => {
    client.request.mockRejectedValueOnce(new Error('private-token'));
    await expect(service.startLogin()).rejects.toThrow();
    expect(JSON.stringify(service.publicState())).not.toContain(
      'private-token',
    );
    expect((await service.startLogin()).status).toBe('pending');
  });

  it('fails safely on unexpected authorization URLs or malformed codes', () => {
    for (const value of [
      null,
      {},
      {
        type: 'chatgptDeviceCode',
        loginId: 'x',
        verificationUrl: 'https://evil.example',
        userCode: 'ABCD',
      },
      {
        type: 'chatgptDeviceCode',
        loginId: 'x',
        verificationUrl: 'https://auth.openai.com',
        userCode: '<script>',
      },
    ])
      expect(() => validateDeviceLogin(value)).toThrow('unsupported');
  });

  it('never launches login automatically for an analysis request', async () => {
    await expect(service.analyze('message')).rejects.toThrow('/auth/codex');
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      'account/read',
    ]);
  });

  it('creates fresh ephemeral threads with shared instructions and output schema', async () => {
    client.account = { type: 'chatgpt' };
    for (let i = 1; i <= 2; i++) {
      const result = service.analyze(`content-${i}`);
      await vi.waitFor(() =>
        expect(client.request).toHaveBeenCalledWith(
          'turn/start',
          expect.objectContaining({ threadId: `thread-${i}` }),
        ),
      );
      client.notify('item/completed', {
        threadId: `thread-${i}`,
        item: { type: 'agentMessage', text: `result-${i}` },
      });
      client.notify('turn/completed', {
        threadId: `thread-${i}`,
        turn: { status: 'completed', items: [] },
      });
      expect(await result).toBe(`result-${i}`);
    }
    expect(client.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        ephemeral: true,
        baseInstructions: prompt,
        model: 'test-model',
        sandbox: 'read-only',
        approvalPolicy: 'never',
        cwd: 'isolated-workspace',
      }),
    );
    expect(client.request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        input: [{ type: 'text', text: 'content-2', text_elements: [] }],
        outputSchema: { ...schema, additionalProperties: false },
      }),
    );
    expect(client.listenerCount('notification')).toBe(1);
    expect(client.listenerCount('disconnected')).toBe(1);
  });

  it('terminates native inference on timeout and releases event listeners', async () => {
    client.account = { type: 'chatgpt' };
    vi.useFakeTimers();
    const result = service.analyze('content');
    const rejection = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.listenerCount('notification')).toBe(1);
  });

  it('reports failed turns without exposing raw model errors', async () => {
    client.account = { type: 'chatgpt' };
    const result = service.analyze('content');
    const rejection = expect(result).rejects.toThrow('Codex analysis failed');
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(
        'turn/start',
        expect.anything(),
      ),
    );
    client.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { status: 'failed', error: { message: 'private-token' } },
    });
    await rejection;
  });

  it('sends shared triage instructions and schema, then uses a separate full-analysis thread', async () => {
    client.account = { type: 'chatgpt' };
    const result = service.evaluateTriage('current alert', 'recent alert');
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({ threadId: 'thread-1' }),
      ),
    );
    expect(client.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        model: 'triage-model',
        baseInstructions: codexTriageInstructions,
        ephemeral: true,
        sandbox: 'read-only',
        approvalPolicy: 'never',
      }),
    );
    expect(client.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [
        {
          type: 'text',
          text: buildTriageInput('current alert', 'recent alert'),
          text_elements: [],
        },
      ],
      outputSchema: triageOutputSchema,
    });
    client.notify('turn/completed', {
      threadId: 'thread-1',
      turn: {
        status: 'completed',
        items: [
          {
            type: 'agentMessage',
            text: JSON.stringify({
              answers: [
                {
                  type: 'predicate',
                  name: 'worth_full_analysis',
                  probability: 0.8,
                },
              ],
            }),
          },
        ],
      },
    });
    expect(await result).toBe(0.8);
    const analysis = service.analyze('analysis input');
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({ threadId: 'thread-2' }),
      ),
    );
    const starts = client.request.mock.calls.filter(
      ([method]) => method === 'thread/start',
    );
    expect(starts[1][1]).toMatchObject({
      model: 'test-model',
      baseInstructions: prompt,
      ephemeral: true,
    });
    client.notify('turn/completed', {
      threadId: 'thread-2',
      turn: {
        status: 'completed',
        items: [{ type: 'agentMessage', text: 'full analysis' }],
      },
    });
    expect(await analysis).toBe('full analysis');
    expect(client.listenerCount('notification')).toBe(1);
  });

  it.each(['', 'specific-triage-model'])(
    'uses resolved Codex triage model setting %s',
    async (model) => {
      service.config = getAIConfig({
        ANALYSIS_PROVIDER: 'codex',
        ANALYSIS_MODEL: 'analysis-model',
        TRIAGE_PROVIDER: 'codex',
        TRIAGE_MODEL: model,
      });
      client.account = { type: 'chatgpt' };
      const result = service.evaluateTriage('alert', '');
      await vi.waitFor(() =>
        expect(client.request).toHaveBeenCalledWith(
          'turn/start',
          expect.anything(),
        ),
      );
      expect(client.request).toHaveBeenCalledWith(
        'thread/start',
        expect.objectContaining({ model: model || null }),
      );
      client.notify('turn/completed', {
        threadId: 'thread-1',
        turn: {
          status: 'completed',
          items: [
            {
              type: 'agentMessage',
              text: '{"answers":[{"type":"predicate","name":"worth_full_analysis","probability":0.5}]}',
            },
          ],
        },
      });
      expect(await result).toBe(0.5);
    },
  );

  it('rejects malformed Codex triage output after the turn completes', async () => {
    client.account = { type: 'chatgpt' };
    const result = service.evaluateTriage('alert', '');
    const rejection = expect(result).rejects.toThrow('invalid predicate');
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(
        'turn/start',
        expect.anything(),
      ),
    );
    client.notify('turn/completed', {
      threadId: 'thread-1',
      turn: {
        status: 'completed',
        items: [{ type: 'agentMessage', text: '{"answers":[]}' }],
      },
    });
    await rejection;
    expect(client.listenerCount('notification')).toBe(1);
  });

  it('uses the separate triage deadline and terminates timed-out inference', async () => {
    client.account = { type: 'chatgpt' };
    vi.useFakeTimers();
    const result = service.evaluateTriage('alert', '');
    const rejection = expect(result).rejects.toThrow('Codex triage timed out');
    await vi.advanceTimersByTimeAsync(999);
    expect(client.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.listenerCount('notification')).toBe(1);
  });

  it('does not launch interactive sign-in for Codex triage', async () => {
    await expect(service.evaluateTriage('alert', '')).rejects.toThrow(
      '/auth/codex',
    );
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      'account/read',
    ]);
  });
});
