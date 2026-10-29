// R41: a pool shuts down cleanly with the native ShearHash addon loaded.
//
// Root cause of the exit 139 seen at the end of pool-mode R41 runs (never in
// solo mode, which has no hash worker): close() returned at once and the
// process exited while the pool's hash Worker thread was still alive. Node
// tore the process down under that thread, which faulted inside V8 on the
// released isolate heap (traced on the pool host with an LD_PRELOAD
// SIGSEGV handler: node+0xb3f1c9, fault address 0x174000000000, on the
// worker's thread id, with JIT-generated JS as the caller; not in the addon).
// The failure is timing-dependent (1 to 2 in 5 runs of 150-300 s).
//
// close() now resolves only once the worker has finished any in-flight hash
// and exited. This checks that contract (no worker thread alive when close
// resolves, whatever the timing of the in-flight hash), and that each such
// shutdown exits 0.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const addon = path.join(here, '..', '..', 'crypto', 'native', 'shearhash.node');

describe('pool close with the native addon loaded (R41)', { timeout: 900_000 }, () => {
  it('close() resolves with no hash worker alive, and the process exits 0', (t) => {
    if (!fs.existsSync(addon)) {
      t.skip('crypto/native/shearhash.node not built (make -C crypto/native shearhash.node)');
      return;
    }
    // 0 ms: the worker is still booting or hashing; 1500 ms: usually done.
    for (const delay of [0, 50, 300, 1500]) {
      for (let i = 0; i < 2; i += 1) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pool-close-'));
        const r = spawnSync(process.execPath, [path.join(here, 'close_with_hash_child.mjs'), dir, String(delay)], { encoding: 'utf8', timeout: 120_000 });
        fs.rmSync(dir, { recursive: true, force: true });
        assert.equal(r.signal, null, `delay ${delay}: killed by ${r.signal}\n${r.stderr.slice(-1500)}`);
        assert.equal(r.status, 0, `delay ${delay}: exit ${r.status}\n${r.stderr.slice(-1500)}`);
        assert.match(r.stdout, /closed hashWorkerThreads=0\b/, `delay ${delay}: ${r.stdout}`);
      }
    }
  });
});
