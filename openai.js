import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config({ path: '.env.local' });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // baseURL: 'https://openrouter.ai/api/v1',
});

import { schema, prompt } from './config.js';
import db from './db.js';

let queue = Promise.resolve();

function enqueue(taskFn) {
  const run = queue.then(() => taskFn());
  queue = run.catch(() => {});
  return run;
}

export async function generateResponse(message) {
  return enqueue(async () => {
    try {
      const messages = db.getCollection('messages');
      const oneHourAgo = Date.now() - 60 * 60 * 1000;

      /* const lastContext = messages
        .chain()
        .where((m) => new Date(m.createdAt).getTime() >= oneHourAgo)
        .simplesort('createdAt')
        .limit(7)
        .data()
        .map((m) => ({
          role: 'user',
          content: `${new Date(m.createdAt).toISOString()}: ${m.input}`,
        })); */

      const context = messages
        .chain()
        .where((m) => new Date(m.createdAt).getTime() >= oneHourAgo)
        .simplesort('createdAt')
        .limit(7)
        .data()
        .map((m) => `${new Date(m.createdAt).toISOString()}: ${m.input}`)
        .join('\n\n');

      const response = await openai.chat.completions.create({
        model: 'gpt-6-luna',
        /* messages: [
          { role: 'system', content: prompt },
          ...lastContext,
          { role: 'user', content: `${new Date().toISOString()}: ${message}` },
        ], */
        messages: [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: `
            RECENT CONTEXT (previous messages):

            ${context || '(none)'}

            CURRENT MESSAGE TO ANALYZE:

            ${new Date().toISOString()}: ${message}
            `.trim(),
          },
        ],
        //  max_tokens: 4096,
        /* provider: {
          ignore: ['digitalocean', 'deepinfra/fp8', 'atlas-cloud/fp8'],
        }, */
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'ThreatAnalysis',
            schema,
          },
        },
      });

      const result = response.choices[0].message;
      const parsedResult = JSON.parse(result.content);

      // Save if relevant
      if (parsedResult.relevant && parsedResult.risk_level !== 'none') {
        messages.insert({
          input: message,
          response: parsedResult,
          createdAt: new Date(),
        });
      }

      return parsedResult;
    } catch (error) {
      console.error('Error generating response from OpenAI:', error);
    }
  });
}
