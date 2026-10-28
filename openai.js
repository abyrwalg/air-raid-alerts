import { getAIConfig, validateAICredentials } from './aiConfig.js';
import { analyzeWithOpenAI, evaluateTriage } from './providers/openai.js';
import { parseAnalysis } from './providers/validateAnalysis.js';
import db from './db.js';
import { randomUUID } from 'node:crypto';
import { getAiLogRecorder } from './aiLogs/runtime.js';

let queue = Promise.resolve();

function enqueue(taskFn) {
  const run = queue.then(taskFn);
  queue = run.catch(() => {});
  return run;
}

function getRecentContext(messages) {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return messages
    .chain()
    .where((m) => new Date(m.createdAt).getTime() >= oneHourAgo)
    .simplesort('createdAt')
    .limit(7)
    .data()
    .map((m) => `${new Date(m.createdAt).toISOString()}: ${m.input}`)
    .join('\n\n');
}

async function generateResponseWithContext(
  message,
  messages,
  context,
  config,
  logging = {},
) {
  let analysisCall;
  const callLogging = {
    ...logging,
    onAnalysisCall: (call) => {
      analysisCall = call;
    },
  };
  const content = `RECENT CONTEXT (previous messages):\n\n${context || '(none)'}\n\nCURRENT MESSAGE TO ANALYZE:\n\n${new Date().toISOString()}: ${message}`;
  let output;
  if (config.analysisProvider === 'codex') {
    const { getCodexService } = await import('./codex/service.js');
    output = await getCodexService().analyze(content, callLogging);
  } else {
    output = await analyzeWithOpenAI(content, config, callLogging);
  }
  let result;
  try {
    result = parseAnalysis(output);
  } catch (error) {
    await analysisCall?.annotate({ validationError: 'invalid_output' });
    throw error;
  }
  if (result.relevant && result.risk_level !== 'none') {
    messages.insert({
      input: message,
      response: result,
      createdAt: new Date(),
    });
  }
  return result;
}

export async function generateResponse(message) {
  return enqueue(async () => {
    const config = getAIConfig();
    validateAICredentials(config);
    try {
      const messages = db.getCollection('messages');
      const recorder = getAiLogRecorder();
      const evaluationId = randomUUID();
      return await generateResponseWithContext(
        message,
        messages,
        getRecentContext(messages),
        config,
        { recorder, evaluationId },
      );
    } catch {
      // Provider errors can embed requests or secrets; do not log raw SDK errors.
      console.error(
        `Error generating response from ${config.analysisProvider}. Check authentication, model access, and connectivity.`,
      );
    }
  });
}

export async function evaluateMessage(message, options = {}) {
  return enqueue(async () => {
    const config = getAIConfig();
    validateAICredentials(config);
    const messages = db.getCollection('messages');
    const recorder = getAiLogRecorder();
    const evaluationId = randomUUID();
    const context = options.ignoreContext
      ? ''
      : options.context !== undefined
        ? options.context
        : getRecentContext(messages);
    let triage = {
      enabled: config.triageEnabled,
      status: 'disabled',
      probability: null,
    };
    if (config.triageEnabled) {
      try {
        let probability;
        if (config.triageProvider === 'codex') {
          const { getCodexService } = await import('./codex/service.js');
          probability = recorder
            ? await getCodexService().evaluateTriage(message, context, {
                recorder,
                evaluationId,
              })
            : await getCodexService().evaluateTriage(message, context);
        } else {
          probability = await evaluateTriage(message, context, config, {
            recorder,
            evaluationId,
          });
        }
        triage = { enabled: true, status: 'evaluated', probability };
        if (probability < config.triageThreshold) {
          return { triage: { ...triage, status: 'rejected' }, analysis: null };
        }
      } catch {
        triage = { enabled: true, status: 'error_fallback', probability: null };
        console.error(
          `${config.triageProvider} triage failed; continuing with the configured analysis provider.`,
        );
      }
    }
    try {
      return {
        triage,
        analysis: await generateResponseWithContext(
          message,
          messages,
          context,
          config,
          { recorder, evaluationId },
        ),
      };
    } catch {
      console.error(
        `Error generating response from ${config.analysisProvider}. Check authentication, model access, and connectivity${config.analysisProvider === 'codex' ? '; sign in at /auth/codex if needed' : ''}.`,
      );
      return { triage, analysis: undefined };
    }
  });
}
