/**
 * Loads one datadir and appends one share block.
 * The parent compares the voted unit with the template, the reserve view,
 * and getreserve. A second process does not share the parent's book.
 */
import { createStore } from '../src/store.js';
import { createRpc } from '../src/rpc.js';
import { decodeHeader } from '../../crypto/header.js';
import { publicVaultView } from '../../crypto/reserve_vault.js';

const dir = process.argv[2];
const dest = process.argv[3];
if (!dir || !dest) {
  process.stderr.write('dir dest\n');
  process.exit(2);
}

const storeOpts = {
  snapEvery: 0,
  firstCheckpoint: 1_000_000,
  checkpointEvery: 1_000_000,
  diskJournal: true,
  pruneAfter: 1_000_000,
};

async function main() {
  const store = createStore(dir, storeOpts);
  const tip = store.tip();
  const ts = Number(decodeHeader(Buffer.from(tip.header)).timestamp);
  const before = Number(store.reserveVault.liveHashBonusNanos);
  const view = Number(publicVaultView(store.reserveVault, ts).liveHashBonusNanos);
  const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
  const reserve = rpc.dispatch('getreserve', {});
  const { tpl } = store.template({ miner: dest, shareBits: 4, now: ts + 90_000 });
  const pow = Buffer.alloc(32);
  pow.writeUInt32BE(0x5a110001, 28);
  const got = await Promise.resolve(store.append({
    header: tpl.header,
    height: tpl.height,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: pow, skipSharePow: true }));
  const after = Number(store.reserveVault.liveHashBonusNanos);
  const out = {
    before,
    view,
    rpc: Number(reserve.liveHashBonusNanos),
    appendOk: got.ok === true,
    reason: got.reason || '',
    after,
    height: Number(store.tip()?.height || 0),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  await rpc.close();
  const agreed = before === 0 && after === 0 && view === 0 && out.rpc === 0 && out.appendOk;
  process.exit(agreed ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
