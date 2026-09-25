/**
 * Windows ShearHash helper. A second isolate inside this process calls
 * shear_hash_set_backend again and drops the live RandomX cache (huge-page
 * fallback makes the flags look new). That access-violates the node
 * (exit 0xC0000005). A child process has its own cache.
 *
 * stdin:  "<id>\t<header hex>"
 * stdout: "<id>\t<hash hex>" or "<id>\tERR\t<message>"
 */
import readline from 'node:readline';
import { shearHash } from './shear_hash.js';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const tab = line.indexOf('\t');
  if (tab < 1) return;
  const id = line.slice(0, tab);
  const hex = line.slice(tab + 1).trim();
  try {
    const raw = Buffer.from(hex, 'hex');
    const hash = shearHash(raw);
    process.stdout.write(`${id}\t${Buffer.from(hash).toString('hex')}\n`);
  } catch (err) {
    const msg = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 180);
    process.stdout.write(`${id}\tERR\t${msg}\n`);
  }
});
