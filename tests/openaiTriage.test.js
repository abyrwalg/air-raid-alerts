import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { post, create, insert } = vi.hoisted(() => ({
  post: vi.fn(),
  create: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
vi.mock('openai', () => ({
  default: class OpenAI {
    constructor() {
      this.post = post;
      this.chat = { completions: { create } };
    }
  },
}));
vi.mock('../db.js', () => ({
  default: {
    getCollection: () => ({
      chain: () => ({
        where: () => ({
          simplesort: () => ({
            limit: () => ({ data: () => [] }),
          }),
        }),
      }),
      insert,
    }),
  },
}));

const analysis = {
  relevant: true,
  risk_level: 'medium',
  threat_type: 'cruise_missile',
  location_match: [],
  trajectory_threat: false,
  reason: 'test',
  summary: 'test',
  language: 'ru',
};

async function loadWithTriage(enabled) {
  vi.resetModules();
  vi.stubEnv('ENABLE_OPENAI_TRIAGE', enabled ? 'true' : 'false');
  return import('../openai.js');
}

describe('Decisions API triage', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(analysis) } }],
    });
  });

  it('is disabled by default and runs only full analysis', async () => {
    const { evaluateMessage } = await loadWithTriage(false);
    const result = await evaluateMessage('current alert');

    expect(result.triage).toMatchObject({ enabled: false, status: 'disabled' });
    expect(post).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });

  it('skips full analysis and persistence below 0.50', async () => {
    post.mockResolvedValue({
      answers: [
        { type: 'predicate', name: 'worth_full_analysis', probability: 0.49 },
      ],
    });
    const { evaluateMessage } = await loadWithTriage(true);
    const result = await evaluateMessage('current alert');

    expect(result).toMatchObject({
      triage: { status: 'rejected', probability: 0.49 },
      analysis: null,
    });
    expect(create).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(post.mock.calls[0][0]).toBe('/decisions');
    expect(post.mock.calls[0][1].body.model).toBe('gpt-6-luna');
    expect(post.mock.calls[0][1].body.input[0].content[0].text).toContain(
      'CURRENT MESSAGE TO EVALUATE:\ncurrent alert',
    );
  });

  it('continues at exactly 0.50 and uses the same current message in full analysis', async () => {
    post.mockResolvedValue({
      answers: [
        { type: 'predicate', name: 'worth_full_analysis', probability: 0.5 },
      ],
    });
    const { evaluateMessage } = await loadWithTriage(true);
    const result = await evaluateMessage('current alert');

    expect(result.triage).toMatchObject({
      status: 'evaluated',
      probability: 0.5,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].messages[1].content).toContain(
      'current alert',
    );
  });

  it('fails open for invalid answers and API errors', async () => {
    const { evaluateMessage } = await loadWithTriage(true);
    post
      .mockResolvedValueOnce({ answers: [] })
      .mockRejectedValueOnce(new Error('timeout'));

    const invalid = await evaluateMessage('first alert');
    const failed = await evaluateMessage('second alert');

    expect(invalid.triage.status).toBe('error_fallback');
    expect(failed.triage.status).toBe('error_fallback');
    expect(create).toHaveBeenCalledTimes(2);
  });
});
