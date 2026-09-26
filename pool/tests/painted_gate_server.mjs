import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { NANOS_PER_SHE } from '../../crypto/asert.js';
import { emptyVault } from '../../crypto/reserve_vault.js';
import { createStore } from '../../node/src/store.js';
import { createPullBook } from '../src/pull_book.js';
import { handleWalletApi } from '../src/wallet_api.js';

const chainNanos = Math.round(0.02 * NANOS_PER_SHE);
const owedShe = Number(process.env.SHEAR_PAINTED_OWED_SHE || '22.58');
const owedNanos = Math.round((Number.isFinite(owedShe) ? owedShe : 0) * NANOS_PER_SHE);

const store = {
  blocks: [],
  mempool: [],
  tip: () => ({ height: 40 }),
  historyFor: (addr) => [{
    id: 'cb-thin',
    from: 'coinbase',
    to: addr,
    nanos: chainNanos,
    height: 10,
    kind: 'coinbase',
  }],
  reserveVault: emptyVault(),
  vortice: { issued: Object.create(null) },
};

const pullBook = createPullBook(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-painted-book-')));
const owedDest = String(process.env.SHEAR_PAINTED_OWED_DEST || '').trim();
if (owedDest && owedNanos > 0) {
  const credited = pullBook.creditRound(
    [{ tag: 'painted-gate', dest: owedDest, count: 1 }],
    { height: 1, nanos: owedNanos },
  );
  if (!credited || credited.ok === false) {
    process.stderr.write(`painted credit failed ${JSON.stringify(credited)}\n`);
  }
}

const chain = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-painted-gate-')));
let n = 0;
function queueSend(draft, meta) {
  n += 1;
  const owedRaw = Number(meta && meta.paintedOwedNanos);
  const paintedOwedNanos = Number.isFinite(owedRaw) && owedRaw > 0 ? Math.floor(owedRaw) : 0;
  const tx = { ...draft, id: draft.id || `tx-${n}` };
  const got = chain.queueTx(tx, paintedOwedNanos > 0 ? { paintedOwedNanos } : {});
  if (!got || got.ok === false) return got;
  return got.tx || tx;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    if (String(req.method || 'GET').toUpperCase() === 'POST') {
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      try {
        body = JSON.parse(raw);
      } catch {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: false, reason: 'bad_json' }));
        return;
      }
    }
    const out = handleWalletApi(url, req.method, body, {
      store,
      miners: new Map(),
      queueSend,
      pullBook,
    });
    if (!out) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, reason: 'not_found' }));
      return;
    }
    res.statusCode = out.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out.json));
    if (out.status !== 200 && url.pathname === '/api/wallet/send') {
      process.stderr.write(`SEND ${out.status} ${out.json && out.json.reason}\n`);
    }
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, reason: String(err && err.message || err) }));
  }
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(`PORT ${addr.port}\n`);
});
