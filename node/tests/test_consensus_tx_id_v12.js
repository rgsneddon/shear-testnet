/**
 * A tx's `id` is a label its sender picks. Outside a withdraw, whose id is
 * signed and inside the merkle leaf (reserveDigestSuffix), it is in no digest,
 * so consensus code must never resolve, compare, or key anything by it.
 * chain.js resolved a vin's prev by `String(tx.id) === String(vin.prev)` in
 * lookupSpentVout, unreachable since the v4 cut (95817cad) and deleted. Its
 * one id read now is digestTx dropping the id from the body-v2 leaf outside a
 * withdraw (ruling 5, Russell 26 Oct).
 *
 * Every read of an id field in the consensus modules is listed here by file
 * and enclosing function, with its reason. A new one fails until it is
 * reviewed and listed; a listed one that is gone fails too, so the list stays
 * exact. crypto/mempool.js is the policy book, not consensus: it keys held
 * bodies by their own bytes (txBodyKey; test_fs1_spend_v12.js).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// A portal's id is its signed portalId (reservePortalRef reads tx.portalId,
// which reserveDigestSuffix binds), not a tx id.
const PORTAL = 'a portal id (the signed portalId), not a tx id';
const ALLOWED = {
  'node/src/chain.js': {
    digestTx: 'drops the id from the body-v2 leaf outside a withdraw (ruling 5): it removes the label, compares nothing',
  },
  'crypto/reserve_vault.js': {
    reserveDigestSuffix: 'a withdraw signs its id: the id is inside the merkle leaf and the owner signature',
    buildFundedWithdraw: 'assigns the id of a withdraw body being built, compares nothing',
    stakeRewardsDue: PORTAL,
    rewardAlreadyMinted: PORTAL,
    portalPublic: PORTAL,
    hiddenPrincipalOpens: PORTAL,
    hiddenWithdrawOpening: PORTAL,
    verifyReservePayout: PORTAL,
    principalProofReused: PORTAL,
    indexedWithdrawQuote: PORTAL,
    withdraw: PORTAL,
  },
  'crypto/spend.js': {
    reserveWithdrawMintId: PORTAL,
    reserveAuth: PORTAL,
    boundReserveWithdraw: PORTAL,
  },
  'crypto/share_dag.js': {
    sealShareDag: 'DINS share ids, which addShare takes from the share noteCommit; not on the node or pool path',
    addShare: 'keys a share by its noteCommit; not on the node or pool path',
  },
  'crypto/hash_offloop_worker.js': { '(module)': 'the worker message id, not a tx id' },
  'crypto/fund_verdict.js': {
    fundingWitness: 'cache key over the whole funding witness, every proof included; decides no validity',
  },
  'crypto/chronoflux.js': {
    sealedExplorerRows: 'explorer row ids for display',
    compactTx: 'copies oracle report ids (a report field, not a tx id)',
  },
  'crypto/dummy.js': { publicExplorerRow: 'explorer row id for display' },
  'crypto/flow_sheet.js': { explorerRowPublic: 'explorer row id for display' },
  'crypto/claim_fee.js': { '*': 'fee preset ids, not tx ids' },
  'crypto/reserve_oracle.js': { '*': 'oracle report ids, not tx ids' },
  'crypto/vortex.js': { '*': 'vortex program ids, not tx ids' },
};

// Property reads of an id, destructured ids, and bracket reads.
const ID_READ = /(?:\??\.id\b(?!\s*:)|\[\s*['"]id['"]\s*\]|\{[^}]*\bid\b[^}]*\}\s*=\s*\w)/;
const FN = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*\(|^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/;

function consensusFiles() {
  const crypto = fs.readdirSync(path.join(root, 'crypto'))
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'mempool.js')
    .map((f) => `crypto/${f}`);
  return ['node/src/chain.js', ...crypto];
}

/** [{ file, fn, line, text }] for every id read, with its top-level enclosing function. */
function idReads(rel) {
  const lines = fs.readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/);
  const out = [];
  let fn = '(module)';
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    // A top-level declaration starts at column 0.
    const m = /^\S/.test(text) ? FN.exec(text) : null;
    if (m) fn = m[1] || m[2];
    const code = text.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    if (!ID_READ.test(code)) continue;
    if (/console\.(error|log|warn)\(/.test(code)) continue;
    out.push({ file: rel, fn, line: i + 1, text: text.trim() });
  }
  return out;
}

describe('consensus never decides by a tx id the sender picks', () => {
  it('chain.js reads an id only to drop it from a non-withdraw leaf', () => {
    assert.deepEqual(idReads('node/src/chain.js').map(({ fn, text }) => ({ fn, text })), [
      { fn: 'digestTx', text: "if (String(body.kind || '') !== 'withdraw') delete body.id;" },
    ]);
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'node/src/chain.js'), 'utf8'), /lookupSpentVout/);
  });

  it('every id read in the consensus modules is listed by function, with its reason', () => {
    const seen = new Set();
    const unlisted = [];
    for (const rel of consensusFiles()) {
      for (const hit of idReads(rel)) {
        const book = ALLOWED[rel] || {};
        const key = book[hit.fn] ? hit.fn : (book['*'] ? '*' : null);
        if (!key) {
          unlisted.push(`${rel}:${hit.line} ${hit.fn}: ${hit.text}`);
          continue;
        }
        seen.add(`${rel}#${key}`);
      }
    }
    assert.deepEqual(unlisted, [], 'an id read in consensus code: review it, then list it here with its reason');
    const stale = Object.entries(ALLOWED).flatMap(([rel, book]) => Object.keys(book)
      .filter((fn) => !seen.has(`${rel}#${fn}`)).map((fn) => `${rel}#${fn}`));
    assert.deepEqual(stale, [], 'a listed id read is gone: drop it from the list');
  });

  it('the withdraw binding is the only id inside a digest', () => {
    const src = fs.readFileSync(path.join(root, 'crypto/reserve_vault.js'), 'utf8').replace(/\r\n/g, '\n');
    const at = src.indexOf('export function reserveDigestSuffix(');
    assert.ok(at > 0);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    assert.match(body, /if \(fields\.kind === KIND_WITHDRAW\) \{\n\s+parts\.push\(lenPrefUtf8\(String\(tx\?\.id \|\| ''\)\)\);/);
    assert.equal(body.split('.id').length - 1, 1, 'one id in the reserve digest, under the withdraw branch');
  });
});
