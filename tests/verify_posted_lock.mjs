#!/usr/bin/env node
/**
 * Drive a wallet-posted FS-1 Vault lock body through the node's own checks.
 * Usage: node tests/verify_posted_lock.mjs <case.json>
 *   case.json = { tx: <posted body>, live: { pubs: [hex], commits: [hex] }, height }
 *
 * An FS-1 lock carries no identity spend key (no sig, no spendPub):
 *   reserveAuth         lockAuth is the owner signature over this portal and
 *                       leaf, and a fresh portal is bound to that key;
 *   verifyFlowAdmitFs1  the FS-1 spend of every input over the live admit set,
 *                       bound to the posted body digest and anchor;
 *   lockQualifies       the lock commitment is one π (piProof).
 */
import fs from 'node:fs';
import { reserveAuth } from '../crypto/spend.js';
import { verifyFlowAdmitFs1 } from '../crypto/admit_v3.js';
import { lockQualifies } from '../crypto/reserve_vault.js';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: node tests/verify_posted_lock.mjs <case.json>\n');
  process.exit(2);
}
const c = JSON.parse(fs.readFileSync(path, 'utf8'));
const tx = c.tx;
const hex = (v) => Buffer.from(String(v), 'hex');
const live = {
  n: c.live.pubs.length,
  pubs: c.live.pubs.map(hex),
  commits: c.live.commits.map(hex),
};
const auth = reserveAuth(tx);
const admit = verifyFlowAdmitFs1(tx, { height: Number(c.height), noteAtAnchor: () => live });
const lock = (Array.isArray(tx.vout) ? tx.vout : []).find((o) => String(o?.kind || '') === 'lock');
const piOk = !!(lock && lock.commit && lockQualifies(lock.commit, tx.piProof));
const identityKeyOff = !tx.sig && !tx.spendPub;
const ok = auth.ok === true && admit.ok === true && piOk && identityKeyOff;
process.stdout.write(`${JSON.stringify({
  ok,
  authOk: auth.ok === true,
  authReason: auth.reason,
  admitOk: admit.ok === true,
  admitReason: admit.reason,
  piOk,
  identityKeyOff,
})}\n`);
process.exit(ok ? 0 : 1);
