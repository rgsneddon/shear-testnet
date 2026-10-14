import { verifyRange } from '../../crypto/note.js';
import fs from 'node:fs';

const req = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ok = verifyRange(Buffer.from(req.commit, 'hex'), Buffer.from(req.proof, 'hex'));
process.stdout.write(ok ? 'ok\n' : 'bad\n');
process.exit(ok ? 0 : 1);
