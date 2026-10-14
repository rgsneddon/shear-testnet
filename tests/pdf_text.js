// Text of a PDF written by fpdf2: Identity-H fonts with a ToUnicode CMap,
// Flate content streams, and the Info dictionary. Enough for copy checks, not a
// general PDF reader.
import fs from 'node:fs';
import zlib from 'node:zlib';

function objects(buf) {
  const src = buf.toString('latin1');
  const out = new Map();
  const re = /(\d+) 0 obj\b/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endobj', start);
    if (end < 0) break;
    const raw = src.slice(start, end);
    const at = raw.indexOf('stream');
    let dict = raw;
    let stream = null;
    if (at >= 0) {
      dict = raw.slice(0, at);
      let s = start + at + 'stream'.length;
      if (src[s] === '\r') s += 1;
      if (src[s] === '\n') s += 1;
      const e = src.indexOf('endstream', s);
      let body = buf.subarray(s, e);
      if (/\/FlateDecode/.test(dict)) {
        try { body = zlib.inflateSync(body); } catch { body = zlib.inflateSync(body.subarray(0, body.length - 1)); }
      }
      stream = body.toString('latin1');
    }
    out.set(Number(m[1]), { dict, stream });
    re.lastIndex = end;
  }
  return out;
}

function hexCodes(hex) {
  const h = hex.replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i < h.length; i += 4) out.push(parseInt(h.slice(i, i + 4), 16));
  return out;
}

function utf16(hex) {
  const codes = hexCodes(hex);
  return String.fromCharCode(...codes);
}

function parseCmap(text) {
  const map = new Map();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(src, 16), utf16(dst));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, dst] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const a = parseInt(lo, 16);
      const b = parseInt(hi, 16);
      const base = parseInt(dst, 16);
      for (let c = a; c <= b; c += 1) map.set(c, String.fromCharCode(base + (c - a)));
    }
  }
  return map;
}

function literalBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch !== '\\') { out.push(s.charCodeAt(i) & 0xff); continue; }
    i += 1;
    const e = s[i];
    const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    if (e in esc) out.push(esc[e]);
    else if (/[0-7]/.test(e)) {
      let oct = e;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1])) { i += 1; oct += s[i]; }
      out.push(parseInt(oct, 8) & 0xff);
    } else if (e === '\r' || e === '\n') {
      if (e === '\r' && s[i + 1] === '\n') i += 1;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return out;
}

function decode(bytes, cmap) {
  if (!cmap) return String.fromCharCode(...bytes);
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) out += cmap.get((bytes[i] << 8) | bytes[i + 1]) ?? '';
  return out;
}

function runContent(stream, fonts) {
  let out = '';
  let cmap = null;
  const tok = /\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|\((?:\\[\s\S]|[^\\)])*\)|<[0-9a-fA-F\s]*>|\bET\b|\bTd\b|\bT\*|\bTD\b/g;
  let m;
  while ((m = tok.exec(stream))) {
    const t = m[0];
    if (m[1]) cmap = fonts.get(m[1]) || null;
    else if (t[0] === '(') out += decode(literalBytes(t.slice(1, -1)), cmap);
    else if (t[0] === '<') {
      const h = t.slice(1, -1).replace(/\s+/g, '');
      const bytes = [];
      for (let i = 0; i < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
      out += decode(bytes, cmap);
    } else out += ' ';
  }
  return out;
}

export function pdfText(file) {
  const buf = fs.readFileSync(file);
  const objs = objects(buf);
  const ref = (dict, key) => {
    const m = dict.match(new RegExp(`/${key}\\s+(\\d+) 0 R`));
    return m ? Number(m[1]) : null;
  };
  const cmapOf = new Map();
  for (const [n, o] of objs) {
    const id = ref(o.dict, 'ToUnicode');
    if (id != null && objs.get(id)?.stream) cmapOf.set(n, parseCmap(objs.get(id).stream));
  }
  const parts = [];
  for (const o of objs.values()) {
    if (!/\/Type\s*\/Page\b/.test(o.dict)) continue;
    const resId = ref(o.dict, 'Resources');
    const res = resId != null ? objs.get(resId).dict : o.dict;
    const fonts = new Map();
    const fontDict = res.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (fontDict) {
      for (const [, name, id] of fontDict[1].matchAll(/\/([A-Za-z0-9]+)\s+(\d+) 0 R/g)) {
        fonts.set(name, cmapOf.get(Number(id)) || null);
      }
    }
    const contents = ref(o.dict, 'Contents');
    if (contents != null && objs.get(contents)?.stream) parts.push(runContent(objs.get(contents).stream, fonts));
  }
  for (const o of objs.values()) {
    for (const key of ['Title', 'Subject', 'Keywords', 'Author', 'Creator']) {
      const lit = o.dict.match(new RegExp(`/${key}\\s*\\(((?:\\\\[\\s\\S]|[^\\\\)])*)\\)`));
      if (lit) {
        const bytes = literalBytes(lit[1]);
        parts.push(bytes[0] === 0xfe && bytes[1] === 0xff
          ? String.fromCharCode(...bytes.slice(2).reduce((a, b, i) => (i % 2 ? (a[a.length - 1] |= b, a) : (a.push(b << 8), a)), []))
          : Buffer.from(bytes).toString('latin1'));
      }
    }
  }
  return parts.join('\n').replace(/[ \t]+/g, ' ');
}
