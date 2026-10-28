import { describe, expect, it } from 'vitest';
import dotenv from 'dotenv';
import axios from 'axios';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn } from 'node:child_process';
import open from 'open';
import textToSpeech from '../tts.js';

describe('automated-test safety controls', () => {
  it('does not load local dotenv files', () => {
    expect(dotenv.config({ path: '.env.local' })).toEqual({ parsed: {} });
    expect(process.env.HA_LOGS_WEBHOOK_URL).toBeUndefined();
    expect(process.env.HA_WEBHOOK_URL).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it.each(['http:', 'https:'])(
    'blocks unmocked Axios requests over %s',
    async (protocol) => {
      await expect(
        axios.post(
          `${protocol}//external.invalid/webhook`,
          { text: 'test' },
          { proxy: false },
        ),
      ).rejects.toMatchObject({ code: 'ENETUNREACH' });
    },
  );

  it.each(['http:', 'https:'])(
    'blocks unmocked native fetch over %s',
    async (protocol) => {
      const failure = await fetch(`${protocol}//external.invalid/webhook`, {
        method: 'POST',
        body: 'test',
      }).then(
        () => {
          throw new Error('An external request was unexpectedly allowed.');
        },
        (error) => error,
      );
      expect(failure.code || failure.cause?.code).toBe('ENETUNREACH');
    },
  );

  it.each([httpRequest, httpsRequest])(
    'blocks direct HTTP client requests',
    async (request) => {
      const protocol = request === httpsRequest ? 'https:' : 'http:';
      const result = new Promise((resolve, reject) => {
        const req = request(
          `${protocol}//external.invalid/webhook`,
          { method: 'POST' },
          resolve,
        );
        req.on('error', reject);
        req.end('test');
      });
      await expect(result).rejects.toMatchObject({ code: 'ENETUNREACH' });
    },
  );

  it('blocks real subprocesses, browsers, and audio', () => {
    expect(() => spawn('codex', ['--version'])).toThrow(
      'Real child processes are disabled',
    );
    expect(() => open('http://localhost:4000/auth/codex')).toThrow(
      'Real browser launches are disabled',
    );
    expect(() => textToSpeech('test')).toThrow('Real audio is disabled');
  });
});
