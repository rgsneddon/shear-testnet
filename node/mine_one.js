/**
 * Mine one ADMITv2 block into SHEAR_DATA. Used on the soak VPS so peer-1
 * leaves height 0; peer-2 then syncs the same post-genesis jroot.
 *
 *   SHEAR_DATA=/var/lib/shear/testnet-v4 node node/mine_one.js
 */
import { createStore } from './src/store.js';
import { mineTemplate } from './src/chain.js';
import { newIdentity, freshStealthDest } from '../crypto/address.js';

const dir = process.env.SHEAR_DATA;
if (!dir) {
  console.error('SHEAR_DATA required');
  process.exit(2);
}

const store = createStore(dir);
const before = store.tip();
const id = newIdentity();
const dest = freshStealthDest(id.paymentCode).dest;
const { tpl } = store.template({ miner: dest });
const found = mineTemplate(tpl, { maxTries: 8_000_000, shareBits: tpl.bits });
if (!found || !found.block) {
  console.log(JSON.stringify({ ok: false, reason: 'pow', height: before?.height || 0 }));
  process.exit(1);
}
const got = await store.append({
  header: found.header,
  txs: tpl.txs,
  samples: tpl.samples,
  shareBatch: tpl.shareBatch || [],
  miner: dest,
  aLeaves: tpl.aLeaves,
  bLeaves: tpl.bLeaves,
  rootA: tpl.rootA,
  rootB: tpl.rootB,
  weight: tpl.weight,
});
const tip = store.tip();
const jr = store.jroot();
console.log(JSON.stringify({
  ok: !!got?.ok,
  reason: got?.reason || got?.error || null,
  height: tip?.height || 0,
  prevHeight: before?.height || 0,
  jroot: jr ? Buffer.from(jr).toString('hex') : '',
  magic: 'shear-testnet-v4',
  admit: 'ADMITv2',
}));
if (!got?.ok) process.exit(1);
