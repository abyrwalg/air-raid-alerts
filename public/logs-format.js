function extractModelText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;

  if (Array.isArray(value.choices)) {
    for (const choice of value.choices) {
      const content = choice?.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const text = content
          .filter((part) => typeof part?.text === 'string')
          .map((part) => part.text)
          .join('\n');
        if (text) return text;
      }
    }
  }

  if (typeof value.output_text === 'string') return value.output_text;
  if (typeof value.text === 'string') return value.text;
  if (Array.isArray(value.output)) {
    for (const item of value.output) {
      if (typeof item?.text === 'string') return item.text;
      const text = item?.content
        ?.filter((part) => typeof part?.text === 'string')
        .map((part) => part.text)
        .join('\n');
      if (text) return text;
    }
  }
  return null;
}

function prettyJson(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function textParts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text))
    .filter((text) => typeof text === 'string');
}

export function formatRequest(request) {
  const raw =
    request == null ? 'No payload captured.' : JSON.stringify(request, null, 2);
  const sections = [];
  const add = (label, text) => {
    if (typeof text === 'string' && text.length) sections.push({ label, text });
  };

  add('Input', request?.input);
  add('Instructions', request?.instructions);

  const body = request?.body;
  for (const message of body?.messages ?? []) {
    const role = typeof message?.role === 'string' ? message.role : 'Message';
    for (const text of textParts(message?.content)) add(role, text);
  }
  for (const item of body?.input ?? []) {
    const role = typeof item?.role === 'string' ? item.role : 'Input';
    for (const part of item?.content ?? [])
      if (typeof part?.text === 'string') add(role, part.text);
  }
  for (const question of body?.questions ?? [])
    add('Question instructions', question?.instructions);

  if (!sections.length && request != null)
    sections.push({ label: 'Request payload', text: raw });
  return { sections, raw };
}

export function formatModelResponse(response) {
  const raw =
    response == null
      ? 'No response captured.'
      : JSON.stringify(response, null, 2);
  const extracted = extractModelText(response);
  const candidate =
    extracted ?? (response == null ? '' : JSON.stringify(response));
  return { formatted: prettyJson(candidate) ?? candidate, raw };
}
