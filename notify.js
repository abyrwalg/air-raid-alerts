import axios from 'axios';
import { shouldNotify } from './helpers/shouldNotify.js';

// Retain the named export for existing callers, but keep its implementation
// side-effect-free and directly importable without this delivery module.
export { shouldNotify };

async function speak(text) {
  const { default: textToSpeech } = await import('./tts.js');
  return textToSpeech(text);
}

export function createNotifier({
  post = (...args) => axios.post(...args),
  textToSpeech = speak,
  getConfig = () => ({
    webhookUrl: process.env.HA_WEBHOOK_URL,
    logsWebhookUrl: process.env.HA_LOGS_WEBHOOK_URL,
  }),
  logger = console,
} = {}) {
  return async function notify(analysis) {
    try {
      const { webhookUrl, logsWebhookUrl } = getConfig();
      // Preserve production logging for every supplied analysis, including
      // irrelevant/low-risk reports. Never do this inside the decision helper.
      // Logging remains best-effort and does not delay or suppress alerting.
      if (logsWebhookUrl && analysis) {
        void Promise.resolve()
          .then(() =>
            post(logsWebhookUrl, {
              text: JSON.stringify(analysis, null, 2),
            }),
          )
          .catch(() => logger.error('Error triggering logs webhook.'));
      }

      if (!shouldNotify(analysis)) return;
      const payload = {
        risk_level:
          analysis.risk_level[0].toUpperCase() + analysis.risk_level.slice(1),
        text: analysis.summary,
      };
      const tasks = [
        Promise.resolve().then(() => textToSpeech(analysis.summary)),
      ];
      if (webhookUrl)
        tasks.push(Promise.resolve().then(() => post(webhookUrl, payload)));
      else logger.warn('HA_WEBHOOK_URL is not set, skipping webhook call.');
      await Promise.all(tasks);
    } catch {
      // HTTP errors can contain full webhook URLs and request payloads.
      logger.error('Error triggering notification webhook or audio.');
    }
  };
}

export default createNotifier();
