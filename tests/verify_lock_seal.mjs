import fs from 'node:fs';
import { verifySealedNote } from '../crypto/note.js';
import { emptyVault, reserveAction, verifyReservePayout } from '../crypto/reserve_vault.js';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: node tests/verify_lock_seal.mjs <tx.json>\n');
  process.exit(2);
}
const tx = JSON.parse(fs.readFileSync(path, 'utf8'));
const o = Array.isArray(tx.vout) ? tx.vout[0] : null;
const v = o?.valueProof?.v != null ? Number(o.valueProof.v) : Number(o?.nanos || 0);
// A v12 lock keeps its amount hidden: no published value, a range proof
// under H on the commit, decoded by consensus reserveAction. A body that
// publishes the value is checked as the sealed note it claims to be.
const hidden = !!(o && o.commit && !(v > 0));
const sealOk = hidden
  ? reserveAction({ ...tx, kind: tx.kind || 'lock' })?.opened === true
  : !!(o && o.commit && verifySealedNote(o, v));
const pay = verifyReservePayout(emptyVault(), { ...tx, kind: tx.kind || 'lock', vout: tx.vout });
const ok = sealOk && pay.ok === true;
process.stdout.write(`${JSON.stringify({
  ok,
  sealOk,
  hidden,
  v,
  reason: pay.reason,
})}\n`);
process.exit(ok ? 0 : 1);
