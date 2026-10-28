const tokenPattern =
  /("(?:\\.|[^"\\])*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\],:])|(\s+)|./gy;

export function tokenizeJson(text) {
  if (typeof text !== 'string') return null;
  try {
    JSON.parse(text);
  } catch {
    return null;
  }

  const tokens = [];
  tokenPattern.lastIndex = 0;
  let match;
  while ((match = tokenPattern.exec(text))) {
    const [raw, quoted, number, literal, punctuation, whitespace] = match;
    let type = 'punctuation';
    if (quoted) {
      const remainder = text.slice(tokenPattern.lastIndex);
      type = /^\s*:/.test(remainder) ? 'key' : 'string';
    } else if (number) type = 'number';
    else if (literal === 'true' || literal === 'false') type = 'boolean';
    else if (literal === 'null') type = 'null';
    else if (whitespace) type = 'whitespace';
    else if (punctuation) type = 'punctuation';
    tokens.push({ type, text: raw });
  }
  return tokens;
}

export function highlightJsonElement(element, text) {
  const tokens = tokenizeJson(text);
  if (!tokens) {
    element.textContent = text;
    return false;
  }
  const fragment = element.ownerDocument.createDocumentFragment();
  for (const token of tokens) {
    if (token.type === 'whitespace') {
      fragment.append(element.ownerDocument.createTextNode(token.text));
    } else {
      const span = element.ownerDocument.createElement('span');
      span.className = `json-${token.type}`;
      span.textContent = token.text;
      fragment.append(span);
    }
  }
  element.replaceChildren(fragment);
  return true;
}
