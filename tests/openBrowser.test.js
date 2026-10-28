import { beforeEach, describe, expect, it, vi } from 'vitest';
const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('open', () => ({ default: open }));
import { openAuthPage } from '../helpers/openBrowser.js';

describe('local authentication browser launcher', () => {
  beforeEach(() => vi.clearAllMocks());
  it('opens only the local setup URL without waiting for the browser to close', () => {
    openAuthPage('http://localhost:4000/auth/codex');
    expect(open).toHaveBeenCalledExactlyOnceWith(
      'http://localhost:4000/auth/codex',
      { wait: false },
    );
  });
  it.each([
    'https://evil.example/auth/codex',
    'http://localhost:4000/other',
    'http://localhost:4000/auth/codex?code=secret',
    'http://localhost:4000/auth/codex#token',
    'http://user:password@localhost:4000/auth/codex',
  ])('rejects an unexpected browser destination', (url) => {
    expect(() => openAuthPage(url)).toThrow('Invalid local');
    expect(open).not.toHaveBeenCalled();
  });
});
