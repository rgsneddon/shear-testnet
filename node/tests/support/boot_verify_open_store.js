/**
 * One sealed-book open, in its own process so two restarts can run at once.
 * The parent owns the chain.bin bytes and the book.seal.
 */
import { auditCirculatingSupply } from '../../src/supply.js';
import { createStore } from '../../src/store.js';

process.on('message', async (msg) => {
  try {
    const opts = {
      loadNowMs: msg.loadNowMs,
      magic: msg.magic,
      oracleActivationHeight: msg.oracleActivationHeight,
      yieldForeign: msg.yieldForeign === true,
    };
    const store = msg.yieldForeign
      ? await createStore(msg.dir, opts)
      : createStore(msg.dir, opts);
    const supply = auditCirculatingSupply(store.blocks, { magic: msg.magic });
    process.send({
      loadMode: store.loadMode,
      height: store.tip().height,
      tip: Buffer.from(store.tip().hash).toString('hex'),
      status: supply.status,
      reason: supply.reason || '',
      circulating: String(supply.circulatingNanos),
    });
  } catch (err) {
    process.send({ error: err?.message || String(err) });
  } finally {
    process.exit(0);
  }
});
