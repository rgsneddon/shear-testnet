import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeHeader } from './header.js';
import { EMPTY_ROOT } from './merkle.js';
import { packShewall, unpackShewall, sealShewallBin, openShewallBin } from './shewall_bin.js';
import { writeChainBin, readChainBin } from './chainbin.js';

describe('chain.bin + shewall.bin', () => {
  it('round-trips packed epochs and refuses JSON shewall', () => {
    const header = encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: EMPTY_ROOT,
      continuityRoot: EMPTY_ROOT,
      timestamp: 9n,
      bits: 14,
      nonce: 1n,
      baseFee: 2n,
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bin-'));
    const p = path.join(dir, 'chain.bin');
    writeChainBin(p, [{
      header,
      rootA: Buffer.alloc(32, 1),
      rootB: Buffer.alloc(32, 2),
      hash: Buffer.alloc(32, 3),
      height: 4,
      aLeaves: [{ dest20: Buffer.alloc(20, 7), count: 3 }],
      bLeaves: [],
      txs: [{ coinbase: true, height: 4, vout: [] }],
    }]);
    const got = readChainBin(p);
    assert.equal(got.length, 1);
    assert.equal(got[0].height, 4);
    assert.equal(Number(got[0].aLeaves[0].count), 3);

    const packed = packShewall({
      seed32: Buffer.alloc(32, 9),
      dest20: Buffer.alloc(20, 7),
      spendableNanos: 11,
      pendingNanos: 2,
    });
    const back = unpackShewall(packed);
    assert.equal(Number(back.spendableNanos), 11);
    const sealed = sealShewallBin(packed, 'pw');
    const opened = unpackShewall(openShewallBin(sealed, 'pw'));
    assert.ok(opened.seed32.equals(Buffer.alloc(32, 9)));
    assert.throws(() => unpackShewall(Buffer.from('{"kind":"json"}')));
  });
});
