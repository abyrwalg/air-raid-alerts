import OpenAI from 'openai';
import { prompt, schema, triageQuestionName } from '../config.js';
import {
  buildTriageInput,
  triageInstructions,
  getTriageProbability,
} from './triage.js';

let client;
let clientKey;

function getClient(config) {
  if (!config.apiKey) throw new Error('OPENAI_API_KEY is required.');
  if (!client || clientKey !== config.apiKey) {
    client = new OpenAI({ apiKey: config.apiKey });
    clientKey = config.apiKey;
  }
  return client;
}

export async function analyzeWithOpenAI(content, config, logging = {}) {
  const request = {
    model: config.analysisModel,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'ThreatAnalysis', schema },
    },
  };
  const call = logging.recorder?.start({
    evaluationId: logging.evaluationId,
    provider: 'openai',
    task: 'analysis',
    model: config.analysisModel,
    request: {
      body: request,
      timeout: config.analysisTimeoutMs,
      maxRetries: 0,
    },
  });
  logging.onAnalysisCall?.(call);
  try {
    const response = await getClient(config).chat.completions.create(request, {
      timeout: config.analysisTimeoutMs,
      maxRetries: 0,
    });
    await call?.success(response, {
      usage: response.usage,
      providerRequestId: response._request_id,
    });
    return response.choices?.[0]?.message?.content;
  } catch (error) {
    await call?.failure(error);
    throw error;
  }
}

export async function evaluateTriage(message, context, config, logging = {}) {
  const request = {
    timeout: config.triageTimeoutMs,
    maxRetries: 0,
    body: {
      model: config.triageModel,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: buildTriageInput(message, context),
            },
          ],
        },
      ],
      questions: [
        {
          type: 'predicate',
          name: triageQuestionName,
          instructions: triageInstructions,
        },
      ],
    },
  };
  const call = logging.recorder?.start({
    evaluationId: logging.evaluationId,
    provider: 'openai',
    task: 'triage',
    model: config.triageModel,
    request: { path: '/decisions', ...request },
  });
  let response;
  try {
    response = await getClient(config).post('/decisions', request);
    const probability = getTriageProbability(response);
    await call?.success(response, { probability });
    return probability;
  } catch (error) {
    await call?.failure(error, response);
    throw error;
  }
}
