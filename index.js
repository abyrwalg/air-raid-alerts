import fs from 'fs';
import express from 'express';
import dotenv from 'dotenv';
import { StringSession } from 'teleproto/sessions/index.js';
import { TelegramClient, Api } from 'teleproto';
import readline from 'readline';
import createChannel from './helpers/createChannel.js';
import routes from './routes.js';
import qrcode from 'qrcode-terminal';
import processMessage from './helpers/processMessage.js';

dotenv.config({ path: '.env.local' });

const channels = [];

const app = express();
app.use(express.json());

app.use('/', routes);

const isPollingEnabled =
  (process.env.ENABLE_CHANNEL_POLLING || '').toLowerCase() === 'true';

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

  for (const username of CHANNELS) {
    try {
      const channel = await createChannel(username, client);
      if (channel) {
        channels.push(channel);
      }
    } catch (err) {
      console.error(`Failed to resolve channel ${username}:`, err);
    }
  }

  const channelIds = channels.map((ch) => ch.id);

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

    const channel = channels.find((ch) => ch.id === channelId);

    // If polling is enabled, process the message if it wasn't processed yet, and the channel is initialized
    // If polling is disabled, process all incoming messages
    if (
      (channel.lastMessageId &&
        msg.id.valueOf() > channel.lastMessageId &&
        channel.initialized) ||
      !isPollingEnabled
    ) {
      channel.lastMessageId = msg.id.valueOf();
      await processMessage(msg, channel, 'realtime');
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

    const user = await client.getMe();
    console.log(`Logged in as ${user.firstName} (${user.id.valueOf()})`);

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
