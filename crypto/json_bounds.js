/** Network JSON bounds. A body past the cap is refused before it is kept. Nesting past the cap is refused before JSON.parse. */
export const HTTP_BODY_MAX = 16 * 1024 * 1024;
export const JSON_MAX_DEPTH = 32;
export const STRATUM_LINE_MAX = 64 * 1024;

export function jsonNestingOk(text, max = JSON_MAX_DEPTH) {
  const s = String(text || '');
  if (s.length > HTTP_BODY_MAX) return false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === 0x5c) {
        esc = true;
        continue;
      }
      if (c === 0x22) inStr = false;
      continue;
    }
    if (c === 0x22) {
      inStr = true;
      continue;
    }
    if (c === 0x7b || c === 0x5b) {
      depth += 1;
      if (depth > max) return false;
    } else if (c === 0x7d || c === 0x5d) {
      if (depth === 0) return false;
      depth -= 1;
    }
  }
  return true;
}

export function parseBoundedJson(text, max = JSON_MAX_DEPTH) {
  if (!jsonNestingOk(text, max)) {
    const err = new Error('json_cap');
    err.code = 'json_cap';
    throw err;
  }
  return JSON.parse(text);
}
