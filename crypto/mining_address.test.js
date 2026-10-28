// R28 option 2 (Russell 28 Oct): the mining address is `shm1…`, bech32 (the
// ssa checksum) of B‖Y. A typo is refused, never decoded to someone else's
// keys, and a pool login that names any wallet string is caught.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decodeMiningAddress, encodeDest, encodeMiningAddress, namesAnAddress, newIdentity } from './address.js';
import { admitBasePub } from './admit.js';
import { scanPub } from './blunote.js';
import { pointBytes } from './note.js';

function keys() {
  const seed = randomBytes(32);
  return { B: pointBytes(admitBasePub(seed)), Y: scanPub(seed) };
}

describe('mining address (shm1)', () => {
  it('round-trips B‖Y and refuses every single-character typo', () => {
    for (let n = 0; n < 8; n += 1) {
      const k = keys();
      const addr = encodeMiningAddress(k);
      assert.match(addr, /^shm1[02-9ac-hj-np-z]{110}$/);
      const back = decodeMiningAddress(addr);
      assert.ok(Buffer.from(back.B).equals(Buffer.from(k.B)));
      assert.ok(Buffer.from(back.Y).equals(Buffer.from(k.Y)));
      // Every position, one substituted character: always refused.
      const cs = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
      for (let i = 4; i < addr.length; i += 1) {
        const c = cs[(cs.indexOf(addr[i]) + 1 + (i % 31)) % 32];
        assert.equal(decodeMiningAddress(`${addr.slice(0, i)}${c}${addr.slice(i + 1)}`), null, `pos ${i}`);
      }
      assert.equal(decodeMiningAddress(addr.toUpperCase()), null, 'uppercase is not what the wallet prints');
      assert.equal(decodeMiningAddress(addr.slice(0, -1)), null);
    }
  });

  it('refuses another prefix, a key that is not a point, and raw hex unless allowed', () => {
    const k = keys();
    const hex = Buffer.concat([Buffer.from(k.B), Buffer.from(k.Y)]).toString('hex');
    assert.equal(decodeMiningAddress(hex), null, 'raw hex has no checksum');
    assert.ok(decodeMiningAddress(hex, { allowHex: true }));
    assert.equal(decodeMiningAddress('ff'.repeat(64), { allowHex: true }), null);
    assert.throws(() => encodeMiningAddress({ B: Buffer.alloc(32, 0xff), Y: k.Y }));
    assert.equal(decodeMiningAddress(encodeDest(Buffer.alloc(20, 3))), null);
  });

  it('a login names a wallet when any part is an address or a raw key', () => {
    const k = keys();
    const addr = encodeMiningAddress(k);
    const dest = encodeDest(Buffer.alloc(20, 5));
    const id = newIdentity();
    for (const s of [dest, `${dest}.rig`, `rig.${addr}`, addr, id.paymentCode, 'ab'.repeat(32), 'cd'.repeat(64)]) {
      assert.equal(namesAnAddress(s), true, s);
    }
    for (const s of ['rig1', 'pc-1', 'rack3.node_7', 'shm1short', 'ssa1notachecksum', '']) {
      assert.equal(namesAnAddress(s), false, s);
    }
  });
});
