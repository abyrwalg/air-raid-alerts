import express from 'express';
import { fileURLToPath } from 'node:url';
import { getAiLogStore } from './runtime.js';

const router = express.Router();
export const aiLogApiRouter = express.Router();
const publicFile = (name) =>
  fileURLToPath(new URL(`../public/${name}`, import.meta.url));

function requestPreview(request) {
  const candidates = [];
  const visit = (value) => {
    if (typeof value === 'string') candidates.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['content', 'text', 'input'].includes(key)) visit(child);
        else if (typeof child === 'object') visit(child);
      }
    }
  };
  visit(request);
  return (
    candidates
      .slice()
      .reverse()
      .find((value) => value.length > 20) ||
    candidates.at(-1) ||
    ''
  )
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

function setSecurityHeaders(req, res, next) {
  res.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  });
  next();
}
router.use(setSecurityHeaders);
aiLogApiRouter.use(setSecurityHeaders);

router.get('/', (req, res) => {
  if (!getAiLogStore()) return res.sendStatus(404);
  return res.sendFile(publicFile('logs.html'));
});
router.get('/app.js', (req, res) => res.sendFile(publicFile('logs.js')));
router.get('/logs-api.js', (req, res) =>
  res.sendFile(publicFile('logs-api.js')),
);
router.get('/logs-format.js', (req, res) =>
  res.sendFile(publicFile('logs-format.js')),
);
router.get('/logs-highlight.js', (req, res) =>
  res.sendFile(publicFile('logs-highlight.js')),
);
router.get('/theme-init.js', (req, res) =>
  res.sendFile(publicFile('logs-theme-init.js')),
);
router.get('/logs-theme.js', (req, res) =>
  res.sendFile(publicFile('logs-theme.js')),
);
router.get('/style.css', (req, res) => res.sendFile(publicFile('logs.css')));
router.get('/preview.css', (req, res) =>
  res.sendFile(publicFile('logs-preview.css')),
);

aiLogApiRouter.get('/', (req, res) => {
  const store = getAiLogStore();
  if (!store)
    return res.status(503).json({ error: 'AI logs are not available.' });
  const { provider, task, status, model, search = '', from, to } = req.query;
  if (provider && !['openai', 'codex'].includes(provider))
    return res.status(400).json({ error: 'Invalid provider filter.' });
  if (task && !['analysis', 'triage'].includes(task))
    return res.status(400).json({ error: 'Invalid task filter.' });
  if (
    status &&
    !['in_progress', 'success', 'error', 'interrupted'].includes(status)
  )
    return res.status(400).json({ error: 'Invalid status filter.' });
  if ([from, to].some((date) => date && !Number.isFinite(Date.parse(date))))
    return res.status(400).json({ error: 'Invalid date filter.' });
  const page = Number(req.query.page || 1);
  const pageSize = Number(req.query.pageSize || 25);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    typeof search !== 'string' ||
    search.length > 200
  ) {
    return res
      .status(400)
      .json({ error: 'Invalid pagination or search filter.' });
  }
  const query = search.toLocaleLowerCase();
  const fromBound =
    from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? `${from}T00:00:00.000Z` : from;
  const toBound =
    to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to;
  const filtered = store
    .list()
    .filter(
      (entry) =>
        (!provider || entry.provider === provider) &&
        (!task || entry.task === task) &&
        (!status || entry.status === status) &&
        (!model ||
          entry.model.toLowerCase().includes(String(model).toLowerCase())) &&
        (!fromBound || entry.startedAt >= fromBound) &&
        (!toBound || entry.startedAt <= toBound) &&
        (!query ||
          JSON.stringify({
            request: entry.request,
            response: entry.response,
            error: entry.error,
          })
            .toLocaleLowerCase()
            .includes(query)),
    )
    .sort(
      (a, b) =>
        b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
    );
  const offset = (page - 1) * pageSize;
  const items = filtered
    .slice(offset, offset + pageSize)
    .map(
      ({
        id,
        evaluationId,
        provider,
        task,
        model,
        status,
        startedAt,
        finishedAt,
        durationMs,
        error,
        request,
      }) => ({
        id,
        evaluationId,
        provider,
        task,
        model,
        status,
        startedAt,
        finishedAt,
        durationMs,
        error,
        preview: requestPreview(request),
      }),
    );
  return res.json({
    items,
    page,
    pageSize,
    total: filtered.length,
    pages: Math.ceil(filtered.length / pageSize),
  });
});

aiLogApiRouter.get('/codex-limits', async (req, res) => {
  const store = getAiLogStore();
  if (!store)
    return res.status(503).json({ error: 'AI logs are not available.' });
  try {
    const [{ getAIConfig }, { getCodexService }] = await Promise.all([
      import('../aiConfig.js'),
      import('../codex/service.js'),
    ]);
    const config = getAIConfig();
    if (!config.codexAuthEnabled) return res.sendStatus(404);
    const windows = await getCodexService().rateLimits();
    return res.json({ windows: windows || [] });
  } catch {
    // Optional account usage data is unavailable; never expose Codex errors.
    return res.status(503).json({ error: 'Codex limits are unavailable.' });
  }
});

aiLogApiRouter.get('/:id', (req, res) => {
  const entry = getAiLogStore()?.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'AI log entry not found.' });
  return res.json(entry);
});

export default router;
