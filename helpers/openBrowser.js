import open from 'open';

export function openAuthPage(url) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== 'localhost' ||
    parsed.pathname !== '/auth/codex' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Invalid local authentication page URL.');
  }
  // No tokens/codes or caller-controlled URLs go to the desktop launcher.
  return open(parsed.href, { wait: false });
}
