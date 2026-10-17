import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SEND_PATH = [
  'wallet/lib/shear_ledger.dart',
  'wallet/lib/shear_admit.dart',
  'wallet/lib/shear_fs1.dart',
  'wallet/lib/shear_admit_ffi.dart',
  'wallet/lib/shear_native_prove.dart',
  'crypto/wallet_native_prove.mjs',
];

const PROVER_BAN_FILES = [
  'wallet/lib/shear_admit.dart',
  'wallet/lib/shear_fs1.dart',
  'wallet/lib/shear_native_prove.dart',
];

const RETIRED_PROVER = /\b(?:proveFlowSpend|nativeProveFlowSpend|admitProve)\b/;
const FS1_PROVE = /\b(?:Fs1Native|shear_fs1_prove)\b/;

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/** Dart source with comments removed. Strings, including raw strings, stay. */
function dartCode(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i = Math.min(src.length, i + 2);
      continue;
    }
    if ((c === 'r' || c === 'R') && (n === "'" || n === '"')) {
      const start = i;
      i = endOfDartString(src, i + 1);
      out += src.slice(start, i);
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      i = endOfDartString(src, i);
      out += src.slice(start, i);
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function endOfDartString(src, i) {
  const q = src[i];
  const triple = src[i + 1] === q && src[i + 2] === q;
  if (triple) {
    i += 3;
    while (i < src.length && !(src[i] === q && src[i + 1] === q && src[i + 2] === q)) i += 1;
    return Math.min(src.length, i + 3);
  }
  i += 1;
  while (i < src.length && src[i] !== q) {
    if (src[i] === '\\') i += 2;
    else if (src[i] === '\n') break;
    else i += 1;
  }
  return Math.min(src.length, i + 1);
}

/** Brace body of `name`, after comments are gone. A // or /* mention does not count. */
function functionBody(src, name) {
  const code = dartCode(src);
  const at = code.search(new RegExp(`\\b${name}\\s*\\(`));
  if (at < 0) throw new Error(`missing ${name}`);
  let i = at;
  let paren = 0;
  let sawParen = false;
  for (; i < code.length; i += 1) {
    const c = code[i];
    if (c === "'" || c === '"') {
      i = endOfDartString(code, i) - 1;
      continue;
    }
    if (c === '(') {
      paren += 1;
      sawParen = true;
    } else if (c === ')') {
      paren -= 1;
      if (sawParen && paren === 0) {
        i += 1;
        break;
      }
    }
  }
  while (i < code.length && /\s/.test(code[i])) i += 1;
  if (code[i] !== '{') throw new Error(`${name} has no brace body`);
  let depth = 0;
  const open = i;
  for (; i < code.length; i += 1) {
    const c = code[i];
    if (c === "'" || c === '"') {
      i = endOfDartString(code, i) - 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error(`unclosed ${name}`);
}

describe('C2 ADMITv1 quarantine on v4 send path', () => {
  it('wallet v4 send path has no shear-admit-v1 / bit-OR prove', () => {
    const joined = SEND_PATH.map(read).join('\n');
    assert.doesNotMatch(joined, /shear-admit-v1/);
    assert.doesNotMatch(joined, /bit\s*\|\s*prove/i);
    for (const rel of PROVER_BAN_FILES) {
      assert.doesNotMatch(read(rel), RETIRED_PROVER, rel);
    }
    const admit = read('wallet/lib/shear_admit.dart');
    assert.match(admit, /const String kErrSendUnavailable = 'send unavailable until FS-1'/);
    assert.doesNotMatch(admit, /throw StateError\(kErrSendUnavailable\)/);
    assert.match(
      read('crypto/wallet_native_prove.mjs'),
      /op === 'prove_spend'[\s\S]{0,240}send unavailable until FS-1/,
    );
    const fs1 = read('wallet/lib/shear_fs1.dart');
    assert.match(fs1, /Map<String, dynamic> proveFs1SpendWire\(/);
    const body = functionBody(fs1, 'proveFs1SpendWire');
    assert.match(body, FS1_PROVE);
    assert.match(
      read('wallet/lib/shear_ledger.dart'),
      /reproveFlowSpendWire\(Map<String, dynamic> input\) => proveFs1SpendWire\(input\)/,
    );
  });

  it('a comment cannot satisfy the FS-1 prove body', () => {
    const commented = `
      Map<String, dynamic> proveFs1SpendWire(Map<String, dynamic> input) {
        // Fs1Native shear_fs1_prove
        /* Fs1Native */
        return <String, dynamic>{};
      }
    `;
    assert.equal(FS1_PROVE.test(functionBody(commented, 'proveFs1SpendWire')), false);
    const called = `
      Map<String, dynamic> proveFs1SpendWire(Map<String, dynamic> input) {
        // not the call
        final lib = Fs1Native.tryLoad();
        return <String, dynamic>{'lib': lib};
      }
    `;
    assert.match(functionBody(called, 'proveFs1SpendWire'), FS1_PROVE);
  });

  it('intentional fixture still matches the grep (CI red on fixture, green on tree)', () => {
    const fixture = 'shear-admit-v1 bit-OR prove leftover';
    assert.match(fixture, /shear-admit-v1/);
    assert.match(fixture, /bit-OR prove/);
  });
});
