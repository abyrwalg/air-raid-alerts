import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  mkdtemp: vi.fn().mockResolvedValue('empty-workspace'),
  rm: vi.fn().mockResolvedValue(undefined),
}));
import { CodexClient } from '../codex/client.js';

describe('Codex app-server transport', () => {
  let children;
  let client;
  let spawnProcess;
  beforeEach(() => {
    children = [];
    spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new EventEmitter();
      child.stdin.write = vi.fn((line) => {
        const message = JSON.parse(line);
        if (message.method === 'initialize')
          queueMicrotask(() => {
            child.stdout.write(
              JSON.stringify({ id: message.id, result: {} }) + '\n',
            );
          });
      });
      child.kill = vi.fn();
      children.push(child);
      return child;
    });
    client = new CodexClient(
      { codexHome: 'private-auth-home' },
      { spawnProcess },
    );
  });
  afterEach(() => {
    client.close();
    vi.useRealTimers();
  });

  it('initializes once, spawns without a shell, and removes application secrets', async () => {
    await Promise.all([client.start(), client.start()]);
    expect(spawnProcess).toHaveBeenCalledOnce();
    const [binary, args, options] = spawnProcess.mock.calls[0];
    expect(binary).toMatch(/codex(?:\.exe)?$/);
    expect(args).toContain('stdio://');
    expect(options).toMatchObject({ shell: false, cwd: 'empty-workspace' });
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.CODEX_HOME).toBe('private-auth-home');
    expect(
      children[0].stdin.write.mock.calls.map(
        ([line]) => JSON.parse(line).method,
      ),
    ).toEqual(['initialize', 'initialized']);
  });

  it('handles split JSONL responses and emits notifications', async () => {
    await client.start();
    const notify = vi.fn();
    client.on('notification', notify);
    const result = client.request('account/read', { refreshToken: false });
    await vi.waitFor(() => expect(client.pending.size).toBe(1));
    const id = JSON.parse(children[0].stdin.write.mock.calls.at(-1)[0]).id;
    children[0].stdout.write(`{"id":${id},"res`);
    children[0].stdout.write(
      'ult":{"account":null}}\n{"method":"account/updated","params":{}}\n',
    );
    expect(await result).toEqual({ account: null });
    expect(notify).toHaveBeenCalledWith({
      method: 'account/updated',
      params: {},
    });
  });

  it('denies server-initiated approvals and redacts RPC failures', async () => {
    await client.start();
    client.receive(
      JSON.stringify({
        id: 'approval',
        method: 'item/commandExecution/requestApproval',
        params: {},
      }),
    );
    expect(
      JSON.parse(children[0].stdin.write.mock.calls.at(-1)[0]),
    ).toMatchObject({
      id: 'approval',
      error: { code: -32601 },
    });
    const result = client.request('account/read', {});
    await vi.waitFor(() => expect(client.pending.size).toBe(1));
    const id = JSON.parse(children[0].stdin.write.mock.calls.at(-1)[0]).id;
    client.receive(JSON.stringify({ id, error: { message: 'private token' } }));
    await expect(result).rejects.toThrow('Codex account/read failed');
  });

  it('terminates the process and rejects pending requests on timeout', async () => {
    await client.start();
    vi.useFakeTimers();
    const result = client.request('account/read', {}, 1000);
    const rejection = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(client.pending.size).toBe(0);
  });

  it('allows optional rate-limit timeouts without closing active Codex work', async () => {
    await client.start();
    vi.useFakeTimers();
    const active = client.sendRequest('thread/start', {}, 30000);
    const activeId = JSON.parse(
      children[0].stdin.write.mock.calls.at(-1)[0],
    ).id;
    const limits = client.sendRequest(
      'account/rateLimits/read',
      undefined,
      100,
      {
        closeOnTimeout: false,
      },
    );
    const limitsId = JSON.parse(
      children[0].stdin.write.mock.calls.at(-1)[0],
    ).id;
    const rejection = expect(limits).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(client.child).toBe(children[0]);
    expect(children[0].kill).not.toHaveBeenCalled();
    children[0].stdout.write(
      `${JSON.stringify({ id: activeId, result: { thread: { id: 'still-running' } } })}\n`,
    );
    expect(await active).toEqual({ thread: { id: 'still-running' } });
    expect(client.pending.has(limitsId)).toBe(false);
  });

  it('rejects requests on process exit and can reconnect without stale events', async () => {
    await client.start();
    const result = client.request('account/read', {});
    await vi.waitFor(() => expect(client.pending.size).toBe(1));
    children[0].emit('exit', 1);
    await expect(result).rejects.toThrow('connection closed');
    await client.start();
    children[0].emit('error', new Error('late old-process error'));
    children[0].stdin.emit('error', new Error('late stream error'));
    expect(client.child).toBe(children[1]);
    expect(children[1].kill).not.toHaveBeenCalled();
  });

  it('fails closed on malformed protocol output', async () => {
    await client.start();
    const result = client.request('account/read', {});
    await vi.waitFor(() => expect(client.pending.size).toBe(1));
    children[0].stdout.write('null\n');
    await expect(result).rejects.toThrow('connection closed');
    expect(children[0].kill).toHaveBeenCalledOnce();
  });
});
