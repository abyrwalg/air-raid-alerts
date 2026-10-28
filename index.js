import { startServer } from './startup.js';

let server;
let stopping = false;

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(code), 3000);
  deadline.unref();
  try {
    await server?.close();
  } finally {
    process.exit(code);
  }
}

process.once('SIGINT', () => {
  void shutdown(130);
});
process.once('SIGTERM', () => {
  void shutdown(143);
});

try {
  server = await startServer();
  await server.ready;
} catch (error) {
  if (!stopping) {
    console.error(
      'Application startup failed:',
      server
        ? 'Normal initialization failed. Check configuration and dependency availability.'
        : error.message,
    );
    await shutdown(1);
  }
}
