import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createRpc } from '../src/rpc.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-painted-rpc-'));
const store = createStore(dir);
const logPath = String(process.env.SHEAR_PAINTED_QUEUE_LOG || '').trim();
const inner = store.queueTx.bind(store);
store.queueTx = (tx, opts) => {
  const got = inner(tx, opts);
  if (logPath) {
    const owedRaw = Number(opts && opts.paintedOwedNanos);
    const owed = Number.isFinite(owedRaw) && owedRaw > 0 ? Math.floor(owedRaw) : 0;
    fs.appendFileSync(logPath, `${JSON.stringify({
      ok: !!(got && got.ok !== false),
      reason: got && got.reason ? String(got.reason) : '',
      kind: tx && tx.kind ? String(tx.kind) : '',
      id: String((got && got.tx && got.tx.id) || (tx && tx.id) || ''),
      owed,
    })}\n`);
  }
  return got;
};

const port = Number(process.env.SHEAR_RPC_PORT || 18332);
const rpc = createRpc({ store, port, host: '127.0.0.1' });
try {
  const bound = await rpc.listen();
  process.stdout.write(`PORT ${bound.port}\n`);
} catch (err) {
  process.stderr.write(`listen ${err && err.message ? err.message : err}\n`);
  process.exit(1);
}
