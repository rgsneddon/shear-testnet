import { admitVerify } from '../../crypto/admit.js';
import fs from 'node:fs';

const req = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const flux = {
  pubs: [Buffer.from(req.pub, 'hex')],
  commits: [Buffer.from(req.commit, 'hex')],
};
const proof = {
  v: 2,
  blob: Buffer.from(req.blob, 'hex'),
  spendTag: Buffer.from(req.spendTag, 'hex'),
  cTilde: Buffer.from(req.cTilde, 'hex'),
};
const ok = admitVerify(proof, flux) === true;
process.stdout.write(ok ? 'ok\n' : 'bad\n');
process.exit(ok ? 0 : 1);
