# Air Raid Alerts

A Telegram-based threat analyzer for Smila / Cherkasy region, Ukraine. It filters reports, optionally triages them, produces structured risk assessments, and forwards notifications through configured integrations.

**Prototype: do not rely on this app as a single source for life-critical alerts. Use official warnings and validate model behavior carefully.**

## Features

- Telegram monitoring with region-specific filters in [`config.js`](config.js).
- Independently selectable **analysis provider/model** and **triage provider/model**.
- OpenAI API access or Codex using ChatGPT sign-in.
- Local web-based Codex device authorization, connection status, cancellation, and sign-out.
- Shared assessment rules, structured output validation, recent-message context, and serialized processing.
- Home Assistant webhooks, notifications, and TTS.

## Requirements and installation

- Node.js 18+; the repository's [`.nvmrc`](.nvmrc) specifies Node 22.
- Use the pinned Node 22 runtime for automated tests; the HTTP isolation dependency requires Node 18.20+ or Node 20.12.1+.
- npm, with optional dependencies enabled for Codex's native binary.
- Telegram credentials when Telegram monitoring is enabled.
- An OpenAI API key for any enabled OpenAI stage, and/or a ChatGPT account with Codex access for Codex stages.

```powershell
npm install
```

No global Codex installation is needed. The pinned CLI dependency includes native binaries for supported Windows, macOS, and Linux x64/ARM64 platforms. Its app-server protocol is experimental; retest sign-in and model requests before upgrading the pinned version in [`package.json`](package.json).

## Configuration

Use [`.env.example`](.env.example) as the reference and create or manually update [`.env.local`](.env.local). The app explicitly loads the local file, not a file named [`.env`](.env). Restart the app after changing settings.

**Existing installations:** this is a clean rename. Removed names are rejected, including blank entries and entries alongside their replacements. There are no legacy aliases. Your local file is not automatically migrated; follow the migration table below and retain your existing secrets and unrelated settings.

### 1. Analysis

Analysis is the full structured threat assessment. These settings apply to whichever analysis provider is selected:

| Setting                                 | Purpose                                                                | Default when empty or omitted                |
| --------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| [`ANALYSIS_PROVIDER`](.env.example:3)   | openai for direct API access, or codex for ChatGPT-authenticated Codex | openai                                       |
| [`ANALYSIS_MODEL`](.env.example:5)      | Model available through the selected analysis provider                 | OpenAI: gpt-6-luna; Codex: its default model |
| [`ANALYSIS_TIMEOUT_MS`](.env.example:7) | Positive integer timeout in milliseconds                               | OpenAI: 600000; Codex: 120000                |

### 2. Triage

Triage optionally decides whether a message should proceed to full analysis. It has its **own** provider, model, and timeout:

| Setting                                | Purpose                                                                    | Default when empty or omitted                |
| -------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| [`TRIAGE_ENABLED`](.env.example:10)    | true enables triage; false runs full analysis directly                     | false                                        |
| [`TRIAGE_PROVIDER`](.env.example:12)   | openai uses the Decisions API; codex uses a structured Codex request       | openai                                       |
| [`TRIAGE_MODEL`](.env.example:14)      | Model available through the selected triage provider                       | OpenAI: gpt-6-luna; Codex: its default model |
| [`TRIAGE_THRESHOLD`](.env.example:16)  | Probability threshold from 0 to 1 inclusive; values below it skip analysis | 0.5                                          |
| [`TRIAGE_TIMEOUT_MS`](.env.example:18) | Positive integer timeout in milliseconds                                   | OpenAI: 8000; Codex: 120000                  |

**No cross-stage inheritance:** changing analysis settings never supplies or changes a triage model/timeout, and vice versa. If both stages should use the same model or timeout, set both values explicitly. Blank values resolve using each stage's own selected provider. Switching a provider does not translate an explicitly configured model name; choose a model that provider supports.

For OpenAI, timeouts are passed to the corresponding API request and automatic retries are disabled. For Codex, each stage's deadline covers its account check, thread startup, and model execution; expiration terminates the native connection. Triage failures continue to the configured analysis stage. There is no automatic provider switching.

### 3. Provider credentials and authentication

| Setting                                     | Purpose                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`OPENAI_API_KEY`](.env.example:22)         | Required if analysis uses OpenAI or enabled triage uses OpenAI. Never passed to Codex.                                                          |
| [`ENABLE_CODEX_AUTH_UI`](.env.example:26)   | Controls the optional post-startup setup page. Blank enables it for active Codex stages. Required startup sign-in remains available regardless. |
| [`CODEX_LOGIN_TIMEOUT_MS`](.env.example:27) | Local device-authorization deadline; default 600000, allowed range 1000–900000 milliseconds. The upstream code may expire sooner.               |
| [`CODEX_HOME_DIR`](.env.example:29)         | App-specific private credential/data directory; defaults to .codex-alerts relative to the working directory.                                    |

