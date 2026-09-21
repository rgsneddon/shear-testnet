/**
 * Checkpoint-bound Reserve seal.
 * The sealed-ancestry chain keeps the pot. A fork that diverged before the
 * freeze (h=1000, then every 400) gets a blank vault and cannot unlock it.
 * Tip below the first checkpoint has no seal yet.
 */
import { createHash } from 'node:crypto';
import { emptyVault, asNum } from './reserve_vault.js';

export const VAULT_SEAL_DOMAIN = 'shear-vault-seal-v1';
export const VAULT_COMMIT_DOMAIN = 'shear-vault-commit-v1';

function hexOf(h) {
  if (h == null || h === '') return '';
  if (Buffer.isBuffer(h) || h instanceof Uint8Array) return Buffer.from(h).toString('hex');
  return String(h);
}

/** Minimal Reserve commitment: locked pot + portal stakes + epoch pins. */
export function vaultCommitment(state) {
  const src = state && typeof state === 'object' ? state : emptyVault();
  const ids = Object.keys(src.portals || {}).sort();
  const portals = ids.map((k) => {
    const p = src.portals[k] || {};
    return [
      String(k),
      String(asNum(p.staked)),
      String(asNum(p.idle)),
      p.joined ? '1' : '0',
    ].join(':');
  }).join(',');
  const body = [
    String(src.programId || ''),
    String(asNum(src.totalLockedNanos)),
    String(asNum(src.feeBankNanos)),
    String(asNum(src.mintBankNanos)),
    String(src.currentEpoch || 0),
    String(src.epochBps ?? 0),
    String(src.epochStartMs || 0),
    portals,
  ].join('|');
  return createHash('sha256').update(VAULT_COMMIT_DOMAIN).update(body).digest('hex');
}

export function makeVaultSeal({ height, hash, commitment, genesisHash } = {}) {
  const h = Math.floor(Number(height) || 0);
  const cp = hexOf(hash);
  const c = String(commitment || '');
  const g = hexOf(genesisHash || '');
  const id = createHash('sha256')
    .update(VAULT_SEAL_DOMAIN)
    .update(String(h))
    .update(cp)
    .update(c)
    .update(g)
    .digest('hex');
  return {
    height: h,
    hash: cp,
    commitment: c,
    genesisHash: g,
    id,
  };
}

/**
 * True when there is no seal yet, or `blocks` includes the sealed checkpoint
 * hash (and optional vault-genesis hash).
 */
export function chainHasSealAncestry(blocks, seal) {
  if (!seal || !hexOf(seal.hash) || !(Number(seal.height) > 0)) return true;
  const list = Array.isArray(blocks) ? blocks : [];
  if (seal.genesisHash) {
    const genesis = list[0];
    if (!genesis || hexOf(genesis.hash) !== hexOf(seal.genesisHash)) return false;
  }
  const b = list.find((x) => Number(x.height) === Number(seal.height));
  if (!b) return false;
  return hexOf(b.hash) === hexOf(seal.hash);
}

/**
 * Honest sealed-ancestry tip: refuse a fork that dropped the seal.
 * Does not fire when we do not hold a seal (tip still below the freeze).
 */
export function reorgBreaksVaultSeal(fromBlocks, toBlocks, seal) {
  if (!seal || !(Number(seal.height) > 0) || !hexOf(seal.hash)) return null;
  const from = Array.isArray(fromBlocks) ? fromBlocks : [];
  const to = Array.isArray(toBlocks) ? toBlocks : [];
  if (!chainHasSealAncestry(from, seal)) return null;
  if (chainHasSealAncestry(to, seal)) return null;
  return {
    height: Number(seal.height),
    hash: hexOf(seal.hash),
    reason: 'reorg_vault_seal',
  };
}

/** Continuum line. Empty when tip is below the first freeze or ancestry holds. */
export function vaultSealBanner({
  seal,
  ancestry,
  tipHeight,
  first = 1000,
} = {}) {
  const tip = Math.floor(Number(tipHeight) || 0);
  const f = Math.max(1, Math.floor(Number(first) || 1000));
  if (tip < f) return '';
  if (ancestry !== false) return '';
  const h = Math.floor(Number(seal?.height) || f);
  return `This tip diverged before the Reserve vault seal (height ${h}). The vault on this fork is blank.`;
}

export function blankForkVault(oracle) {
  const v = emptyVault();
  v.blankFork = true;
  if (oracle) v.oracle = JSON.parse(JSON.stringify(oracle));
  return v;
}

export { hexOf as vaultSealHex };
