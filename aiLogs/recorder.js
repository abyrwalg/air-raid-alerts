import { randomUUID } from 'node:crypto';

const sensitiveKey =
  /(?:api.?key|authorization|access.?token|refresh.?token|password|secret|credential|cookie)/i;

export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitiveKey.test(key))
      .map(([key, child]) => [key, sanitize(child)]),
  );
}

export class AiLogRecorder {
  constructor({ store, logger = console, clock = Date.now }) {
    this.store = store;
    this.logger = logger;
    this.clock = clock;
    this.warned = false;
  }

  start({ evaluationId, provider, task, model, request }) {
    const startedMs = this.clock();
    const entry = {
      id: randomUUID(),
      evaluationId,
      provider,
      task,
      model: model || 'provider-default',
      status: 'in_progress',
      startedAt: new Date(startedMs).toISOString(),
      durationMs: null,
      request: sanitize(request),
      response: null,
      error: null,
    };
    const save = (patch) => {
      const finishedMs = this.clock();
      Object.assign(entry, patch, {
        durationMs: finishedMs - startedMs,
        finishedAt: new Date(finishedMs).toISOString(),
      });
      return this.safeSave(entry);
    };
    void this.safeSave(entry);
    return {
      id: entry.id,
      success: (response, metadata = {}) =>
        save({
          status: 'success',
          response: sanitize(response),
          ...sanitize(metadata),
        }),
      failure: (error, response) =>
        save({
          status: 'error',
          ...(response === undefined ? {} : { response: sanitize(response) }),
          error: { category: safeErrorCategory(error) },
        }),
      annotate: (patch) => {
        Object.assign(entry, sanitize(patch));
        return this.safeSave(entry);
      },
    };
  }

  async safeSave(entry) {
    try {
      await this.store.upsert({ ...entry });
    } catch {
      if (!this.warned) {
        this.warned = true;
        this.logger.error(
          'AI request logging failed; inference will continue, but this call may not appear in local logs.',
        );
      }
    }
  }
}

export function safeErrorCategory(error) {
  if (
    error?.name === 'APIConnectionTimeoutError' ||
    /timed out/i.test(error?.message || '')
  )
    return 'timeout';
  if (error?.status === 401 || error?.status === 403) return 'authentication';
  if (Number.isInteger(error?.status) && error.status >= 400)
    return `provider_http_${error.status}`;
  if (/invalid|schema|parse/i.test(error?.name || '')) return 'invalid_output';
  return 'provider_error';
}