| Analysis provider | Triage provider    | Credentials                                                                    |
| ----------------- | ------------------ | ------------------------------------------------------------------------------ |
| OpenAI            | Disabled or OpenAI | OpenAI API key; Decisions API access is required when OpenAI triage is enabled |
| OpenAI            | Codex              | OpenAI API key for analysis plus ChatGPT sign-in for triage                    |
| Codex             | Disabled or Codex  | ChatGPT sign-in; no API key required                                           |
| Codex             | OpenAI             | ChatGPT sign-in for analysis plus OpenAI API key with Decisions API access     |

Codex stages share authentication, **not** their model, timeout, instructions, or thread. ChatGPT login does not authorize the Decisions API. OpenAI requests use API billing; Codex requests use the signed-in account's Codex access and usage limits.

### Example: Codex analysis and Codex triage, without an API key

```dotenv
ANALYSIS_PROVIDER=codex
ANALYSIS_MODEL=
ANALYSIS_TIMEOUT_MS=120000

TRIAGE_ENABLED=true
TRIAGE_PROVIDER=codex
TRIAGE_MODEL=
TRIAGE_THRESHOLD=0.5
TRIAGE_TIMEOUT_MS=120000

OPENAI_API_KEY=
# Optional while setting up and testing HTTP endpoints:
ENABLE_TELEGRAM=false
```

Set each model independently to a supported model name, or leave it blank for that provider's default. For Codex analysis with Decisions API triage, change only the triage provider/model/timeout as appropriate and supply an API key. For OpenAI analysis with Codex triage, change only the analysis settings and supply an API key. Enablement, threshold, and authentication remain separate settings.

### Other integrations

The example file groups these separately from AI configuration:

- **Telegram:** enablement defaults to true. Disabling it starts the HTTP endpoints without Telegram authentication or monitoring. Configure channels as comma-separated usernames, API credentials from https://my.telegram.org, an optional saved session, and optional polling. The app can save a Telegram session to the local environment file during Telegram login, as before.
- **Notifications:** Home Assistant notification/log webhook URLs are optional. The runtime notifier logs each supplied analysis, including reports skipped for alerting. The notification decision itself performs no HTTP, audio, environment loading, or timer initialization. Webhook delivery and audio remain separate runtime effects.
- **HTTP:** the port defaults to 4000. Keep the server private; the existing general endpoints are not a public authenticated API.

### Migration from previous environment names

Update [`.env.local`](.env.local) manually, then **remove every old name** from the file and any parent process environment. A removed name is an error even when the replacement is also present. Errors show names and replacements, never secret values.

| Removed setting                                     | Replacement                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| AI_PROVIDER                                         | ANALYSIS_PROVIDER                                                   |
| OPENAI_MODEL or CODEX_MODEL                         | ANALYSIS_MODEL: retain the value for the selected analysis provider |
| CODEX_TIMEOUT_MS                                    | ANALYSIS_TIMEOUT_MS                                                 |
| ENABLE_OPENAI_TRIAGE                                | TRIAGE_ENABLED                                                      |
| OPENAI_TRIAGE_MODEL or CODEX_TRIAGE_MODEL           | TRIAGE_MODEL: retain the value for the selected triage provider     |
| OPENAI_TRIAGE_THRESHOLD                             | TRIAGE_THRESHOLD                                                    |
| OPENAI_TRIAGE_TIMEOUT_MS or CODEX_TRIAGE_TIMEOUT_MS | TRIAGE_TIMEOUT_MS                                                   |

The triage-provider setting, API key, Codex authentication/storage settings, Telegram settings, notification settings, and port keep their existing names. **The old Codex model/timeout inheritance is removed.** If you previously relied on it, explicitly copy the desired effective values into the new triage model/timeout settings. No migration command edits your local file.

## Local Codex sign-in

