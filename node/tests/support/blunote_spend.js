// R28 test support: a real fee-paying FS-1 send from a wallet's record
// coins (soloCoin), so a block that seats it carries the fee's levy note
// (an empty no-key round pays the finder levy with the reserve note). The
// proof is a real FS-1 proof against the store's own anchor; nothing here
// skips a check.
import assert from 'node:assert/strict';
import { walletAnchor } from '../../../crypto/admit_v3.js';
import { asU8 } from '../../../crypto/note.js';
import { buildSend, hiddenOut } from '../fs1_send_kit.js';

/**
 * The coins in `coins` that sit in the anchor a spend at the next height
 * names, each with its leaf index. Coins are { commit, r, v, x }.
 */
export function anchoredCoins(store, coins) {
  const height = store.tip().height + 1;
  const anchor = walletAnchor(height);
  if (anchor == null) return { anchor, live: null, coins: [] };
  const live = store.anchorNote(anchor);
  const at = new Map();
  for (let i = 0; i < (live?.n || 0); i += 1) at.set(Buffer.from(asU8(live.commits[i])).toString('hex'), i);
  const out = [];
  for (const c of coins) {
    const key = Buffer.from(c.commit).toString('hex');
    if (at.has(key)) out.push({ ...c, index: at.get(key) });
  }
  return { anchor, live, coins: out };
}

/**
 * A real FS-1 send of one anchored coin to `payee` ({ dest20, admitBase }),
 * with a dummy output, under the store's magic. Returns { tx, fee }.
 */
export function feeSend(store, coins, payee, id) {
  const view = anchoredCoins(store, coins);
  assert.ok(view.live && view.coins.length >= 1, `no anchored coin at anchor ${view.anchor}`);
  const coin = view.coins[0];
  const built = buildSend({
    id,
    coins: [{ index: coin.index, x: coin.x, r: coin.r, v: Number(coin.v), commit: coin.commit }],
    anchor: view.anchor,
    live: view.live,
    magic: store.magic,
    outsOf: (room) => [
      hiddenOut(room, payee.dest20, payee.admitBase, 'send'),
      hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
    ],
  });
  return { tx: built.tx, fee: built.tx.fee, coin };
}
