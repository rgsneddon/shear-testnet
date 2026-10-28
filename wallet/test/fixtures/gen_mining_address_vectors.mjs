// R28 shm1 mining address: wallet test vectors from the node's own
// crypto/address.js (encodeMiningAddress / decodeMiningAddress).
// Run from the repo root (needs the root node_modules):
//   node wallet/test/fixtures/gen_mining_address_vectors.mjs > wallet/test/fixtures/mining_address_vectors.json
// Every input is fixed, so a rerun prints the same file byte for byte.
import { createHash } from 'node:crypto';
import { decodeMiningAddress, encodeDest, encodeHrp, encodeMiningAddress, HRP_MINING } from '../../../crypto/address.js';
import { admitBasePub } from '../../../crypto/admit.js';
import { scanPub } from '../../../crypto/blunote.js';
import { pointBytes } from '../../../crypto/note.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => createHash('sha256').update(s).digest();
const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

const good = [];
for (const label of ['alice', 'bob', 'carol']) {
  const seed = sha(`shear-mining-address-vector-${label}`);
  const B = pointBytes(admitBasePub(seed));
  const Y = scanPub(seed);
  const address = encodeMiningAddress({ B, Y });
  const back = decodeMiningAddress(address);
  if (!back || hex(back.B) !== hex(B) || hex(back.Y) !== hex(Y)) throw new Error('round trip');
  good.push({ label, seed: hex(seed), B: hex(B), Y: hex(Y), address });
}

// Refused by the node's decoder. Each is checked here before it is written.
const bad = [];
function refuse(name, s, opts = {}) {
  if (decodeMiningAddress(s, opts) !== null) throw new Error(`${name} decoded`);
  bad.push({ name, s, ...(opts.allowHex ? { allowHex: true } : {}) });
}
const a = good[0].address;
const flip = (i) => `${a.slice(0, i)}${CS[(CS.indexOf(a[i]) + 1) % 32]}${a.slice(i + 1)}`;
refuse('bad checksum (last character)', flip(a.length - 1));
refuse('bad checksum (a data character)', flip(20));
refuse('truncated', a.slice(0, -1));
refuse('uppercase', a.toUpperCase());
refuse('ssa prefix on the same keys', encodeHrp('ssa', Buffer.from(good[0].B + good[0].Y, 'hex')));
refuse('a dest', encodeDest(Buffer.alloc(20, 3)));
refuse('raw hex without allowHex', good[0].B + good[0].Y);
// Keys that are not ristretto points, under a valid checksum.
const notPoint = Buffer.alloc(32, 0xff);
refuse('B not a point', encodeHrp(HRP_MINING, Buffer.concat([notPoint, Buffer.from(good[0].Y, 'hex')])));
refuse('Y not a point', encodeHrp(HRP_MINING, Buffer.concat([Buffer.from(good[0].B, 'hex'), notPoint])));
refuse('raw hex not a point', 'ff'.repeat(64), { allowHex: true });
refuse('32 bytes, not 64', encodeHrp(HRP_MINING, Buffer.from(good[0].B, 'hex')));

const hexOk = good[0].B + good[0].Y;
if (!decodeMiningAddress(hexOk, { allowHex: true })) throw new Error('allowHex');

process.stdout.write(`${JSON.stringify({ spec: 'crypto/address.js encodeMiningAddress / decodeMiningAddress (R28)', hrp: HRP_MINING, good, bad, hexAllowed: hexOk }, null, 2)}\n`);
