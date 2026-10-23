#!/usr/bin/env node
/**
 * Drive a wallet-posted reserve body through handleWalletApi.
 * The posted fee must equal levyNeed of the draft the pool actually queues.
 * Usage: node tests/verify_posted_reserve.mjs <tx.json>
 */
import fs from 'node:fs';
import { MAGIC_TESTNET, NANOS_PER_SHE } from '../crypto/asert.js';
import { levyNeed, LEVY_FLOOR_UNITS } from '../crypto/levy.js';
import { emptyVault } from '../crypto/reserve_vault.js';
import { handleWalletApi } from '../pool/src/wallet_api.js';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: node tests/verify_posted_reserve.mjs <tx.json>\n');
  process.exit(2);
}
const body = JSON.parse(fs.readFileSync(path, 'utf8'));
const from = String(body.from || '');
const rows = [{
  id: 'cb',
  from: 'coinbase',
  to: from,
  nanos: 10 * NANOS_PER_SHE,
  height: 1,
  kind: 'coinbase',
}];
const store = {
  blocks: [],
  historyFor: (addr) => rows.filter((r) => r.to === addr || r.from === addr),
  tip: () => ({ height: 20 }),
  mempool: [],
  reserveVault: emptyVault(MAGIC_TESTNET),
  vortice: { issued: Object.create(null) },
};
const posted = [];
const queueSend = (t) => {
  const tx = { id: `tx-${posted.length + 1}`, ...t };
  posted.push(tx);
  return tx;
};
const got = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', body, {
  store,
  miners: new Map(),
  queueSend,
});
const tx = posted[0] || null;
const need = tx ? levyNeed(tx) : null;
const fee = tx && tx.fee != null ? tx.fee : null;
const ok = got.status === 200
  && tx
  && fee === need
  && fee >= LEVY_FLOOR_UNITS
  && String(tx.kind) === String(body.kind || '');
process.stdout.write(`${JSON.stringify({
  status: got.status,
  reason: got.json && got.json.reason,
  fee,
  need,
  equal: fee === need,
  kind: tx && tx.kind,
})}\n`);
process.exit(ok ? 0 : 1);
