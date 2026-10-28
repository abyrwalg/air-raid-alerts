import express from 'express';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { getAIConfig, validateAICredentials } from './aiConfig.js';
import { createCodexRouter } from './codex/routes.js';
import { getCodexService } from './codex/service.js';
import { openAuthPage } from './helpers/openBrowser.js';

export function requiresCodex(config) {
  return (
    config.analysisProvider === 'codex' ||
    (config.triageEnabled && config.triageProvider === 'codex')
  );
}

function abortError() {
  const error = new Error('Startup was cancelled.');
  error.name = 'AbortError';
  return error;
}

async function abortable(promise, signal) {
  if (signal.aborted) throw abortError();
  let onAbort;
  const cancelled = new Promise((resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function waitForCodex({
  service,
  signal,
  onWaiting = () => {},
  pollIntervalMs = 1000,
}) {
  let announced = false;
  while (!signal.aborted) {
    let authenticated = false;
    try {
      const status = await abortable(
        service.status({ refreshToken: true }),
        signal,
      );
      authenticated = status.status === 'connected';
    } catch {
      // Cannot establish readiness: fail closed, keeping auth/retry available.
    }
    if (signal.aborted) throw abortError();
    if (authenticated) return;
    if (!announced) {
      announced = true;
      onWaiting();
    }
    await delay(pollIntervalMs, undefined, { signal });
  }
  throw abortError();
}

// Do not import normal routes, Telegram, DB, notifications, or audio here.
export async function startServer({
  config = getAIConfig(),
  port = process.env.PORT || 4000,
  host,
  serviceFactory = getCodexService,
  openBrowser = openAuthPage,
  loadApplication = () => import('./application.js'),
  pollIntervalMs = 1000,
  logger = console,
} = {}) {
  validateAICredentials(config);
  const controller = new AbortController();
  const needsCodex = requiresCodex(config);
  const state = { phase: 'starting' };
  let service;
  let application;
  let normalRouter;
  let closing;
  const getService = () => (service ||= serviceFactory());
  const app = express();
  app.use(express.json());
  app.use(
    '/auth/codex',
    createCodexRouter({
      config: () => ({
        ...config,
        codexAuthEnabled:
          config.codexAuthEnabled || (needsCodex && state.phase !== 'ready'),
      }),
      service: getService,
    }),
  );
  const server = createServer(app);
  let authUrl;
  app.use((req, res, next) => {
    if (state.phase === 'ready') return normalRouter(req, res, next);
    res.set({ 'Cache-Control': 'no-store', 'Retry-After': '1' });
    return res.status(503).json({
      status: state.phase,
      message: ['waiting_for_codex_auth', 'checking_codex_auth'].includes(
        state.phase,
      )
        ? 'Startup is paused until Codex sign-in completes.'
        : 'The application is not ready.',
      ...(needsCodex ? { authUrl } : {}),
    });
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const actualPort = server.address().port;
  authUrl = `http://localhost:${actualPort}/auth/codex`;
  logger.log(`HTTP server listening on http://localhost:${actualPort}`);

  const ready = initialize().catch((error) => {
    if (!controller.signal.aborted) {
      state.phase = 'error';
      logger.error(
        'Normal application startup failed. Check configuration and dependency availability.',
      );
    }
    throw error;
  });
  ready.catch(() => {});

  async function initialize() {
    if (needsCodex) {
      state.phase = 'checking_codex_auth';
      await waitForCodex({
        service: getService(),
        signal: controller.signal,
        pollIntervalMs,
        onWaiting: () => {
          state.phase = 'waiting_for_codex_auth';
          logger.log(`Startup paused. Sign in to Codex: ${authUrl}`);
          // A slow/unavailable desktop launcher must not hold up login readiness.
          void Promise.resolve()
            .then(() => {
              if (!controller.signal.aborted) return openBrowser(authUrl);
            })
            .catch(() =>
              logger.warn(
                `Could not open the browser. Open this URL manually: ${authUrl}`,
              ),
            );
        },
      });
    }
    if (controller.signal.aborted) throw abortError();
    state.phase = 'initializing';
    application = await loadApplication();
    if (controller.signal.aborted) throw abortError();
    if (
      typeof application.router !== 'function' ||
      typeof application.start !== 'function'
    ) {
      throw new Error('Invalid application startup module.');
    }
    await application.start({ signal: controller.signal });
    if (controller.signal.aborted) throw abortError();
    normalRouter = application.router;
    state.phase = 'ready';
    logger.log('Application ready.');
    if (config.codexAuthEnabled) logger.log(`Codex sign-in: ${authUrl}`);
  }

  function close() {
    if (!closing) {
      controller.abort();
      state.phase = 'stopped';
      closing = (async () => {
        service?.close();
        try {
          await application?.stop?.();
        } finally {
          server.closeAllConnections?.();
          await new Promise((resolve) => server.close(resolve));
        }
      })();
    }
    return closing;
  }

  return { app, server, ready, close, state, authUrl };
}
