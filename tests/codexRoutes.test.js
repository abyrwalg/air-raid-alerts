import express from 'express';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
import { createCodexRouter, localAuthGuard } from '../codex/routes.js';

describe('local Codex authentication routes', () => {
  let server;
  let base;
  let service;
  let enabled;
  beforeEach(async () => {
    enabled = true;
    service = {
      status: vi.fn().mockResolvedValue({ status: 'signed_out' }),
      startLogin: vi
        .fn()
        .mockResolvedValue({ status: 'pending', userCode: 'ABCD-1234' }),
      cancelLogin: vi.fn().mockResolvedValue({ status: 'signed_out' }),
      logout: vi.fn().mockResolvedValue({ status: 'signed_out' }),
    };
    const app = express();
    app.use(
      '/auth/codex',
      createCodexRouter({
        config: () => ({
          codexAuthEnabled: enabled,
          analysisProvider: 'codex',
        }),
        service: () => service,
      }),
    );
    app.get('/', (req, res) => res.json({ status: 'ok' }));
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function mutate(action, headers = {}) {
    const session = await (await fetch(`${base}/auth/codex/session`)).json();
    return fetch(`${base}/auth/codex/${action}`, {
      method: 'POST',
      headers: { Origin: base, 'X-CSRF-Token': session.csrfToken, ...headers },
    });
  }

  it('serves setup and assets without login and preserves the root health check', async () => {
    const response = await fetch(`${base}/auth/codex`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Sign in with ChatGPT');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    for (const file of ['app.js', 'style.css']) {
      expect((await fetch(`${base}/auth/codex/${file}`)).status).toBe(200);
    }
    expect(await (await fetch(base)).json()).toEqual({ status: 'ok' });
    expect(service.startLogin).not.toHaveBeenCalled();
  });

  it('supports status, login, cancellation, and logout with same-origin CSRF protection', async () => {
    expect(await (await fetch(`${base}/auth/codex/status`)).json()).toEqual({
      status: 'signed_out',
    });
    for (const action of ['login', 'cancel', 'logout'])
      expect((await mutate(action)).status).toBe(200);
    expect(service.startLogin).toHaveBeenCalledOnce();
    expect(service.cancelLogin).toHaveBeenCalledOnce();
    expect(service.logout).toHaveBeenCalledOnce();
  });

  it('rejects mutations without a CSRF token or same-origin Origin', async () => {
    expect((await mutate('login', { 'X-CSRF-Token': '' })).status).toBe(403);
    expect(
      (await mutate('login', { Origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect((await mutate('login', { Origin: '' })).status).toBe(403);
    expect(service.startLogin).not.toHaveBeenCalled();
  });

  it('rejects cross-site reads, invalid Hosts, and untrusted forwarded headers', async () => {
    expect(
      (
        await fetch(`${base}/auth/codex/session`, {
          headers: { Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/auth/codex/session`, {
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(
        `${base}/auth/codex/session`,
        {
          headers: {
            Host: `evil.example:${server.address().port}`,
            'X-Forwarded-Host': 'localhost',
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(403);
  });

  it('rejects non-loopback clients even if their Host is localhost', () => {
    const req = {
      headers: { host: 'localhost:4000' },
      method: 'GET',
      socket: { remoteAddress: '192.168.1.5', localPort: 4000 },
      get: () => undefined,
    };
    const res = {
      set: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();
    localAuthGuard(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('can disable the UI and its APIs completely', async () => {
    enabled = false;
    expect((await fetch(`${base}/auth/codex`)).status).toBe(404);
    expect((await fetch(`${base}/auth/codex/status`)).status).toBe(404);
    expect(service.status).not.toHaveBeenCalled();
  });

  it('redacts backend failures rather than exposing process output', async () => {
    service.status.mockRejectedValue(new Error('access-token=private'));
    const response = await fetch(`${base}/auth/codex/status`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
