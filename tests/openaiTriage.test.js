import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prompt, threatAssessmentRules, triageTimeoutMs } from '../config.js';

const { post, create, insert, storedMessages } = vi.hoisted(() => ({
  post: vi.fn(),
  create: vi.fn(),
  insert: vi.fn(),
  storedMessages: [],
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
            limit: () => ({ data: () => storedMessages }),
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
    storedMessages.splice(0, storedMessages.length, {
      input: 'stored previous alert',
      createdAt: new Date(),
    });
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
    expect(create.mock.calls[0][0].messages[1].content).toContain(
      'stored previous alert',
    );
  });

  // These are mocked request-contract checks, not live-model accuracy tests.
  it('references shared assessment rules and sends only routing guidance without changing the main prompt', async () => {
    post.mockResolvedValue({
      answers: [
        { type: 'predicate', name: 'worth_full_analysis', probability: 0.8 },
      ],
    });
    const { evaluateMessage } = await loadWithTriage(true);
    await evaluateMessage('current alert');

    const request = post.mock.calls[0][1];
    const question = request.body.questions[0];
    expect(question).toMatchObject({
      type: 'predicate',
      name: 'worth_full_analysis',
    });
    for (const clause of [
      'Use the THREAT ASSESSMENT RULES supplied in the input',
      'CURRENT MESSAGE TO EVALUATE, using RECENT CONTEXT as directed',
      'Return true when the evidence supports medium/high risk',
      'a plausible medium/high assessment needs further analysis to resolve',
      'Return false when the message clearly falls within low or none risk',
      'Mere relevance or hypothetical danger is not sufficient to proceed',
      'This is a routing decision, not the final assessment',
      'A message that passes may still receive a low-risk result after full analysis',
    ]) {
      expect(question.instructions).toContain(clause);
    }
    // Detailed assessment rules belong in the shared input, not the question.
    for (const rule of threatAssessmentRules
      .split('\n')
      .filter((line) => line.startsWith('- '))) {
      expect(question.instructions).not.toContain(rule);
    }
    expect(request.body.input[0].content[0].text).toContain(
      `THREAT ASSESSMENT RULES:\n${threatAssessmentRules}`,
    );
    expect(request).toMatchObject({ timeout: triageTimeoutMs, maxRetries: 0 });
    expect(create.mock.calls[0][0].messages[0]).toEqual({
      role: 'system',
      content: prompt,
    });
  });

  it('uses explicitly supplied context instead of stored history for triage and analysis', async () => {
    post.mockResolvedValue({
      answers: [
        { type: 'predicate', name: 'worth_full_analysis', probability: 0.5 },
      ],
    });
    const { evaluateMessage } = await loadWithTriage(true);
    await evaluateMessage('current alert', {
      context: 'caller supplied context',
    });

    expect(post.mock.calls[0][1].body.input[0].content[0].text).toContain(
      'caller supplied context',
    );
    expect(post.mock.calls[0][1].body.input[0].content[0].text).not.toContain(
      'stored previous alert',
    );
    expect(create.mock.calls[0][0].messages[1].content).toContain(
      'caller supplied context',
    );
    expect(create.mock.calls[0][0].messages[1].content).not.toContain(
      'stored previous alert',
    );
    expect(insert).toHaveBeenCalledOnce();
  });

  it('supports empty context and gives ignoreContext precedence over supplied context', async () => {
    const { evaluateMessage } = await loadWithTriage(false);
    await evaluateMessage('first alert', { context: '' });
    await evaluateMessage('second alert', {
      context: 'must not be sent',
      ignoreContext: true,
    });

    const firstContent = create.mock.calls[0][0].messages[1].content;
    const secondContent = create.mock.calls[1][0].messages[1].content;
    expect(firstContent).toContain(
      'RECENT CONTEXT (previous messages):\n\n(none)',
    );
    expect(firstContent).not.toContain('stored previous alert');
    expect(secondContent).toContain(
      'RECENT CONTEXT (previous messages):\n\n(none)',
    );
    expect(secondContent).not.toContain('must not be sent');
    expect(insert).toHaveBeenCalledTimes(2);
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

  it('preserves a low-risk full analysis after triage passes', async () => {
    post.mockResolvedValue({
      answers: [
        { type: 'predicate', name: 'worth_full_analysis', probability: 0.6 },
      ],
    });
    const lowRiskAnalysis = { ...analysis, risk_level: 'low' };
    create.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(lowRiskAnalysis) } }],
    });
    const { evaluateMessage } = await loadWithTriage(true);
    const result = await evaluateMessage('ambiguous alert');

    expect(result.triage.status).toBe('evaluated');
    expect(result.analysis).toEqual(lowRiskAnalysis);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'ambiguous alert',
        response: lowRiskAnalysis,
      }),
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
