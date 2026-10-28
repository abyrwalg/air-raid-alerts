import { readApiResponse } from './logs-api.js';
import { formatModelResponse, formatRequest } from './logs-format.js';
import { highlightJsonElement } from './logs-highlight.js';
import { initializeTheme } from './logs-theme.js';

const form = document.querySelector('#filters');
const entries = document.querySelector('#entries');
const notice = document.querySelector('#notice');
const workspace = document.querySelector('#workspace');
const detail = document.querySelector('#detail');
const limitsPanel = document.querySelector('#codex-limits');
const limitsWindows = document.querySelector('#limits-windows');
const limitsSummary = document.querySelector('#limits-summary');
const filtersToggle = document.querySelector('#filters-toggle');
const advancedFilters = document.querySelector('#advanced-filters');
const filterCount = document.querySelector('#filter-count');
const pageSize = 25;
let page = 1;
let selectedId = null;
let timer;
let limitsRequest = 0;
let limitsLoading = false;

function params() {
  const result = new URLSearchParams({ page, pageSize });
  for (const [key, value] of new FormData(form))
    if (value) result.set(key, value);
  return result;
}
function setNotice(text, error = false) {
  notice.textContent = text;
  notice.classList.toggle('error', error);
}
function date(value) {
  return value ? new Date(value).toLocaleString() : '—';
}
function updateFilterCount() {
  const count = [...advancedFilters.querySelectorAll('input, select')].filter(
    (control) => control.value,
  ).length;
  filterCount.textContent = count ? `(${count})` : '';
  filtersToggle.setAttribute(
    'aria-label',
    `Filters${count ? `, ${count} active` : ''}`,
  );
}

async function load() {
  setNotice('Loading request logs…');
  try {
    const response = await fetch(`/api/ai-logs?${params()}`, {
      headers: { Accept: 'application/json' },
    });
    const data = await readApiResponse(response, 'Unable to load logs');
    entries.replaceChildren();
    document.querySelector('#count').textContent = `${data.total} total`;
    document.querySelector('#page-label').textContent =
      `${data.page} / ${Math.max(1, data.pages)}`;
    document.querySelector('#previous').disabled = page <= 1;
    document.querySelector('#next').disabled = page >= data.pages;
    for (const item of data.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `entry${item.id === selectedId ? ' selected' : ''}`;
      const top = document.createElement('span');
      top.className = 'entry-top';
      const title = document.createElement('span');
      title.className = 'entry-title';
      title.textContent = `${item.provider} · ${item.task}`;
      const badge = document.createElement('span');
      badge.className = `badge ${item.status}`;
      badge.textContent = item.status.replace('_', ' ');
      top.append(title, badge);
      const meta = document.createElement('span');
      meta.className = 'entry-meta';
      const model = document.createElement('span');
      model.textContent = item.model;
      const when = document.createElement('time');
      when.textContent = date(item.startedAt);
      meta.append(model, when);
      const preview = document.createElement('span');
      preview.className = 'entry-preview';
      preview.textContent = item.preview || 'Request payload unavailable';
      button.append(top, meta, preview);
      button.addEventListener('click', () => showDetail(item.id));
      entries.append(button);
    }
    setNotice(data.total ? '' : 'No requests match these filters.');
  } catch (error) {
    setNotice(error.message, true);
  }
}

async function loadLimits() {
  if (document.hidden || limitsLoading) return;
  limitsLoading = true;
  const requestId = ++limitsRequest;
  try {
    const response = await fetch('/api/ai-logs/codex-limits', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Codex limits unavailable');
    const data = await response.json();
    if (requestId !== limitsRequest || document.hidden) return;
    if (!Array.isArray(data.windows) || data.windows.length === 0) {
      limitsPanel.hidden = true;
      limitsWindows.replaceChildren();
      limitsSummary.textContent = '';
      return;
    }
    limitsWindows.replaceChildren();
    const summaries = [];
    for (const window of data.windows) {
      const card = document.createElement('article');
      card.className = 'limit-window';
      const heading = document.createElement('h3');
      heading.textContent = window.label;
      const percent = document.createElement('strong');
      const remaining = Math.round(100 - window.usedPercent);
      percent.textContent = `${remaining}% remaining`;
      summaries.push(`${window.label}: ${remaining}% remaining`);
      const progress = document.createElement('progress');
      progress.max = 100;
      progress.value = Math.max(0, Math.min(100, 100 - window.usedPercent));
      progress.setAttribute('aria-label', `${heading.textContent} remaining`);
      const meta = document.createElement('p');
      const duration = window.windowDurationMins;
      const durationLabel =
        duration >= 60
          ? `${duration / 60} hour${duration === 60 ? '' : 's'}`
          : `${duration} minutes`;
      const reset = new Date(window.resetsAt);
      meta.textContent = `${durationLabel} window · resets ${Number.isNaN(reset.getTime()) ? '—' : reset.toLocaleString()}`;
      card.append(heading, percent, progress, meta);
      limitsWindows.append(card);
    }
    limitsSummary.textContent = summaries.join(' · ');
    limitsPanel.hidden = false;
  } catch {
    if (requestId !== limitsRequest) return;
    limitsPanel.hidden = true;
    limitsWindows.replaceChildren();
    limitsSummary.textContent = '';
  } finally {
    limitsLoading = false;
  }
}

function payload(title, value) {
  const section = document.createElement('section');
  section.className = 'payload';
  const heading = document.createElement('div');
  heading.className = 'payload-head';
  const h = document.createElement('h3');
  h.textContent = title;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'button secondary copy';
  copy.textContent = 'Copy';
  const pre = document.createElement('pre');
  const text =
    value == null
      ? 'No payload captured.'
      : typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2);
  const highlighted = highlightJsonElement(pre, text);
  if (!highlighted) pre.textContent = text;
  copy.addEventListener('click', async () => {
    try {
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(text);
      else {
        const temporary = document.createElement('textarea');
        temporary.value = text;
        temporary.style.position = 'fixed';
        temporary.style.opacity = '0';
        document.body.append(temporary);
        temporary.select();
        if (!document.execCommand('copy')) throw new Error('Copy unavailable.');
        temporary.remove();
      }
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy unavailable';
    }
    setTimeout(() => {
      copy.textContent = 'Copy';
    }, 1200);
  });
  heading.append(h, copy);
  section.append(heading, pre);
  return section;
}

