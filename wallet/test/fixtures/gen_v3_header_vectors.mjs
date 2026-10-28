// ShearHash-v3 fixture headers for spendable_hard_lock_test.dart, mined with
// the node's own crypto/shear_hash.js (R40: FIPS 180-4 SHA-512, so the
// RandomX key, and every digest, moved at 68510296).
//   node wallet/test/fixtures/gen_v3_header_vectors.mjs
// Each header keeps its version, roots, time and bits. Only the parent link
// and the nonce move: the first nonce from 0 whose digest meets the bits
// (the sibling: the first after the checkpoint's). Prints the Dart consts.
import { shearHash, meetsTarget, setHashBackend } from '../../../crypto/shear_hash.js';

// The JIT backend gives the same digests (the interpreter is the default).
try { setHashBackend('jit'); } catch { /* interpreter */ }

const hex = (b) => Buffer.from(b).toString('hex');
const hdr = (h) => Buffer.from(h, 'hex');
const bitsOf = (h) => h.readUInt32LE(108);
const setPrev = (h, prev) => { Buffer.from(prev).copy(h, 4); return h; };
const setNonce = (h, n) => { h.writeBigUInt64LE(BigInt(n), 112); return h; };

function mine(template, from = 0) {
  process.stderr.write(`bits ${bitsOf(Buffer.from(template))} from ${from}\n`);
  const h = Buffer.from(template);
  const bits = bitsOf(h);
  for (let n = from; n < 1 << 24; n += 1) {
    setNonce(h, n);
    const d = shearHash(h);
    if (meetsTarget(d, bits)) return { header: Buffer.from(h), digest: d, nonce: n };
  }
  throw new Error('no nonce');
}

// The committed templates (time, bits, roots unchanged; prev and nonce are refilled).
const T = {
  pat: '0100000000000000000000000000000000000000000000000000000000000000000000000202020202020202020202020202020202020202020202020202020202020202ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0068e5cf8b0100000000200007000000000000000100000000000000',
  genesis: '0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000806e87740100000000110075fd0300000000000000000000000000',
  child: '010000000000062e313064a7eb815f40f8d0c5ead15fd47d4ac293aaac7e09c9ea8fa4b7000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001859dc87740100003c03100047e60000000000000000000000000000',
  ckpt: '010000000000062e313064a7eb815f40f8d0c5ead15fd47d4ac293aaac7e09c9ea8fa4b70000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000090df6f87740100000000040001000000000000000000000000000000',
  extend: '0100000003b471fcb9e55ab73e6238cca90506433490143b0f343eb08edc4aa28d9cf11700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000203f718774010000000004000e000000000000000000000000000000',
  resume: '010000001111111111111111111111111111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005045c287740100000000040011000000000000000000000000000000',
};

const self = Buffer.alloc(128);
self[0] = 1;
// R40 selftest (version 1, the rest zero): the backend in use must give it.
if (hex(shearHash(self)) !== 'e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4') {
  throw new Error('this ShearHash is not the R40 one');
}
const pat = hdr(T.pat); // a hash vector, not mined
const genesis = mine(setPrev(hdr(T.genesis), Buffer.alloc(32)));
const child = mine(setPrev(hdr(T.child), genesis.digest));
const ckpt = mine(setPrev(hdr(T.ckpt), genesis.digest));
const sibling = mine(ckpt.header, ckpt.nonce + 1);
const extend = mine(setPrev(hdr(T.extend), ckpt.digest));
const resume = mine(setPrev(hdr(T.resume), Buffer.alloc(32, 0x11)));

const out = {
  _v3SelfDigest: hex(shearHash(self)),
  _v3PatDigest: hex(shearHash(pat)),
  _v3GenesisDigest: hex(genesis.digest),
  _v3ChildDigest: hex(child.digest),
  _v3PatHeader: hex(pat),
  _v3GenesisHeader: hex(genesis.header),
  _v3ChildHeader: hex(child.header),
  _v3CkptDigest: hex(ckpt.digest),
  _v3CkptHeader: hex(ckpt.header),
  _v3SiblingHeader: hex(sibling.header),
  _v3ExtendHeader: hex(extend.header),
  _v3ResumeHeader: hex(resume.header),
  _v3ResumeDigest: hex(resume.digest),
};
for (const [k, v] of Object.entries(out)) process.stdout.write(`const ${k} =\n    '${v}';\n`);
