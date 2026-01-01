import express from 'express';

import axios from 'axios';

import { generateResponse } from './openai.js';
import textToSpeech from './tts.js';
import { primaryFilter, excludeFilter } from './config.js';
import db from './db.js';

const router = express.Router();

// Simple health check
router.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

// Test endpoint
router.post('/test', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid text field.' });
    }

    const matched =
      new RegExp(primaryFilter).test(text) &&
      !new RegExp(excludeFilter).test(text);

    if (!matched) {
      return res.json({
        matched: false,
        message: 'Filter not matched — skipping.',
        text,
      });
    }

    const analysis = await generateResponse(text);

    //  await webhookTrigger(analysis);

    // await textToSpeech(analysis.summary);

    return res.json({
      matched: true,
      input: text,
      analysis,
    });
  } catch (err) {
    console.error('Error in /test:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// Get messages from store
router.get('/messages', (req, res) => {
  const messages = db.getCollection('messages');
  const all = messages.chain().simplesort('createdAt').data();

  res.json(all);
});

// Test tts
router.post('/tts', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid text field.' });
    }

    textToSpeech(text)
      .then(() => {
        console.log('TTS playback finished.');
      })
      .catch((err) => {
        console.error('Error during TTS playback:', err);
      });

    return res.json({ status: 'ok', text });
  } catch (err) {
    console.error('Error in /tts:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

router.get('/messages/last', (req, res) => {
  const messages = db.getCollection('messages');

  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  const lastHourMessages = messages
    .chain()
    .where((m) => new Date(m.createdAt).getTime() >= oneHourAgo)
    .simplesort('createdAt', true)
    .limit(7)
    .data();

  res.json(lastHourMessages);
});

router.post('/hook', async (req, res) => {
  try {
    const webhookUrl = process.env.HA_WEBHOOK_URL;

    if (webhookUrl) {
      await axios.post(webhookUrl, {
        risk_level: 'TEST',
        text:
          req.body.text || 'This is a test notification from Air Raid Alerts.',
      });
    }

    return res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error in /hook:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
