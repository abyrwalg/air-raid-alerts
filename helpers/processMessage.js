import { primaryFilter, excludeFilter } from '../config.js';
import { generateResponse } from '../openai.js';
import notify from '../notify.js';

export default async function processMessage(message, channel, source) {
  try {
    const channelName = channel.name;
    let text = message.message || '';
    const date = message.date
      ? new Date(message.date * 1000).toLocaleString('en-GB', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : null;

    if (
      new RegExp(primaryFilter).test(text) &&
      !new RegExp(excludeFilter).test(text)
    ) {
      console.log(`MATCHED MESSAGE FROM ${channelName} (${source}):`);
      console.log(`${date}\n${text}`);
      console.log('Generating analysis...');
      const analysis = await generateResponse(text);
      console.log('Analysis Result:', analysis);
      console.log('---------------------');
      await notify(analysis);
    } else {
      console.log(`SKIPPED MESSAGE FROM ${channelName} (${source}):`);
      console.log(`${date}\n${text}`);
      console.log('---------------------');
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
}
