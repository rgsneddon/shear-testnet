/**
 * Our chain by hash, kept in step with the chain as it grows. Blocks link to
 * their parent, so when the entry at the last indexed tip is still that tip,
 * every entry below it is unchanged and only the new top is added: IBD costs
 * O(1) per block, not a rebuild of the whole map per tip. Anything else (a
 * reorg, a shorter chain) rebuilds once.
 */

function hexHash(h) {
  if (Buffer.isBuffer(h) || h instanceof Uint8Array) return Buffer.from(h).toString('hex').toLowerCase();
  return String(h || '').replace(/^0x/i, '').toLowerCase();
}

export function emptyChainIndex() {
  return { len: 0, tip: '', map: new Map() };
}

/** Bring `index` up to `list`. Returns how many entries were hexed. */
export function syncChainIndex(index, list) {
  const len = list.length;
  if (index.len === len && (len === 0 || hexHash(list[len - 1].hash) === index.tip)) return 0;
  let from = 0;
  if (index.len > 0 && index.len <= len && hexHash(list[index.len - 1].hash) === index.tip) {
    from = index.len;
  } else {
    index.map = new Map();
  }
  for (let i = from; i < len; i += 1) index.map.set(hexHash(list[i].hash), i);
  index.len = len;
  index.tip = len ? hexHash(list[len - 1].hash) : '';
  return len - from;
}

/** Height index of `hash` in `list`, or -1. */
export function chainIndexOf(index, list, hash) {
  syncChainIndex(index, list);
  const at = index.map.get(hexHash(hash));
  return at == null ? -1 : at;
}
