#!/usr/bin/env node
/**
 * Drive a wallet-posted /api/wallet/send body through tip verifySpendSig.
 * Usage: node tests/verify_posted_spend.mjs <tx.json>
 */
import fs from 'node:fs';
import { verifySpendSig, spendPackDigest } from '../crypto/spend.js';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: node tests/verify_posted_spend.mjs <tx.json>\n');
  process.exit(2);
}
const tx = JSON.parse(fs.readFileSync(path, 'utf8'));
const ok = verifySpendSig(tx);
process.stdout.write(`${JSON.stringify({
  ok,
  reason: ok ? undefined : 'unsigned',
  digest: spendPackDigest(tx).toString('hex'),
})}\n`);
process.exit(ok ? 0 : 1);
