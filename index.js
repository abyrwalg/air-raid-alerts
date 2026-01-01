import fs from 'fs';
import express from 'express';
import dotenv from 'dotenv';
import { StringSession } from 'telegram/sessions/index.js';
import { TelegramClient, Api } from 'telegram';
import readline from 'readline';
import { primaryFilter, excludeFilter } from './config.js';
import { generateResponse } from './openai.js';
import notify from './notify.js';
import routes from './routes.js';
import qrcode from 'qrcode-terminal';

dotenv.config({ path: '.env.local' });

const app = express();
app.use(express.json());

app.use('/', routes);

const CHANNELS = process.env.TG_CHANNELS
  ? process.env.TG_CHANNELS.split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  : [];

if (CHANNELS.length === 0) {
  console.warn(
    'No TG_CHANNELS found in .env.local — no channels will be monitored.'
  );
}

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const existingSession = process.env.TG_SESSION || '';
const session = new StringSession(existingSession);

async function startListener(client) {
  console.log('Subscribing to channels...');

  // Resolve channels to entity objects
  const entities = [];
  for (const username of CHANNELS) {
    try {
      const entity = await client.getEntity(username);
      entities.push(entity);
      console.log(`Listening to: @${username}`);
    } catch (err) {
      console.error(`Failed to resolve channel ${username}:`, err);
    }
  }

  const channelIds = entities.map((e) => e.id.valueOf());

  // MAIN EVENT HANDLER
  client.addEventHandler(async (update) => {
    if (
      !(update instanceof Api.UpdateNewChannelMessage) &&
      !(update instanceof Api.UpdateNewMessage)
    ) {
      return;
    }

    const msg = update.message;
    if (!msg || !msg.peerId) {
      return;
    }

    // Only handle messages from monitored channels
    if (msg.peerId.className !== 'PeerChannel') {
      return;
    }

    const channelId = msg.peerId.channelId.valueOf();
    if (!channelIds.includes(channelId)) {
      return;
    }

    const text = msg.message;
    if (!text || !text.trim()) {
      return;
    }

    const channel = entities.find((e) => e.id.valueOf() === channelId);
    const channelName = channel ? `@${channel.username}` : `ID ${channelId}`;

    if (
      new RegExp(primaryFilter).test(text) &&
      !new RegExp(excludeFilter).test(text)
    ) {
      console.log(`MATCHED MESSAGE FROM ${channelName}:`);
      console.log(text);
      console.log('Generating analysis...');
      const analysis = await generateResponse(text);
      console.log('Analysis Result:', analysis);
      console.log('---------------------');
      await notify(analysis);
    } else {
      console.log(`SKIPPED MESSAGE FROM ${channelName}:`);
      console.log(text);
      console.log('---------------------');
    }
  });

  console.log('Listening for updates...');
}

function saveSessionToEnv(newSession) {
  const envPath = '.env.local';
  let content = '';

  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
    content = content.replace(/^TG_SESSION=.*$/m, '').trim();
    content += '\n';
  }

  content += `TG_SESSION="${newSession}"\n`;
  fs.writeFileSync(envPath, content);

  console.log('Saved new TG_SESSION to .env');
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function initTelegram() {
  try {
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      retryDelay: 2000,
      onDisconnect: (error) => {
        console.error('Disconnected:', error);
      },
      onConnect: () => {
        console.log('Reconnected.');
      },
    });

    if (existingSession.trim()) {
      console.log('Using existing session from .env — skipping auth.');
      await client.connect();
    } else {
      console.log('No session detected — running authentication...');

      /* await client.start({
        phoneNumber: async () => await ask('Phone: '),
        password: async () => await ask('2FA password: '),
        phoneCode: async () => await ask('Telegram code: '),
        onError: (err) => console.error(err),
      }); */

      await client.connect();

      await client.signInUserWithQrCode(
        { apiId, apiHash },
        {
          qrCode: async (code) => {
            const url = `tg://login?token=${code.token.toString('base64url')}`;
            console.log('\nScan this QR in Telegram mobile:');
            console.log(
              'Telegram → Settings → Devices → Link Desktop Device\n'
            );
            qrcode.generate(url, { small: true });
          },
          password: async (hint) =>
            await ask(`2FA password${hint ? ` (hint: ${hint})` : ''}: `),
          onError: async (err) => {
            console.error('QR login error:', err);
            return true; // stop auth on error
          },
        }
      );

      console.log('Logged in!');

      const newSession = client.session.save();
      saveSessionToEnv(newSession);
    }

    console.log('Telegram client is ready.');
    return client;
  } catch (error) {
    console.error('Failed to initialize Telegram client:', error);
  }
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`HTTP test server running on http://localhost:${PORT}`);
});

const client = await initTelegram();
await startListener(client);