async function showDetail(id) {
  selectedId = id;
  try {
    const response = await fetch(`/api/ai-logs/${encodeURIComponent(id)}`);
    const item = await readApiResponse(
      response,
      'Unable to load request details',
    );
    detail.replaceChildren();
    const header = document.createElement('div');
    header.className = 'detail-head';
    const title = document.createElement('h2');
    title.textContent = `${item.provider} ${item.task}`;
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'button secondary mobile-back';
    back.textContent = '← Requests';
    back.addEventListener('click', () =>
      workspace.classList.remove('mobile-detail'),
    );
    header.append(back, title);
    detail.append(header);
    const meta = document.createElement('div');
    meta.className = 'metadata';
    for (const value of [
      `Status: ${item.status}`,
      `Model: ${item.model}`,
      `Started: ${date(item.startedAt)}`,
      `Finished: ${date(item.finishedAt)}`,
      `Duration: ${item.durationMs == null ? '—' : `${item.durationMs} ms`}`,
      `Call: ${item.id}`,
      ...(item.evaluationId ? [`Evaluation: ${item.evaluationId}`] : []),
    ]) {
      const chip = document.createElement('span');
      chip.className = 'meta';
      chip.textContent = value;
      meta.append(chip);
    }
    detail.append(meta);
    const responseView = formatModelResponse(item.response);
    detail.append(payload('Response', responseView.formatted));
    if (responseView.raw !== responseView.formatted) {
      const raw = document.createElement('details');
      raw.className = 'payload raw-response';
      const summary = document.createElement('summary');
      summary.textContent = 'Raw response';
      raw.append(summary, payload('Provider payload', responseView.raw));
      detail.append(raw);
    }
    const requestView = formatRequest(item.request);
    for (const section of requestView.sections)
      detail.append(payload(section.label, section.text));
    const rawRequest = document.createElement('details');
    rawRequest.className = 'payload raw-payload';
    const rawRequestSummary = document.createElement('summary');
    rawRequestSummary.textContent = 'Raw request';
    rawRequest.append(
      rawRequestSummary,
      payload('Request payload', requestView.raw),
    );
    detail.append(rawRequest);
    if (item.usage) detail.append(payload('Usage', item.usage));
    if (item.error) detail.append(payload('Error category', item.error));
    if (item.validationError)
      detail.append(payload('Validation', item.validationError));
    workspace.classList.add('mobile-detail');
    await load();
  } catch (error) {
    setNotice(error.message, true);
  }
}

filtersToggle.addEventListener('click', () => {
  const expanded = filtersToggle.getAttribute('aria-expanded') !== 'true';
  filtersToggle.setAttribute('aria-expanded', String(expanded));
  advancedFilters.hidden = !expanded;
});
form.addEventListener('input', () => {
  updateFilterCount();
  page = 1;
  clearTimeout(timer);
  timer = setTimeout(load, 250);
});
form.addEventListener('change', () => {
  updateFilterCount();
  page = 1;
  load();
});
form.addEventListener('reset', () => {
  page = 1;
  setTimeout(() => {
    updateFilterCount();
    load();
  });
});
document.querySelector('#refresh').addEventListener('click', () => {
  load();
  loadLimits();
});
initializeTheme(document.querySelector('#theme'));
updateFilterCount();
document.querySelector('#previous').addEventListener('click', () => {
  page--;
  load();
});
document.querySelector('#next').addEventListener('click', () => {
  page++;
  load();
});
load();
loadLimits();
setInterval(() => {
  if (!document.hidden) loadLimits();
}, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadLimits();
  else limitsRequest++;
});
