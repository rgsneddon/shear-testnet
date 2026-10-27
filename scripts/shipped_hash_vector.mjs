// The ShearHash-v3 addon built for this pack hashes the selftest header to the
// pinned vector. Native only: a miner fallback would not test the addon.
import assert from 'node:assert/strict';
import {
  HEADER_LEN, V3_SELFTEST, V3_SELFTEST_K, hashBackendKind, hashHex, setHashBackend, shearHash, shearKey,
} from '../crypto/shear_hash.js';

assert.equal(hashBackendKind(), 'native', 'crypto/native/shearhash.node must load');
const header = Buffer.alloc(HEADER_LEN);
header[0] = 1;
setHashBackend('interpreter');
assert.equal(hashHex(shearHash(header)), V3_SELFTEST);
assert.equal(hashHex(shearKey(header)), V3_SELFTEST_K);
console.log('shipped hash vector ok', V3_SELFTEST);
