import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config({ path: '.env.local' });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // baseURL: 'https://openrouter.ai/api/v1',
});

import {
  schema,
  prompt,
  threatAssessmentRules,
  triageQuestionName,
  triageThreshold,
  triageTimeoutMs,
} from './config.js';
import db from './db.js';

const isTriageEnabled =
  (process.env.ENABLE_OPENAI_TRIAGE || '').trim().toLowerCase() === 'true';

let queue = Promise.resolve();

function enqueue(taskFn) {
  const run = queue.then(() => taskFn());
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

async function generateResponseWithContext(message, messages, context) {
  const response = await openai.chat.completions.create({
    model: 'gpt-6-luna',
    messages: [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: `RECENT CONTEXT (previous messages):\n\n${context || '(none)'}\n\nCURRENT MESSAGE TO ANALYZE:\n\n${new Date().toISOString()}: ${message}`,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'ThreatAnalysis', schema },
    },
  });
  const parsedResult = JSON.parse(response.choices[0].message.content);
  if (parsedResult.relevant && parsedResult.risk_level !== 'none') {
    messages.insert({
      input: message,
      response: parsedResult,
      createdAt: new Date(),
    });
  }
  return parsedResult;
}

async function evaluateTriage(message, context) {
  const response = await openai.post('/decisions', {
    timeout: triageTimeoutMs,
    maxRetries: 0,
    body: {
      model: 'gpt-6-luna',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `THREAT ASSESSMENT RULES:\n${threatAssessmentRules}\n\nRECENT CONTEXT (previous messages):\n${context || '(none)'}\n\nCURRENT MESSAGE TO EVALUATE:\n${message}`,
            },
          ],
        },
      ],
      questions: [
        {
          type: 'predicate',
          name: triageQuestionName,
          instructions:
            'Under the threat assessment rules, does this current message warrant the full structured threat analysis? Return true for relevant danger information, updates, or uncertain potentially relevant threats; return false only for unrelated information, cancellation, or a confirmed duplicate with no meaningful new information.',
        },
      ],
    },
  });
  const answer = response.answers?.find(
    (item) => item.name === triageQuestionName,
  );
  if (
    !answer ||
    answer.type !== 'predicate' ||
    !Number.isFinite(answer.probability) ||
    answer.probability < 0 ||
    answer.probability > 1
  ) {
    throw new Error(
      'Decisions API returned a missing or invalid triage predicate.',
    );
  }
  return answer.probability;
}

export async function generateResponse(message) {
  return enqueue(async () => {
    try {
      const messages = db.getCollection('messages');
      return await generateResponseWithContext(
        message,
        messages,
        getRecentContext(messages),
      );
    } catch (error) {
      console.error('Error generating response from OpenAI:', error);
    }
  });
}

export async function evaluateMessage(message) {
  return enqueue(async () => {
    const messages = db.getCollection('messages');
    const context = getRecentContext(messages);
    let triage = {
      enabled: isTriageEnabled,
      status: 'disabled',
      probability: null,
    };
    if (isTriageEnabled) {
      try {
        const probability = await evaluateTriage(message, context);
        triage = { enabled: true, status: 'evaluated', probability };
        if (probability < triageThreshold) {
          return { triage: { ...triage, status: 'rejected' }, analysis: null };
        }
      } catch (error) {
        triage = { enabled: true, status: 'error_fallback', probability: null };
        console.error(
          'Decisions API triage failed; continuing with full analysis:',
          error,
        );
      }
    }
    try {
      return {
        triage,
        analysis: await generateResponseWithContext(message, messages, context),
      };
    } catch (error) {
      console.error('Error generating response from OpenAI:', error);
      return { triage, analysis: undefined };
    }
  });
}
