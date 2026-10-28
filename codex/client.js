import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const targets = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

// Deliberately do not inherit application secrets, API keys, NODE_OPTIONS, or
// another Codex installation's configuration/environment overrides.
export function codexEnvironment(home, env = process.env) {
  const allowed =
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_ALL|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([key]) => allowed.test(key)),
    ),
    CODEX_HOME: home,
  };
}

export const codexOverrides = {
  forced_login_method: 'chatgpt',
  model_provider: 'openai',
  cli_auth_credentials_store: 'file',
  approval_policy: 'never',
  sandbox_mode: 'read-only',
  project_doc_max_bytes: 0,
  web_search: 'disabled',
  'tools.update_plan.enabled': false,
  'tools.experimental_request_user_input.enabled': false,
  'skills.bundled.enabled': false,
  'skills.include_instructions': false,
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.apply_patch_freeform': false,
  'features.code_mode': false,
  'features.code_mode_only': false,
  'features.apps': false,
  'features.plugins': false,
  'features.hooks': false,
  'features.codex_hooks': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.memory_tool': false,
  'features.skill_search': false,
  'features.tool_search': false,
  'features.tool_suggest': false,
  'features.search_tool': false,
  'features.stable_environment_tools': false,
  'features.request_permissions_tool': false,
  'features.skip_host_skill_discovery': true,
};

export class CodexClient extends EventEmitter {
  constructor(config, { spawnProcess = spawn } = {}) {
    super();
    this.config = config;
    this.spawnProcess = spawnProcess;
    this.pending = new Map();
    this.nextId = 1;
    this.generation = 0;
  }

  async start() {
    if (!this.starting) {
      const generation = this.generation;
      this.starting = this.launch(generation).catch((error) => {
        if (generation === this.generation) this.close();
        throw error;
      });
    }
    return this.starting;
  }

  async launch(generation) {
    await mkdir(this.config.codexHome, { recursive: true, mode: 0o700 });
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'air-raid-codex-'));
    if (generation !== this.generation) {
      await rm(cwd, { recursive: true, force: true });
      throw new Error('Codex startup was cancelled.');
    }
    this.cwd = cwd;
    const platform = `${process.platform}-${process.arch}`;
    const target = targets[platform];
    if (!target) throw new Error('Codex does not support this platform.');
    let executable;
    try {
      executable = path.join(
        path.dirname(
          createRequire(require.resolve('@openai/codex/package.json')).resolve(
            `@openai/codex-${platform}/package.json`,
          ),
        ),
        'vendor',
        target,
        'bin',
        process.platform === 'win32' ? 'codex.exe' : 'codex',
      );
    } catch {
      throw new Error(
        'Codex native dependency is missing. Reinstall npm dependencies with optional packages enabled.',
      );
    }
    const args = ['app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(codexOverrides)) {
      args.push('-c', `${key}=${JSON.stringify(value)}`);
    }
    const child = this.spawnProcess(executable, args, {
      cwd: this.cwd,
      env: codexEnvironment(this.config.codexHome),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) return this.close();
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim()) this.receive(line);
      }
    });
    // Drain diagnostics, but never forward raw output: it can contain auth data.
    child.stderr.resume();
    const onClose = () => {
      if (this.child === child) this.close();
    };
    child.stdin.on('error', onClose);
    child.on('error', onClose);
    child.on('exit', onClose);
    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'air_raid_alerts',
        title: 'Air Raid Alerts',
        version: '1.0.0',
      },
      capabilities: null,
    });
    if (generation !== this.generation)
      throw new Error('Codex startup was cancelled.');
    this.write({ method: 'initialized' });
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.close();
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.close();
      return;
    }
    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new Error(
            `Codex ${pending.method} failed. Check Codex access, device authorization settings, and your connection.`,
          ),
        );
      else pending.resolve(message.result);
    } else if (message.method && Object.hasOwn(message, 'id')) {
      // No approvals, command execution, token injection, or interactive tools.
      this.write({
        id: message.id,
        error: { code: -32601, message: 'Client actions are disabled.' },
      });
    } else if (message.method) {
      this.emit('notification', message);
    }
  }

  write(message) {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendRequest(
    method,
    params,
    timeoutMs = 30000,
    { closeOnTimeout = true } = {},
  ) {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error('Codex is disconnected. Please retry.'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (closeOnTimeout) this.close();
        else {
          this.pending.delete(id);
          reject(new Error(`Codex ${method} timed out.`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  async request(method, params, timeoutMs, options) {
    await this.start();
    return this.sendRequest(method, params, timeoutMs, options);
  }

  close() {
    this.generation++;
    const child = this.child;
    this.child = null;
    this.starting = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(
        new Error(
          'Codex connection closed or timed out. Retry or sign in at /auth/codex.',
        ),
      );
    }
    this.pending.clear();
    if (child) {
      child.removeAllListeners('exit');
      child.kill();
    }
    if (this.cwd) {
      void rm(this.cwd, { recursive: true, force: true }).catch(() => {});
      this.cwd = null;
    }
    this.emit('disconnected');
  }
}
