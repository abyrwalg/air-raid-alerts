const form = document.querySelector('#filters');
const entries = document.querySelector('#entries');
const notice = document.querySelector('#notice');
const workspace = document.querySelector('#workspace');
const detail = document.querySelector('#detail');
const pageSize = 25;
let page = 1;
let selectedId = null;
let timer;

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

async function load() {
  setNotice('Loading request logs…');
  try {
    const response = await fetch(`/logs/api/ai-logs?${params()}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok)
      throw new Error((await response.json()).error || 'Unable to load logs.');
    const data = await response.json();
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
  pre.textContent = text;
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
    const response = await fetch(`/logs/api/ai-logs/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error('Unable to load request details.');
    const item = await response.json();
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
    detail.append(
      meta,
      payload('Request', item.request),
      payload('Response', item.response),
    );
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

form.addEventListener('input', () => {
  page = 1;
  clearTimeout(timer);
  timer = setTimeout(load, 250);
});
form.addEventListener('change', () => {
  page = 1;
  load();
});
form.addEventListener('reset', () => {
  page = 1;
  setTimeout(load);
});
document.querySelector('#refresh').addEventListener('click', load);
document.querySelector('#previous').addEventListener('click', () => {
  page--;
  load();
});
document.querySelector('#next').addEventListener('click', () => {
  page++;
  load();
});
load();
