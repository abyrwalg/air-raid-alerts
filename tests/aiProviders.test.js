import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  create,
  post,
  analyze,
  codexTriage,
  insert,
  construct,
  storedMessages,
} = vi.hoisted(() => ({
  create: vi.fn(),
  post: vi.fn(),
  analyze: vi.fn(),
  codexTriage: vi.fn(),
  insert: vi.fn(),
  construct: vi.fn(),
  storedMessages: [],
}));
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
vi.mock('openai', () => ({
  default: class {
    constructor(options) {
      construct(options);
      this.chat = { completions: { create } };
      this.post = post;
    }
  },
}));
vi.mock('../codex/service.js', () => ({
  getCodexService: () => ({ analyze, evaluateTriage: codexTriage }),
}));
vi.mock('../db.js', () => ({
  default: {
    getCollection: () => ({
      chain: () => ({
        where: () => ({
          simplesort: () => ({
            limit: () => ({
              data: () => storedMessages,
            }),
          }),
        }),
      }),
      insert,
    }),
  },
}));
const analysis = {
  relevant: true,
  risk_level: 'high',
  threat_type: 'unknown',
  location_match: [],
  trajectory_threat: false,
  reason: 'test',
  summary: 'test',
  language: 'ru',
};

async function load(
  provider = 'codex',
  triage = false,
  key = '',
  triageProvider = 'openai',
) {
  vi.resetModules();
  vi.stubEnv('ANALYSIS_PROVIDER', provider);
  vi.stubEnv('TRIAGE_ENABLED', String(triage));
  vi.stubEnv('OPENAI_API_KEY', key);
  vi.stubEnv('TRIAGE_PROVIDER', triageProvider);
  return import('../openai.js');
}

