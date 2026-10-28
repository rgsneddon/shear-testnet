// Child for test_close_with_addon_v12.js: a loopback pool with the native
// ShearHash addon. A keyed submit puts a share in the pool's hash worker;
// `delay` ms later (the hash still running, or just done) the pool closes,
// the child reports how many hash worker threads are still alive, and
// exits the way a pool process stops.
//   node close_with_hash_child.mjs DATADIR DELAY_MS
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createPool } from '../src/pool.js';
import { encodeDest } from '../../crypto/address.js';
import { pointBytes } from '../../crypto/note.js';
import { admitBasePub } from '../../crypto/admit.js';

const dir = process.argv[2];
const delay = Number(process.argv[3] || 20);
const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, tlsPort: 0, stratumBind: '127.0.0.1', miner: encodeDest(Buffer.alloc(20, 7)), shareBits: 8, bits: 16 });
const heard = await pool.listen();
const P = Buffer.from(pointBytes(admitBasePub(randomBytes(32)))).toString('hex');
const params = { login: 'rig1', name: 'ShearK-Miner', client: 'ShearHash', version: '2.9', algorithm: 'ShearHash' };
const sock = net.connect(heard.stratumPort, '127.0.0.1');
let buf = '';
let sent = false;
sock.on('error', () => {});
sock.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const ln = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let j = null;
    try { j = JSON.parse(ln); } catch { continue; }
    const job = j?.params?.header ? j.params : j?.result?.job || j?.job || null;
    if (job?.jobId && !sent) {
      sent = true;
      sock.write(JSON.stringify({ id: 2, method: 'submit', params: { ...params, jobId: job.jobId, nonce: '1', hash: 'ab'.repeat(32), shareR: 'cd'.repeat(32), shareP: P, viewTag: 1 } }) + '\n');
      setTimeout(async () => {
        await pool.close();
        process.stdout.write(`closed hashWorkerThreads=${pool.hashWorkerThreads}\n`);
        process.exit(0);
      }, delay);
    }
  }
});
sock.on('connect', () => sock.write(JSON.stringify({ id: 1, method: 'login', params }) + '\n'));
