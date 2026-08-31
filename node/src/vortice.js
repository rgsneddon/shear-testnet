import fs from 'node:fs';
import path from 'node:path';
import {
  mintVorticeDeployKey as mintKey,
  parseVorticeKey,
  verifyVorticeDownload,
  mintVorticeDeployKeyFromOrigin,
  isPinnedProgram,
  listPublicVortices,
  gateVorticeRegister,
} from '../../crypto/vortex.js';

export {
  mintVorticeDeployKey,
  parseVorticeKey,
  verifyVorticeDownload,
  mintVorticeDeployKeyFromOrigin,
} from '../../crypto/vortex.js';

/** Node catalog of minted keys. Creators host the dapp; this only remembers origin + bundle. */
export function createVorticeCatalog(dir) {
  const file = path.join(dir, 'vortice.json');
  let issued = Object.create(null);
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      issued = Object.assign(Object.create(null), raw?.issued || raw || {});
    } catch {
      issued = Object.create(null);
    }
  }

  function save() {
    fs.writeFileSync(file, `${JSON.stringify({ issued }, null, 2)}\n`);
  }

  function recordFromKey(key, extra = {}) {
    const parsed = parseVorticeKey(key);
    if (!parsed) return { ok: false, reason: 'bad_key' };
    if (issued[parsed.id] && issued[parsed.id].key !== key) {
      return { ok: false, reason: 'already_minted', key: issued[parsed.id].key };
    }
    const rec = {
      id: parsed.id,
      name: parsed.name,
      origin: parsed.origin,
      bundle: parsed.bundle,
      key,
      mintedMs: issued[parsed.id]?.mintedMs || Date.now(),
      ...extra,
    };
    issued[parsed.id] = rec;
    save();
    return { ok: true, ...rec };
  }

  function mintVorticeDeployKey(spec = {}) {
    const key = mintKey(spec);
    if (!key) return { ok: false, reason: 'bad_mint' };
    return recordFromKey(key);
  }

  async function mintFromOrigin(spec, fetchFn) {
    const got = await mintVorticeDeployKeyFromOrigin(spec, fetchFn);
    if (!got.ok) return got;
    const rec = recordFromKey(got.key);
    if (!rec.ok) return rec;
    return { ...rec, source: undefined };
  }

  function lookupByKey(key) {
    const parsed = parseVorticeKey(key);
    if (!parsed) return { ok: false, reason: 'bad_key' };
    if (isPinnedProgram(parsed.id)) return { ok: false, reason: 'not_public_vortice' };
    const rec = issued[parsed.id];
    if (!rec) {
      return {
        ok: true,
        mintedHere: false,
        id: parsed.id,
        name: parsed.name,
        origin: parsed.origin,
        bundle: parsed.bundle,
      };
    }
    if (rec.bundle !== parsed.bundle || rec.origin !== parsed.origin) {
      return { ok: false, reason: 'bundle_mismatch' };
    }
    return { ok: true, mintedHere: true, ...rec };
  }

  function listPublic() {
    return listPublicVortices(issued);
  }

  function registerFromTx(tx) {
    const gate = gateVorticeRegister(tx);
    if (!gate.ok) return { ...gate, issued: false };
    if (issued[gate.id]) return { ok: false, reason: 'already', issued: false, id: gate.id };
    issued[gate.id] = {
      id: gate.id,
      bytesHash: gate.bytesHash,
      author: gate.author,
      vort1: gate.id,
      mintedMs: Date.now(),
    };
    save();
    return { ok: true, issued: true, ...issued[gate.id] };
  }

  return {
    mintVorticeDeployKey,
    mintFromOrigin,
    lookupByKey,
    listPublic,
    parseVorticeKey,
    verifyVorticeDownload,
    registerFromTx,
    issued,
  };
}
