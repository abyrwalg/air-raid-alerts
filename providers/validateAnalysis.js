import { schema } from '../config.js';

export function parseAnalysis(content) {
  let result;
  try {
    result = JSON.parse(content);
  } catch {
    throw new Error('Analysis provider returned invalid JSON.');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Analysis provider returned an invalid object.');
  }
  for (const name of schema.required) {
    const rule = schema.properties[name];
    const value = result[name];
    const valid =
      rule.type === 'array'
        ? Array.isArray(value) &&
          value.every((item) => typeof item === 'string')
        : typeof value === rule.type &&
          (!rule.enum || rule.enum.includes(value));
    if (!valid)
      throw new Error(`Analysis provider returned an invalid ${name} field.`);
  }
  if (
    Object.keys(result).some((name) => !Object.hasOwn(schema.properties, name))
  ) {
    throw new Error('Analysis provider returned unexpected fields.');
  }
  return result;
}