1. Configure either active stage to use Codex and start the app. API credentials are required only for active OpenAI stages. The app starts a minimal authentication server first, then checks for a saved ChatGPT session with token refresh enabled.
2. If sign-in is needed, the local setup page **opens automatically once** in your default browser, after the HTTP listener is ready. If it cannot open (for example, on a headless host), use the URL printed in the terminal: http://localhost:4000/auth/codex, with your configured port. Use the **same computer**. Loopback IPs also work; remote and reverse-proxied authentication are intentionally unsupported.
3. Click **Sign in with ChatGPT**, follow **Open OpenAI authorization**, and enter the one-time code on OpenAI's site. Never use a code supplied by another person.
4. Enable device-code authorization in ChatGPT security settings if required. Account or organization policy may restrict it.
5. Wait for **Connected to Codex with ChatGPT**. Normal application initialization resumes automatically, exactly once. The page shows active providers and provides refresh, cancel/retry, and sign-out. Closing the tab does not cancel a pending attempt.

### Startup authentication gate

When **analysis uses Codex or enabled triage uses Codex**, normal routes, Telegram initialization, message handling, database timers, audio keep-alive timers, model requests, and notifications remain unloaded until authentication succeeds. While waiting, only authentication infrastructure runs. Other HTTP endpoints, including the root health endpoint, return a no-cache 503 response with startup status and the sign-in URL. They retain their usual behavior after normal initialization finishes.

A valid saved session starts normal operation without opening a browser. OpenAI-only operation and a disabled triage stage merely configured for Codex do not require Codex authentication. Login errors, cancellation, expiration, and failed account checks do not release the gate; retry on the same page. The browser is not repeatedly reopened, and device authorization is not started without clicking the sign-in button. Interrupting the app cancels the wait and closes its auth process and HTTP listener.

The mandatory setup page remains available during the gate even if the optional authentication UI is disabled. Once normal startup finishes, that UI setting applies normally. A working login does not guarantee model availability or account quota.

**This gate is startup-only.** Later sign-out or authentication loss does not pause, restart, or reinitialize the running app, and does not automatically reopen the browser. Requests then follow existing provider-error and triage fail-open handling until the session is restored. Restart the app to run the startup gate again.

The official Codex app-server protocol manages authorization, credential persistence, and refresh over a private stdio connection. The app does not collect your ChatGPT password, use website cookies, or implement private OAuth/token endpoints. Requests never initiate interactive login. Status indicates a locally stored session, not guaranteed model access or remaining quota. Signing in does not change configured providers or models.

Credentials are separate from your normal Codex CLI installation. The default [`.codex-alerts/`](.codex-alerts) directory is ignored by Git, but **credential files contain secrets and are not encrypted by this app**. Restrict account/filesystem access and backups; use appropriate NTFS permissions on Windows. Exclude any custom location from version control, do not use your normal Codex home, and do not share the directory between app instances. Sign-out removes this app's local session through Codex; it does not log out your ChatGPT browser session or other Codex installations and is not account-wide token revocation.

Authentication routes enforce loopback clients, local Host validation, same-origin access, CSRF protection for mutations, and no caching. No permissive CORS is enabled and tokens are not returned to the browser. This is a single-user setup page, not a multi-user authentication system. Existing message, test, webhook, and audio endpoints are unchanged and **not protected by the setup page's authentication controls**. Do not expose the app to the internet.

## Running

```powershell
npm start
```

Or run the entry point directly:

```powershell
node index.js
```

For live reload:

```powershell
npx nodemon index.js
```

The existing development script references a different entry point; the explicit live-reload command above is the reliable option.

## Processing and triage behavior

1. Apply the region-specific inclusion/exclusion filters from [`config.js`](config.js).
2. If triage is enabled, submit the shared assessment rules, routing question, current message, and selected context to its provider/model.
3. Reject below the configured probability threshold; otherwise run full analysis with its independently selected provider/model.
4. Triage errors, timeouts, and malformed answers fail open to full analysis. Full-analysis failures do not switch providers.
5. Validate structured results before persistence or notifications. Relevant non-none analyses are saved; triage-only outputs and rejected reports are not saved.

Both triage providers use the policy and predicate validation in [`providers/triage.js`](providers/triage.js). Codex receives additional JSON-format instructions and a strict schema for the Decisions-compatible answer structure:

```json
{
  "answers": [
    { "type": "predicate", "name": "worth_full_analysis", "probability": 0.8 }
  ]
}
```

The probability must be finite and between zero and one. **Codex's probability is a model-generated estimate, not a Decisions API score.** Matching instructions and response structure do not establish equivalent calibration or classification behavior. Validate each provider/model and threshold on representative reports before operational use; a threshold is not a safety guarantee. Passing triage does not force a medium/high full-analysis result.

Codex uses fresh ephemeral threads and an empty temporary working directory, restricted agent capabilities, and no command approvals. Triage and full analysis use separate instructions and schemas and never resume each other's threads. Only the selected context is supplied. Codex triage adds a separate model turn and consumes usage; it is not necessarily faster or cheaper than full analysis alone.

