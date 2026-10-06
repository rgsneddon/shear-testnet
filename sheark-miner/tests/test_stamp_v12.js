import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader, setNonce } from '../../crypto/header.js';
import {
  GENESIS_BITS_PACKED,
  SHARE_FLOOR_BITS,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  destBoundShareHash,
  nonceWithShareTarget,
  noteCommitOfShare,
  shareTargetByte,
} from '../../crypto/share_batch.js';
import { judgeShare } from '../../pool/src/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const stampSrc = path.join(here, 'stamp_main.c');

function clampBits(bits) {
  const bmax = shareCreditMaxBits();
  let sb = Math.floor(Number(bits));
  if (!Number.isFinite(sb) || sb < SHARE_FLOOR_BITS) sb = SHARE_FLOOR_BITS;
  if (sb > bmax) sb = bmax;
  return sb;
}

function compileStamp() {
  const out = path.join(os.tmpdir(), 'shear-stamp-v12.exe');
  const cc = spawnSync('gcc', ['-O2', '-std=c11', '-Wall', '-Wextra', '-o', out, stampSrc], {
    encoding: 'utf8',
  });
  assert.equal(cc.status, 0, `gcc stamp harness failed: ${cc.stderr || cc.stdout || cc.error}`);
  return out;
}

function runStamp(bin, bits, low) {
  const got = spawnSync(bin, [String(bits), String(low)], { encoding: 'utf8' });
  assert.equal(got.status, 0, got.stderr || got.stdout || String(got.error));
  const [nonce, credit] = String(got.stdout).trim().split(/\s+/);
  return { nonce: BigInt(nonce), credit: Number(credit) };
}

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function headerFor(nonce) {
  const parent = encodeHeader({
    prevBlockHash: Buffer.alloc(32, 4),
    merkleRoot: Buffer.alloc(32, 5),
    continuityRoot: Buffer.alloc(32, 6),
    timestamp: 1_700_000_000_000,
    bits: GENESIS_BITS_PACKED,
  });
  return setNonce(parent, nonce);
}

function rxMeeting(noteCommit, bits) {
  const miss = bits + 4;
  for (let i = 0; i < 200_000; i += 1) {
    const rx = Buffer.alloc(32);
    rx.writeUInt32LE(i >>> 0, 0);
    rx.writeUInt32LE((i * 17) >>> 0, 8);
    const bound = destBoundShareHash(rx, noteCommit);
    if (meetsTarget(bound, bits) && (miss > 32 || !meetsTarget(bound, miss))) return rx;
  }
  return null;
}

describe('v12 miners stamp the nonce high byte', () => {
  it('the compiled stamp matches the pool job byte across the legal range', () => {
    const harness = compileStamp();
    const bmax = shareCreditMaxBits();
    const widths = [0, 7, SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 4, 20, bmax, bmax + 1, 52, 255];
    const lows = [1n, (1n << 40n) + 99n, (0xffn << 56n) | 7n];
    const dest = minerDest();
    const nc = noteCommitOfShare({ dest });
    for (const bits of widths) {
      for (const low of lows) {
        const stamped = runStamp(harness, bits, low);
        const wantBits = clampBits(bits);
        const want = nonceWithShareTarget(low, wantBits);
        assert.equal(stamped.nonce, want, `${bits} ${low}`);
        assert.equal(stamped.credit, wantBits);
        assert.equal(shareTargetByte(stamped.nonce), wantBits);
        const header = headerFor(stamped.nonce);
        const miss = Buffer.alloc(32, 0xff);
        const job = { shareBits: wantBits, shareBitsPrev: 0, shareBitsAt: 0, shareBitsHist: [], header };
        const shareOnly = judgeShare({ job, header, hash: miss, dest });
        assert.equal(shareOnly.ok, false, shareOnly.reason);
        assert.equal(shareOnly.reason, 'low_diff');
        const block = judgeShare({ job, header, hash: Buffer.alloc(32), dest });
        assert.equal(block.ok, true, block.reason);
        assert.equal(block.block, true);
        assert.ok(block.creditedShareBits === 0 || block.creditedShareBits === wantBits);
      }
    }
    const bare = nonceWithShareTarget(11n, 0);
    const bareHeader = headerFor(bare);
    const bareJob = { shareBits: SHARE_FLOOR_BITS, header: bareHeader, shareBitsHist: [] };
    const rejected = judgeShare({
      job: bareJob,
      header: bareHeader,
      hash: Buffer.alloc(32, 0xff),
      dest,
    });
    assert.equal(rejected.reason, 'share_target');
    const floorRx = rxMeeting(nc, SHARE_FLOOR_BITS);
    const midRx = rxMeeting(nc, SHARE_FLOOR_BITS + 4);
    assert.ok(floorRx);
    assert.ok(midRx);
    for (const [bits, rx] of [[SHARE_FLOOR_BITS, floorRx], [SHARE_FLOOR_BITS + 4, midRx]]) {
      const nonce = runStamp(harness, bits, 41n).nonce;
      const header = headerFor(nonce);
      const job = { shareBits: bits, header, shareBitsHist: [] };
      const got = judgeShare({ job, header, hash: rx, dest });
      assert.equal(got.ok, true, got.reason);
      assert.equal(got.creditedShareBits, bits);
    }
    const sheark = fs.readFileSync(path.join(repo, 'sheark-miner/src/sheark_miner.c'), 'utf8');
    const solo = fs.readFileSync(path.join(repo, 'miner/src/shear_miner.c'), 'utf8');
    assert.match(sheark, /shear_stamp_share_nonce/);
    assert.match(solo, /shear_stamp_share_nonce/);
    assert.equal(/sb > 28/.test(sheark), false);
    const hashH = fs.readFileSync(path.join(repo, 'sheark-miner/src/shear_hash.h'), 'utf8');
    assert.match(hashH, /SHEAR_VERSION "2\.9"/);
    assert.match(fs.readFileSync(path.join(repo, 'crypto/share_stamp.h'), 'utf8'), /1u << 28/);
  });
});
