import dotenv from 'dotenv';
import axios from 'axios';

import textToSpeech from './tts.js';
import isNowBetween from './helpers/isNowBetween.js';

dotenv.config({ path: '.env.local' });

const webhookUrl = process.env.HA_WEBHOOK_URL;

export const shouldNotify = (analysis) => {
  if (!analysis || !analysis.relevant) {
    console.log(
      'Risk is not relevant or analysis.relevant missing, notification skipped.',
    );
    return false;
  }

  if (analysis.risk_level === 'none' || analysis.risk_level === 'low') {
    console.log('Risk level is none or low, no notification needed.');
    return false;
  }

  if (analysis.risk_level === 'high') {
    return true;
  }

  if (analysis.risk_level === 'medium') {
    const startTime = '08:00';
    const endTime = '22:00';

    const isAllowedTime = isNowBetween(startTime, endTime);

    if (isAllowedTime) {
      return true;
    } else {
      console.log(
        'Current time is outside allowed notification window for medium risk, notification skipped.',
      );
      return false;
    }
  }

  return false;
};

export default async function notify(analysis) {
  try {
    if (shouldNotify(analysis)) {
      const payload = {
        risk_level:
          analysis.risk_level[0].toUpperCase() + analysis.risk_level.slice(1),
        text: analysis.summary,
      };

      const promises = [];
      promises.push(textToSpeech(analysis.summary));

      if (webhookUrl) {
        promises.push(axios.post(webhookUrl, payload));
      } else {
        console.warn('HA_WEBHOOK_URL is not set, skipping webhook call.');
      }

      await Promise.all(promises);
    }
  } catch (error) {
    console.error('Error triggering webhook:', error);
  }
}
