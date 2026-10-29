/**
 * One FS-1 tree of the ordered live vault-lock notes.
 * rebuildVaultLockRoot and the vault provers both call this.
 * A later tree replaces this function, not a second append in the prover.
 */
import { fs1TreeAppend, fs1TreeNew, fs1TreeRoot } from './native_admit.js';

function noteBytes(note) {
  if (note == null || note === '') return null;
  if (Buffer.isBuffer(note)) return note.length === 64 ? note : null;
  if (note instanceof Uint8Array) return note.length === 64 ? Buffer.from(note) : null;
  if (typeof note === 'string' && /^[0-9a-fA-F]{128}$/.test(note)) return Buffer.from(note, 'hex');
  return null;
}

/**
 * Append [notes] in order, the same way rebuildVaultLockRoot does.
 * Each note is 64 bytes (or 128 hex chars). Null when a note is not a leaf
 * or the native tree will not take the list. An empty list is a handle
 * and a null root; the caller keeps the empty-vault marker.
 */
export function vaultLockTreeFromNotes(notes) {
  if (!Array.isArray(notes)) return null;
  const bufs = [];
  for (const note of notes) {
    const buf = noteBytes(note);
    if (!buf) return null;
    bufs.push(buf);
  }
  const handle = fs1TreeNew();
  if (!handle) return null;
  if (bufs.length && !fs1TreeAppend(handle, Buffer.concat(bufs))) return null;
  if (!bufs.length) return { handle, root: null, rootHex: null, notes: bufs };
  const root = fs1TreeRoot(handle);
  if (!root || root.length !== 32) return null;
  return { handle, root, rootHex: root.toString('hex'), notes: bufs };
}
