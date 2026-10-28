import { beforeEach, describe, expect, it, vi } from 'vitest';

const { create, post } = vi.hoisted(() => ({ create: vi.fn(), post: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    constructor() {
      this.chat = { completions: { create } };
      this.post = post;
    }
  },
}));

import { analyzeWithOpenAI, evaluateTriage } from '../providers/openai.js';

function recorderStub() {
  const call = { success: vi.fn(), failure: vi.fn() };
  return { recorder: { start: vi.fn(() => call) }, call };
}

describe('OpenAI request capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures the full analysis request/response and returns the same content', async () => {
    const response = {
      choices: [{ message: { content: '{"relevant":true}' } }],
      usage: { total_tokens: 12 },
      _request_id: 'request-1',
    };
    create.mockResolvedValue(response);
    const { recorder, call } = recorderStub();
    const result = await analyzeWithOpenAI(
      'full input',
      {
        apiKey: 'test-key',
        analysisModel: 'analysis-model',
        analysisTimeoutMs: 123,
      },
      { recorder, evaluationId: 'evaluation-1' },
    );
    expect(result).toBe('{"relevant":true}');
    expect(recorder.start).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluationId: 'evaluation-1',
        provider: 'openai',
        task: 'analysis',
        model: 'analysis-model',
        request: expect.objectContaining({
          timeout: 123,
          body: expect.objectContaining({
            messages: expect.arrayContaining([
              expect.objectContaining({ content: 'full input' }),
            ]),
          }),
        }),
      }),
    );
    expect(call.success).toHaveBeenCalledWith(
      response,
      expect.objectContaining({
        usage: response.usage,
        providerRequestId: 'request-1',
      }),
    );
  });

  it('captures failed Decisions triage without retaining the raw provider error', async () => {
    post.mockRejectedValue(new Error('private response body and token'));
    const { recorder, call } = recorderStub();
    await expect(
      evaluateTriage(
        'alert',
        '',
        {
          apiKey: 'test-key',
          triageModel: 'triage-model',
          triageTimeoutMs: 90,
        },
        { recorder, evaluationId: 'evaluation-2' },
      ),
    ).rejects.toThrow('private response body');
    expect(recorder.start).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'triage',
        evaluationId: 'evaluation-2',
        provider: 'openai',
      }),
    );
    expect(call.failure).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('private response body'),
      }),
      undefined,
    );
  });
});
