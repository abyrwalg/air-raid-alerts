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

export async function analyzeWithOpenAI(content, config) {
  const response = await getClient(config).chat.completions.create(
    {
      model: config.analysisModel,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'ThreatAnalysis', schema },
      },
    },
    { timeout: config.analysisTimeoutMs, maxRetries: 0 },
  );
  return response.choices?.[0]?.message?.content;
}

export async function evaluateTriage(message, context, config) {
  const response = await getClient(config).post('/decisions', {
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
  });
  return getTriageProbability(response);
}
