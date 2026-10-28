import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, evaluateMessage } = vi.hoisted(() => ({
  handlers: {},
  evaluateMessage: vi.fn(),
}));

vi.mock('express', () => ({
  default: {
    Router: () => ({
      use: vi.fn(),
      get: vi.fn(),
      post: vi.fn((path, handler) => {
        handlers[path] = handler;
      }),
    }),
  },
}));
vi.mock('axios', () => ({ default: { post: vi.fn() } }));
vi.mock('../openai.js', () => ({ evaluateMessage }));
vi.mock('../tts.js', () => ({ default: vi.fn() }));
vi.mock('../config.js', () => ({
  primaryFilter: '.*',
  excludeFilter: 'never-match-this',
}));
vi.mock('../db.js', () => ({ default: { getCollection: vi.fn() } }));

async function invokeTest(body) {
  const response = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
  await handlers['/test']({ body }, response);
  return response;
}

describe('/test route context options', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    Object.keys(handlers).forEach((path) => delete handlers[path]);
    evaluateMessage.mockResolvedValue({ triage: {}, analysis: {} });
    await import('../routes.js');
  });

  it('forwards custom context and ignoreContext', async () => {
    await invokeTest({
      text: 'current alert',
      context: 'caller context',
      ignoreContext: false,
    });

    expect(evaluateMessage).toHaveBeenCalledWith('current alert', {
      context: 'caller context',
      ignoreContext: false,
    });
  });

  it('uses provider-neutral wording when either triage provider rejects', async () => {
    evaluateMessage.mockResolvedValue({
      triage: { status: 'rejected', probability: 0.1 },
      analysis: null,
    });
    const response = await invokeTest({ text: 'current alert' });
    expect(response.body).toMatchObject({ matched: true, skipped: true });
    expect(response.body.message).toBe(
      'Triage rejected the message — full analysis skipped.',
    );
  });

  it.each([
    [{ text: 'current alert', context: 5 }, 'context'],
    [{ text: 'current alert', ignoreContext: 'true' }, 'ignoreContext'],
  ])('rejects invalid %s types', async (body, field) => {
    const response = await invokeTest(body);

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toContain(field);
    expect(evaluateMessage).not.toHaveBeenCalled();
  });
});
