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