Recent database-derived context includes stored analyses. Rejected reports are absent from later context, which can remove information useful for subsequent updates. Explicit caller context replaces stored context; suppressing context takes precedence over both.

## HTTP testing and automated tests

The existing test endpoint accepts a JSON body with text, optional context string, and optional ignore-context boolean:

```json
{ "text": "Сміла уважно", "context": "Earlier report: drone heading west" }
```

```json
{ "text": "Сміла уважно", "ignoreContext": true }
```

An empty context string means no history. Test analyses are still saved, but the test endpoint does not send notifications. Root health, stored-message, webhook, and audio-test endpoints retain their existing behavior **after startup readiness**; before then they return the waiting/unavailable response described above.

```powershell
npm test -- --run
```

Automated tests mock model providers, authentication, browser launching, and normal-application loading. They cover independent stage settings, removed-name validation, credentials, policy/schema contracts, thresholds, context, queue recovery, request deadlines, auth lifecycle, local route security, deferred imports, waiting HTTP responses, saved sessions, browser fallback, startup cancellation, and exactly-once initialization. They do not prove live-model accuracy or authenticated account access.

### Automated-test isolation

[`vitest.config.js`](vitest.config.js) always loads [`tests/setup.js`](tests/setup.js) before test modules. The setup prevents dotenv from reading local files, clears inherited application credentials/webhook settings, and blocks unmocked external HTTP/HTTPS requests through Axios, native fetch, and Node's HTTP clients. Loopback HTTP is allowed for the in-process route/startup test servers. Browser launching, child processes, audio, and persistence require explicit test mocks. These are test-only controls; production behavior is not disabled with a test-mode branch.

[`helpers/shouldNotify.js`](helpers/shouldNotify.js) contains the side-effect-free notification policy and accepts an explicit clock for deterministic time-window checks. Its tests import only that helper and assert that HTTP, environment loading, and audio imports never occur—even with synthetic webhook settings present. [`notify.js`](notify.js) contains runtime orchestration: best-effort analysis logging remains independent of alert eligibility or log-delivery failure, and logging does not delay alert delivery. Its tests inject fake configuration, webhook delivery, and audio dependencies rather than using your configured integrations.

Never remove the shared isolation setup or run notification unit tests against real webhook URLs. Use synthetic configuration and explicit mocks for integrations. A small regression suite verifies that attempted external requests are rejected by the network guard, not merely failing DNS or reaching a real service. Live integration verification is a separate, deliberate activity requiring your own account and credentials.

For a manual smoke test, disable Telegram, sign in through the local page, test cancellation/retry, then submit representative reports with explicit context. Check approval/rejection and malformed/timeout fallback for each provider combination, independent model/timeout overrides, session reuse after restart, and sign-out. Completing consent and authenticated inference requires your own account and consumes usage.

## Important files and troubleshooting

- [`aiConfig.js`](aiConfig.js): stage-based environment parsing, migration errors, and credential requirements.
- [`openai.js`](openai.js): provider-neutral serialized orchestration; filename retained for caller compatibility.
- [`providers/openai.js`](providers/openai.js): OpenAI analysis and Decisions API adapter.
- [`codex/service.js`](codex/service.js): Codex authentication and request-specific structured model turns.
- [`codex/client.js`](codex/client.js): pinned native transport and isolated environment.
- [`codex/routes.js`](codex/routes.js): local sign-in page/API protection.
- [`index.js`](index.js) and [`startup.js`](startup.js): minimal bootstrap, startup authentication gate, readiness, and shutdown.
- [`application.js`](application.js): deferred normal routes and Telegram startup, imported only after the gate passes.
- [`helpers/openBrowser.js`](helpers/openBrowser.js): cross-platform launch of the local setup page.
- [`helpers/shouldNotify.js`](helpers/shouldNotify.js): side-effect-free risk/time-window notification policy.
- [`routes.js`](routes.js) and [`notify.js`](notify.js): normal HTTP endpoints and notifications.

If startup reports removed settings, manually migrate and delete the old names; the app intentionally refuses to silently fall back. If Codex cannot start, reinstall dependencies with optional packages enabled and check native-platform/security-software support. If setup returns forbidden, use a local loopback hostname and the actual app port, not a proxy, LAN hostname, or iframe. If setup returns not found, enable its UI. If authorization fails, check connectivity, account policy, and device-code authorization settings. Raw provider/auth output is deliberately not logged because it may contain secrets.

Keep API keys, Telegram credentials/sessions, Codex credential files, and authorization codes private. Do not commit the local environment file or captured authentication responses.
