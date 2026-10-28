import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
const { imported, defaultStart, defaultRouter } = vi.hoisted(() => ({
  imported: vi.fn(),
  defaultStart: vi.fn().mockResolvedValue(undefined),
  defaultRouter: vi.fn((req, res) => res.json({ status: 'ok' })),
}));
vi.mock('../application.js', () => {
  imported();
  return {
    start: defaultStart,
    router: defaultRouter,
    stop: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../routes.js', () => {
  throw new Error(
    'Real application routes must not load in startup unit tests.',
  );
});
vi.mock('../helpers/processMessage.js', () => {
  throw new Error(
    'Real message processing must not load in startup unit tests.',
  );
});
import { getAIConfig } from '../aiConfig.js';
import { startServer, requiresCodex } from '../startup.js';

describe('startup-only Codex authentication gate', () => {
  let boot;
  let authState;
  let service;
  let serviceFactory;
  let openBrowser;
  let application;
  let loadApplication;
  let logger;
  beforeEach(() => {
    vi.clearAllMocks();
    authState = 'signed_out';
    service = {
      status: vi.fn(async () => ({ status: authState })),
      startLogin: vi.fn(async () => {
        authState = 'pending';
        return { status: authState };
      }),
      cancelLogin: vi.fn(async () => {
        authState = 'signed_out';
        return { status: authState };
      }),
      logout: vi.fn(async () => {
        authState = 'signed_out';
        return { status: authState };
      }),
      close: vi.fn(),
    };
    serviceFactory = vi.fn(() => service);
    openBrowser = vi.fn().mockResolvedValue(undefined);
    const router = express.Router();
    router.get('/', (req, res) => res.json({ status: 'ok' }));
    router.post('/test', (req, res) =>
      res.json({ analysis: 'normal application' }),
    );
    application = {
      router,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    loadApplication = vi.fn().mockResolvedValue(application);
    logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });
  afterEach(async () => {
    await boot?.close();
    boot = undefined;
  });

  async function launch(env = {}, overrides = {}) {
    boot = await startServer({
      config: getAIConfig({
        ANALYSIS_PROVIDER: 'codex',
        OPENAI_API_KEY: 'test-key',
        ...env,
      }),
      port: 0,
      host: '127.0.0.1',
      serviceFactory,
      openBrowser,
      loadApplication,
      logger,
      pollIntervalMs: 5,
      ...overrides,
    });
    return boot;
  }
  const base = () => `http://127.0.0.1:${boot.server.address().port}`;
  async function authAction(action) {
    const session = await (await fetch(`${base()}/auth/codex/session`)).json();
    return fetch(`${base()}/auth/codex/${action}`, {
      method: 'POST',
      headers: { Origin: base(), 'X-CSRF-Token': session.csrfToken },
    });
  }

  it.each([
    ['codex', false, 'openai', true],
    ['openai', true, 'codex', true],
    ['openai', false, 'codex', false],
    ['openai', true, 'openai', false],
  ])(
    'gates %s analysis / triage enabled %s / %s correctly',
    (analysisProvider, triageEnabled, triageProvider, required) => {
      expect(
        requiresCodex({ analysisProvider, triageEnabled, triageProvider }),
      ).toBe(required);
    },
  );

  it.each([
    {},
    {
      ANALYSIS_PROVIDER: 'openai',
      TRIAGE_ENABLED: 'true',
      TRIAGE_PROVIDER: 'codex',
    },
  ])(
    'defers all application imports/startup and opens the listening auth page once',
    async (env) => {
      openBrowser.mockImplementation(async (url) => {
        const page = await fetch(url.replace('localhost', '127.0.0.1'));
        expect(page.status).toBe(200);
      });
      await launch(env);
      await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledOnce());
      expect(openBrowser).toHaveBeenCalledWith(boot.authUrl);
      expect(service.status).toHaveBeenCalledWith({ refreshToken: true });
      expect(loadApplication).not.toHaveBeenCalled();
      expect(application.start).not.toHaveBeenCalled();
      for (const endpoint of ['/', '/messages', '/test', '/hook', '/tts']) {
        const response = await fetch(`${base()}${endpoint}`);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          status: 'waiting_for_codex_auth',
          authUrl: boot.authUrl,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(openBrowser).toHaveBeenCalledOnce();
      authState = 'connected';
      await boot.ready;
      expect(loadApplication).toHaveBeenCalledOnce();
      expect(application.start).toHaveBeenCalledOnce();
      expect(await (await fetch(base())).json()).toEqual({ status: 'ok' });
    },
  );

  it('uses the actual dynamic-import boundary, not only a deferred start function', async () => {
    await launch(
      {},
      { loadApplication: () => vi.importMock('../application.js') },
    );
    await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledOnce());
    expect(imported).not.toHaveBeenCalled();
    authState = 'connected';
    await boot.ready;
    expect(imported).toHaveBeenCalledOnce();
    expect(defaultStart).toHaveBeenCalledOnce();
  });

  it('starts immediately with a saved authenticated session without opening a browser', async () => {
    authState = 'connected';
    await launch();
    await boot.ready;
    expect(service.status).toHaveBeenCalledOnce();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(application.start).toHaveBeenCalledOnce();
  });

  it.each([
    { ANALYSIS_PROVIDER: 'openai' },
    {
      ANALYSIS_PROVIDER: 'openai',
      TRIAGE_ENABLED: 'false',
      TRIAGE_PROVIDER: 'codex',
    },
  ])('does not require Codex for OpenAI-only active stages', async (env) => {
    await launch(env);
    await boot.ready;
    expect(serviceFactory).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(application.start).toHaveBeenCalledOnce();
  });

  it('keeps mandatory startup auth available when optional post-startup UI is disabled', async () => {
    await launch({ ENABLE_CODEX_AUTH_UI: 'false' });
    expect((await fetch(`${base()}/auth/codex`)).status).toBe(200);
    authState = 'connected';
    await boot.ready;
    expect((await fetch(`${base()}/auth/codex`)).status).toBe(404);
  });

  it('stays paused through login, cancellation, status failure, expiration and retry', async () => {
    service.status.mockRejectedValueOnce(new Error('private transport output'));
    await launch();
    await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledOnce());
    expect((await authAction('login')).status).toBe(200);
    expect((await authAction('cancel')).status).toBe(200);
    authState = 'error';
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadApplication).not.toHaveBeenCalled();
    expect((await authAction('login')).status).toBe(200);
    authState = 'connected';
    await boot.ready;
    expect(application.start).toHaveBeenCalledOnce();
    expect(openBrowser).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(
      'private transport output',
    );
  });

  it('continues waiting with a manual URL if browser launch fails', async () => {
    openBrowser.mockRejectedValue(new Error('no desktop'));
    await launch();
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledOnce());
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(boot.authUrl),
    );
    expect(loadApplication).not.toHaveBeenCalled();
    authState = 'connected';
    await boot.ready;
  });

  it('does not wait for a slow desktop launcher once authentication succeeds', async () => {
    openBrowser.mockImplementation(() => new Promise(() => {}));
    await launch();
    await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledOnce());
    authState = 'connected';
    await boot.ready;
    expect(boot.state.phase).toBe('ready');
  });

  it('stops checking after readiness and does not pause or reinitialize on later sign-out', async () => {
    authState = 'connected';
    await launch();
    await boot.ready;
    const checks = service.status.mock.calls.length;
    await authAction('logout');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(service.status).toHaveBeenCalledTimes(checks);
    expect(boot.state.phase).toBe('ready');
    expect((await fetch(base())).status).toBe(200);
    expect(application.start).toHaveBeenCalledOnce();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('keeps endpoints gated until normal initialization completes', async () => {
    let finish;
    application.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    authState = 'connected';
    await launch();
    await vi.waitFor(() => expect(application.start).toHaveBeenCalledOnce());
    expect((await fetch(base())).status).toBe(503);
    finish();
    await boot.ready;
    expect((await fetch(base())).status).toBe(200);
  });

  it('reports startup failure without retrying initialization or logging raw dependency errors', async () => {
    application.start.mockRejectedValue(new Error('private dependency detail'));
    authState = 'connected';
    await launch();
    await expect(boot.ready).rejects.toThrow('private dependency detail');
    expect(boot.state.phase).toBe('error');
    expect((await fetch(base())).status).toBe(503);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'private dependency detail',
    );
    expect(application.start).toHaveBeenCalledOnce();
  });

  it('cancels a pending status request and closes the bootstrap idempotently', async () => {
    service.status.mockImplementation(() => new Promise(() => {}));
    await launch();
    await boot.close();
    await boot.close();
    await expect(boot.ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.close).toHaveBeenCalledOnce();
    expect(loadApplication).not.toHaveBeenCalled();
    expect(boot.server.listening).toBe(false);
  });

  it('does not overlap repeated status reads', async () => {
    let resolveStatus;
    service.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    await launch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.status).toHaveBeenCalledOnce();
    resolveStatus({ status: 'connected' });
    await boot.ready;
    expect(application.start).toHaveBeenCalledOnce();
  });
});
