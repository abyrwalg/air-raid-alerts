import { getAIConfig, validateAICredentials } from './aiConfig.js';
import { analyzeWithOpenAI, evaluateTriage } from './providers/openai.js';
import { parseAnalysis } from './providers/validateAnalysis.js';
import db from './db.js';

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

async function generateResponseWithContext(message, messages, context, config) {
  const content = `RECENT CONTEXT (previous messages):\n\n${context || '(none)'}\n\nCURRENT MESSAGE TO ANALYZE:\n\n${new Date().toISOString()}: ${message}`;
  let output;
  if (config.analysisProvider === 'codex') {
    const { getCodexService } = await import('./codex/service.js');
    output = await getCodexService().analyze(content);
  } else {
    output = await analyzeWithOpenAI(content, config);
  }
  const result = parseAnalysis(output);
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
      return await generateResponseWithContext(
        message,
        messages,
        getRecentContext(messages),
        config,
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
          probability = await getCodexService().evaluateTriage(
            message,
            context,
          );
        } else {
          probability = await evaluateTriage(message, context, config);
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
