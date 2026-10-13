import fs from 'node:fs';
import { admitVerifyV3 } from '../../crypto/admit.js';
import { admitV3Context, fundingJroot, txDigestV3 } from '../../crypto/admit_v3.js';
import { MAGIC_TESTNET } from '../../crypto/asert.js';

const req = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pub = Buffer.from(req.pub, 'hex');
const commit = Buffer.from(req.commit, 'hex');
const blob = Buffer.from(req.blob, 'hex');
const spendTag = Buffer.from(req.spendTag, 'hex');
const cTilde = Buffer.from(req.cTilde, 'hex');
const anchor = Number(req.anchor ?? 8);
const flux = { pubs: [pub], commits: [commit], n: 1 };
const tx = {
  kind: 'send',
  anchor,
  fee: 0,
  maxLevy: 0,
  vin: [{ commit: cTilde }],
  vout: [],
  admit_proof: { spendTag, cTilde, blob },
};
const root = fundingJroot(flux);
const digest = txDigestV3(tx, MAGIC_TESTNET);
const ctx = admitV3Context({
  magic: MAGIC_TESTNET,
  anchor,
  root,
  n: 1,
  digest,
});
const ok = admitVerifyV3(
  { v: 3, blob, spendTag, cTilde },
  flux,
  { jroot: root, cTilde, spendTag, ctx },
) === true;
process.stdout.write(ok ? 'ok\n' : 'bad\n');
process.exit(ok ? 0 : 1);
