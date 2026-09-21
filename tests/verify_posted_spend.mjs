#!/usr/bin/env node
/**
 * Drive a wallet-posted /api/wallet/send body through tip verifySpendSig.
 * Usage: node tests/verify_posted_spend.mjs <tx.json>
 */
import fs from 'node:fs';
import { verifySpendSig, spendPackDigest, verifyReservePortalOpen } from '../crypto/spend.js';
import { verifySealedNote } from '../crypto/note.js';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: node tests/verify_posted_spend.mjs <tx.json>\n');
  process.exit(2);
}
const tx = JSON.parse(fs.readFileSync(path, 'utf8'));
const sigOk = verifySpendSig(tx);
const portalOk = verifyReservePortalOpen(tx);
const kind = String(tx.kind || tx.vout?.[0]?.kind || '');
let sealOk = true;
if (kind === 'lock' || kind === 'vote' || kind === 'withdraw') {
  const o = Array.isArray(tx.vout) ? tx.vout[0] : null;
  const v = o?.valueProof?.v != null ? Number(o.valueProof.v) : Number(o?.nanos || 0);
  sealOk = !!(o && o.commit && verifySealedNote(o, v));
}
const ok = sigOk && portalOk && sealOk;
process.stdout.write(`${JSON.stringify({
  ok,
  sigOk,
  portalOk,
  sealOk,
  reason: ok ? undefined : 'unsigned',
  digest: spendPackDigest(tx).toString('hex'),
})}\n`);
process.exit(ok ? 0 : 1);
