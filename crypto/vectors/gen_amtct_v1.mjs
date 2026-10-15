// Regenerates amtct_v1.json. Output differs per run (fresh ephemerals); the
// checked-in file is the shared vector. Run: node crypto/vectors/gen_amtct_v1.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealHiddenNote, openNoteAmount, scalarBytes, AMOUNT_CT_DST } from '../note.js';
import { admitBaseScalar, admitBasePub } from '../admit.js';
import { pointBytes } from '../note.js';
import { packTx, packDigest } from '../pack.js';
import { SPEND_AMT_DST, spendPackDigest } from '../spend.js';

const hex = (b) => Buffer.from(b).toString('hex');
const AMOUNTS = ['0', '1', '1000000000', '4294967303', '9007199254740991', '2500000000000', '18446744073709551615'];
const cases = AMOUNTS.map((v, i) => {
  const spendSeed = Buffer.alloc(32, i + 1);
  const admitBase = pointBytes(admitBasePub(spendSeed));
  const dest20 = Buffer.alloc(20, 0x40 + i);
  const o = sealHiddenNote(BigInt(v), { dest20, kind: 'send', admitBase });
  const x = admitBaseScalar(spendSeed);
  const got = openNoteAmount(o, x);
  if (got?.v !== BigInt(v)) throw new Error(`round-trip ${v}`);
  const wrongSeed = Buffer.alloc(32, 0xee - i);
  if (openNoteAmount(o, admitBaseScalar(wrongSeed)) !== null) throw new Error('wrong key opened');
  const tx = { kind: 'send', vin: [{ dest20 }], vout: [o] };
  const packed = packDigest(packTx({
    version: 1,
    vins: [{ prev: Buffer.alloc(32), index: 0, dest20 }],
    vouts: [{ dest20: Buffer.from(o.noteCommit).subarray(0, 20), nanos: 0, kind: 0 }],
    memoH: null,
    bFlag: 0,
  }));
  return {
    v,
    spendSeed: hex(spendSeed),
    xBase: hex(scalarBytes(x)),
    admitBase: hex(admitBase),
    dest20: hex(dest20),
    noteCommit: hex(o.noteCommit),
    commit: hex(o.commit),
    rEph: hex(o.rEph),
    rCt: hex(o.rCt),
    amtCt: hex(o.amtCt),
    r: hex(got.r),
    wrongSeed: hex(wrongSeed),
    packed: hex(packed),
    spendPackDigest: hex(spendPackDigest(tx)),
  };
});
const out = {
  name: 'shear-amt-v1',
  amtCt: 'u64le(v) XOR SHA-512("shear-amt-v1" || x*rEph || noteCommit || commit)[0..8]; x = admitBaseScalar(spendSeed)',
  rCt: 'scalar(r) + hashToScalar("shear-r-wrap-v1", x*rEph, noteCommit || commit), same rEph',
  check: 'owner accepts v only if v*G + r*H == commit; wrongSeed must open nothing',
  spendPackDigest: 'flow kinds: SHA-256("shear-spend-amt-v1" || packed || u32le(#vout) || per vout u32le(len) || amtCt)',
  dst: { amtCt: AMOUNT_CT_DST.toString(), spendAmt: SPEND_AMT_DST.toString() },
  cases,
};
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'amtct_v1.json');
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(file, cases.length);
