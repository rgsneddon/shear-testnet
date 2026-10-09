/**
 * Node-local funding verdicts, keyed by tx digest, anchor, and anchor root.
 * queueTx writes a row only after verifyTypedAdmitFunding returns ok.
 * A tx field or RPC option cannot set a row. The template still re-checks
 * the anchor window, spent tags, and the live anchor root before a hit.
 */
const fundVerdicts = new Map();
const FUND_VERDICT_MAX = 8192;

function fundKey(digestHex, anchor, rootHex) {
  return `${digestHex}|${Number(anchor)}|${rootHex}`;
}

export function rememberFundVerdict(digestHex, anchor, rootHex, tags) {
  if (typeof digestHex !== 'string' || digestHex.length !== 64) return false;
  if (!Number.isInteger(anchor)) return false;
  if (typeof rootHex !== 'string' || rootHex.length !== 64) return false;
  if (!Array.isArray(tags) || tags.length < 1) return false;
  const key = fundKey(digestHex, anchor, rootHex);
  if (fundVerdicts.size >= FUND_VERDICT_MAX && !fundVerdicts.has(key)) {
    const first = fundVerdicts.keys().next().value;
    if (first !== undefined) fundVerdicts.delete(first);
  }
  fundVerdicts.set(key, tags.map((tag) => String(tag)));
  return true;
}

export function readFundVerdict(digestHex, anchor, rootHex) {
  const tags = fundVerdicts.get(fundKey(digestHex, anchor, rootHex));
  if (!tags) return null;
  return {
    ok: true,
    tags: tags.slice(),
    anchor: Number(anchor),
    root: String(rootHex),
  };
}
