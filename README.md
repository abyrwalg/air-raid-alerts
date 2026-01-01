# Air Raid Alerts

> A lightweight Telegram-based alert analyzer for Smila / Cherkasy region (Ukraine). Monitors Telegram channels, filters messages for missile/drone-related content, uses OpenAI to analyze relevance/risk, and forwards notifications (including Home Assistant webhook integration and TTS).

**Project status:** Prototype — use with caution and test carefully before relying on alerts for operational use.

**Features**

- Monitors specified Telegram channels for new messages
- Regex-based filtering tuned for Smila / Cherkasy region (see `config.js`)
- Uses OpenAI to produce structured JSON analysis for each matched message
- Sends notifications via webhook and other configured channels

**Quick Links**

- Entry point: `index.js`
- Filters & prompt: `config.js`
- OpenAI integration: `openai.js`
- Notification logic: `notify.js`, `routes.js`

**Requirements**

- Node.js 18+ (ESM + top-level await)
- npm
- Telegram API credentials (api_id, api_hash)
- OpenAI API key

Installation

```
npm install
```

Configuration

1. Create a `.env.local` file in the project root (the app loads this file via `dotenv`):

```
# Example .env.local
TG_CHANNELS=@channel1,@channel2
TG_API_ID=123456
TG_API_HASH=your_api_hash_here
OPENAI_API_KEY=sk-...
HA_WEBHOOK_URL=https://your-home-assistant.example/api/webhook/your_webhook_id
PORT=4000
# Optional: If you already have a Telegram StringSession, add it to avoid re-authenticating
TG_SESSION=""
```

- `TG_CHANNELS`: comma-separated Telegram channel usernames (without spaces), e.g. `@alerts_channel`.
- `TG_API_ID` and `TG_API_HASH`: obtain from https://my.telegram.org
- `OPENAI_API_KEY`: required for `openai.js` to call the OpenAI API
- `HA_WEBHOOK_URL`: optional — if set, notifications will be sent to this Home Assistant webhook
- `TG_SESSION`: after first-time login, the app will save `TG_SESSION` into `.env.local` so you can re-use session without QR/phone auth

Running

- Start the app (production):

```powershell
npm start
```

- Or run directly with Node:

```powershell
node index.js
```

- For development with live reload (if you have `nodemon`):

```powershell
npx nodemon index.js
```

Behavior

- The app resolves channel usernames, subscribes to updates, and for each new message:
  - Applies `primaryFilter` and `excludeFilter` from `config.js` (Ukrainian/Russian-language regexes)
  - If matched, calls `generateResponse()` in `openai.js` to create a structured JSON analysis
  - Calls `notify()` to forward notifications (and optionally sends to `HA_WEBHOOK_URL`)

Testing

- Unit tests are run with `vitest`:

```powershell
npm test
```

Important files

- `index.js`: main entry + Telegram listener
- `config.js`: regex filters, prompt, and output schema
- `openai.js`: OpenAI API wrapper
- `notify.js`: notification / webhook logic
- `routes.js`: HTTP test routes and webhook endpoints

Notes & Troubleshooting

- The app uses `.env.local` explicitly. If you prefer `.env`, adjust `dotenv.config()` in `index.js`.
- If you see `No TG_CHANNELS found` in the logs, ensure `TG_CHANNELS` is set and non-empty.
- The package `dev` script references `./app` in `package.json` but this repository uses `index.js`. Use `npx nodemon index.js` for reliable live reload.
- Top-level await and ESM (`type: "module"`) require Node 18+.

Security & Operational cautions

- This repository is a prototype assistant for threat analysis — do not rely as a single source for life-critical alerting.
- Keep `OPENAI_API_KEY`, `TG_API_HASH`, and `TG_SESSION` secret. Do not commit `.env.local` to version control.

Contributing

- Bug reports and PRs welcome. Keep changes focused and add tests for new logic.

License

- MIT (or update as desired)
