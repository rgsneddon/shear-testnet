/**
 * ShearHash lane for block verify.
 * `jit` is RandomX light, the same digest as the interpreter, without the
 * 2 GiB jit-full dataset. An explicit SHEAR_HASH_BACKEND still wins.
 */
export function hashLaneBackend(env = process.env) {
  const name = String(env?.SHEAR_HASH_BACKEND || '').trim();
  return name || 'jit';
}