describe('analysis provider routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insert.mockReset();
    storedMessages.splice(0, storedMessages.length, {
      input: 'database context',
      createdAt: new Date(),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    analyze.mockResolvedValue(JSON.stringify(analysis));
    codexTriage.mockResolvedValue(0.8);
    create.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(analysis) } }],
    });
    post.mockResolvedValue({
      answers: [
        { type: 'predicate', name: 'worth_full_analysis', probability: 0.8 },
      ],
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('runs Codex without constructing OpenAI or requiring an API key', async () => {
    const { evaluateMessage } = await load();
    const result = await evaluateMessage('current alert');
    expect(result).toMatchObject({
      analysis,
      triage: { enabled: false, status: 'disabled' },
    });
    expect(analyze).toHaveBeenCalledOnce();
    expect(analyze.mock.calls[0][0]).toContain('database context');
    expect(construct).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledOnce();
  });

  it('supports API-key triage before Codex, without OpenAI full analysis', async () => {
    const { evaluateMessage } = await load('codex', true, 'triage-key');
    expect((await evaluateMessage('current alert')).analysis).toEqual(analysis);
    expect(construct).toHaveBeenCalledWith({ apiKey: 'triage-key' });
    expect(post).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(analyze).toHaveBeenCalledOnce();
  });

  it.each([
    ['openai', 'openai'],
    ['openai', 'codex'],
    ['codex', 'openai'],
    ['codex', 'codex'],
  ])(
    'preserves channel attribution through %s analysis, %s triage, and later context',
    async (provider, triageProvider) => {
      insert.mockImplementation((message) => storedMessages.push(message));
      const { evaluateMessage } = await load(
        provider,
        true,
        'key',
        triageProvider,
      );
      const first = 'Telegram channel: @first_source\n\nСміла уважно';
      const second = 'Telegram channel: @second_source\n\nРакета змінила курс';

      await evaluateMessage(first);
      await evaluateMessage(second);

      expect(insert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ input: first }),
      );
      expect(insert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ input: second }),
      );
      const analysisInputs =
        provider === 'codex'
          ? analyze.mock.calls.map(([content]) => content)
          : create.mock.calls.map(([request]) => request.messages[1].content);
      const triageInputs =
        triageProvider === 'codex'
          ? codexTriage.mock.calls.map(([message, context]) => ({
              message,
              context,
            }))
          : post.mock.calls.map(([, request]) => ({
              message: request.body.input[0].content[0].text,
              context: request.body.input[0].content[0].text,
            }));

      expect(analysisInputs[0]).toContain(`CURRENT MESSAGE TO ANALYZE:\n\n`);
      expect(analysisInputs[0]).toContain(first);
      expect(triageInputs[0].message).toContain(first);
      expect(analysisInputs[0]).toContain('database context');
      expect(triageInputs[0].context).toContain('database context');
      expect(analysisInputs[0]).not.toContain('@second_source');
      expect(analysisInputs[1]).toContain(first);
      expect(analysisInputs[1]).toContain(second);
      expect(triageInputs[1].context).toContain(first);
      expect(triageInputs[1].message).toContain(second);
      expect(analysisInputs[1].indexOf(first)).toBeLessThan(
        analysisInputs[1].indexOf('CURRENT MESSAGE TO ANALYZE:'),
      );
      expect(analysisInputs[1].indexOf(second)).toBeGreaterThan(
        analysisInputs[1].indexOf('CURRENT MESSAGE TO ANALYZE:'),
      );
    },
  );

  it('skips Codex when triage rejects', async () => {
    post.mockResolvedValue({
      answers: [
        { type: 'predicate', name: 'worth_full_analysis', probability: 0.1 },
      ],
    });
    const { evaluateMessage } = await load('codex', true, 'key');
    expect(await evaluateMessage('alert')).toMatchObject({
      analysis: null,
      triage: { status: 'rejected' },
    });
    expect(analyze).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('fails open to Codex, not OpenAI, when triage fails', async () => {
    post.mockRejectedValue(new Error('private details'));
    const { evaluateMessage } = await load('codex', true, 'key');
    expect(await evaluateMessage('alert')).toMatchObject({
      analysis,
      triage: { status: 'error_fallback' },
    });
    expect(analyze).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(console.error.mock.calls.flat().join(' ')).not.toContain(
      'private details',
    );
  });

  it('supports OpenAI with or without triage and separate model settings', async () => {
    vi.stubEnv('ANALYSIS_MODEL', 'analysis-model');
    vi.stubEnv('ANALYSIS_TIMEOUT_MS', '42000');
    vi.stubEnv('TRIAGE_MODEL', 'routing-model');
    vi.stubEnv('TRIAGE_THRESHOLD', '0.7');
    vi.stubEnv('TRIAGE_TIMEOUT_MS', '5000');
    const { evaluateMessage } = await load('openai', true, 'key');
    await evaluateMessage('alert');
    expect(post.mock.calls[0][1]).toMatchObject({
      body: { model: 'routing-model' },
      timeout: 5000,
    });
    expect(create.mock.calls[0][0].model).toBe('analysis-model');
    expect(create.mock.calls[0][1]).toEqual({ timeout: 42000, maxRetries: 0 });
    expect(analyze).not.toHaveBeenCalled();
  });

  it('checks required credentials before sending triage or analysis', async () => {
    const { evaluateMessage } = await load('codex', true);
    await expect(evaluateMessage('alert')).rejects.toThrow('OPENAI_API_KEY');
    expect(post).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });

  it('uses explicit and empty context, with ignoreContext taking precedence', async () => {
    const { evaluateMessage } = await load();
    await evaluateMessage('first', { context: 'custom context' });
    await evaluateMessage('second', { context: '' });
    await evaluateMessage('third', {
      context: 'do not send',
      ignoreContext: true,
    });
    expect(analyze.mock.calls[0][0]).toContain('custom context');
    expect(analyze.mock.calls[1][0]).toContain('(none)');
    expect(analyze.mock.calls[2][0]).toContain('(none)');
    for (const [content] of analyze.mock.calls) {
      expect(content).not.toContain('database context');
      expect(content).not.toContain('do not send');
    }
  });

  it('routes the legacy entry point through Codex too', async () => {
    const { generateResponse } = await load();
    expect(await generateResponse('alert')).toEqual(analysis);
    expect(analyze).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('serializes requests and recovers after a provider failure without fallback', async () => {
    let rejectFirst;
    analyze.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const { evaluateMessage } = await load();
    const first = evaluateMessage('first');
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    const second = evaluateMessage('second');
    expect(analyze).toHaveBeenCalledOnce();
    rejectFirst(new Error('token must not be logged'));
    expect((await first).analysis).toBeUndefined();
    expect((await second).analysis).toEqual(analysis);
    expect(create).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledOnce();
    expect(console.error.mock.calls.flat().join(' ')).not.toContain(
      'token must not be logged',
    );
  });

  it('does not persist malformed output or irrelevant results', async () => {
    analyze.mockResolvedValueOnce('{"relevant":true}').mockResolvedValueOnce(
      JSON.stringify({
        ...analysis,
        relevant: false,
        risk_level: 'none',
      }),
    );
    const { evaluateMessage } = await load();
    expect((await evaluateMessage('bad')).analysis).toBeUndefined();
    expect((await evaluateMessage('irrelevant')).analysis.relevant).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  it.each(['openai', 'codex'])(
    'supports Codex triage before %s analysis',
    async (provider) => {
      const key = provider === 'openai' ? 'analysis-key' : '';
      const { evaluateMessage } = await load(provider, true, key, 'codex');
      expect(await evaluateMessage('current alert')).toMatchObject({
        analysis,
        triage: { status: 'evaluated', probability: 0.8 },
      });
      expect(codexTriage).toHaveBeenCalledExactlyOnceWith(
        'current alert',
        expect.stringContaining('database context'),
      );
      expect(post).not.toHaveBeenCalled();
      if (provider === 'codex') {
        expect(construct).not.toHaveBeenCalled();
        expect(analyze).toHaveBeenCalledOnce();
      } else {
        expect(create).toHaveBeenCalledOnce();
        expect(analyze).not.toHaveBeenCalled();
      }
      expect(insert).toHaveBeenCalledOnce();
    },
  );

  it.each([0, 0.49, 0.5, 1])(
    'applies the existing threshold to Codex probability %s',
    async (probability) => {
      codexTriage.mockResolvedValue(probability);
      const { evaluateMessage } = await load('codex', true, '', 'codex');
      const result = await evaluateMessage('alert');
      expect(result.triage.status).toBe(
        probability < 0.5 ? 'rejected' : 'evaluated',
      );
      expect(analyze).toHaveBeenCalledTimes(probability < 0.5 ? 0 : 1);
      expect(insert).toHaveBeenCalledTimes(probability < 0.5 ? 0 : 1);
    },
  );

  it.each(['openai', 'codex'])(
    'fails open to %s analysis when Codex triage fails',
    async (provider) => {
      codexTriage.mockRejectedValue(
        new Error('Codex triage timed out: private details'),
      );
      const { evaluateMessage } = await load(
        provider,
        true,
        provider === 'openai' ? 'key' : '',
        'codex',
      );
      expect(await evaluateMessage('alert')).toMatchObject({
        analysis,
        triage: { status: 'error_fallback' },
      });
      expect(post).not.toHaveBeenCalled();
      expect(console.error.mock.calls.flat().join(' ')).not.toContain(
        'private details',
      );
    },
  );

  it('passes the same explicit or suppressed context to Codex triage and analysis', async () => {
    const { evaluateMessage } = await load('codex', true, '', 'codex');
    await evaluateMessage('first', { context: 'caller context' });
    await evaluateMessage('second', { context: '' });
    await evaluateMessage('third', {
      context: 'must not send',
      ignoreContext: true,
    });
    expect(codexTriage.mock.calls).toEqual([
      ['first', 'caller context'],
      ['second', ''],
      ['third', ''],
    ]);
    expect(analyze.mock.calls[0][0]).toContain('caller context');
    expect(analyze.mock.calls[1][0]).toContain('(none)');
    expect(analyze.mock.calls[2][0]).not.toContain('must not send');
  });

  it('does not run configured Codex triage when disabled', async () => {
    const { evaluateMessage } = await load('openai', false, 'key', 'codex');
    expect((await evaluateMessage('alert')).triage.status).toBe('disabled');
    expect(codexTriage).not.toHaveBeenCalled();
  });
});
