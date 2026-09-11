import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

describe('forbid privacy regressions', () => {
  it('payoutDest is not a payable mapping for payment codes', () => {
    const src = read('crypto/address.js');
    assert.match(src, /export function payoutDest/);
    assert.match(src, /Payment codes are not payable/);
    assert.doesNotMatch(src, /return encodeDest\(pay\.hash20\)/);
    const hasher = read('crypto/flow_sheet.js');
    assert.match(hasher, /aliasDestOfSilentId/);
    assert.doesNotMatch(hasher, /Never encodeDest\(she1\.hash20\)[\s\S]*destAtIndex\(id/);
  });

  it('memoKey is not dest-only', () => {
    const src = read('crypto/flow_sheet.js');
    assert.match(src, /MEMO_DOMAIN/);
    assert.match(src, /export function memoKey\(dest, shared\)/);
    assert.match(src, /if \(shared == null \|\| shared === ''\) return null/);
    assert.doesNotMatch(src, /function memoKey\(dest\) \{\s*const d = hash20FromAddress/);
  });

  it('spendPub is bound to dest20; compactTx is on persist paths', () => {
    const spend = read('crypto/spend.js');
    assert.match(spend, /destMatchesSpendPub/);
    const addr = read('crypto/address.js');
    assert.match(addr, /destCommitFromSpendPub/);
    assert.match(read('crypto/chainbin.js'), /compactTx/);
    assert.match(read('node/src/p2p.js'), /compactTx/);
    assert.match(read('node/src/store.js'), /compactTx/);
  });

  it('open-round and lattice miner tags are opaque m-hex, not she1', () => {
    const api = read('pool/src/wallet_api.js');
    assert.match(api, /function publicHashTag/);
    assert.doesNotMatch(api, /return `she1\$\{createHash/);
    assert.match(api, /return `m\$\{hex\}`/);
    const store = read('node/src/store.js');
    assert.match(store, /\^m\[0-9a-f\]\{8\}\$/);
    const pool = read('pool/src/pool.js');
    assert.match(pool, /export function publicMinerTag/);
    assert.match(pool, /return `m\$\{hex\}`/);
  });

  it('verifyBlock typed HRP is the she/shear check, not containsShe1(JSON) alone', () => {
    const src = read('node/src/chain.js');
    assert.match(src, /checkAddressField|checkTxAddressFields/);
    assert.match(src, /silent_id_on_chain/);
    assert.match(src, /rest_frame_on_chain/);
    const onlyJson = src.includes('containsShe1(tx)') && !src.includes('checkAddressField') && !src.includes('checkTxAddressFields');
    assert.equal(onlyJson, false);
  });
});
