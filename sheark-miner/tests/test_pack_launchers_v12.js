// PSA r2 must-fix 1 (PR146): the pack checks must match the launchers that
// 2cae391a shipped. The launchers no longer pass --backend; the miner picks
// jit-full and drops to light jit (then the interpreter) itself. These cases
// zip the repo's real example.sh / example.bat the way pack/zip_*.py does
// and run pack_common.assertLaunchers on them, so the sheark-packs jobs and
// this suite check the same thing. Loopback/offline only: --print-config
// exits before any connection.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pc from './pack_common.js';

const linux = process.platform === 'linux';
const bin = path.join(pc.root, process.platform === 'win32' ? 'ShearK-Miner.exe' : 'ShearK-Miner');

const readSrc = (f) => fs.readFileSync(path.join(pc.root, f), 'utf8').replace(/\r\n/g, '\n');

// Same newline rules as pack/zip_unix.py and pack/zip_windows.py.
function zipLaunchers(sh, bat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheark-launch-'));
  fs.writeFileSync(path.join(dir, 'example.sh'), sh.replace(/\r\n/g, '\n'));
  fs.writeFileSync(path.join(dir, 'example.bat'), bat.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  const zip = path.join(dir, 'l.zip');
  const r = spawnSync(pc.python(), ['-I', '-c',
    'import sys,zipfile\n'
    + 'z=zipfile.ZipFile(sys.argv[1],"w")\n'
    + 'for n in ("example.sh","example.bat"): z.write(sys.argv[2]+"/"+n, n)\n'
    + 'z.close()', zip, dir], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return { zip, dir };
}

function check(sh, bat) {
  const { zip, dir } = zipLaunchers(sh, bat);
  try { pc.assertLaunchers(zip, pc.version()); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const POOL_SH = 'exec ./ShearK-Miner --pool stratum+ssl://pool.shear.digital:443 --user rig1 --blu YOUR_MINING_ADDRESS';
const POOL_BAT = 'ShearK-Miner.exe --pool stratum+ssl://pool.shear.digital:443 --user pc1 --blu YOUR_MINING_ADDRESS';

describe('PR146 PSA r2-1: pack launcher checks follow the auto-select launchers', () => {
  it('the shipped example.sh and example.bat pass assertLaunchers', () => {
    check(readSrc('example.sh'), readSrc('example.bat'));
  });

  it('a launcher that pins any --backend is refused', () => {
    for (const b of ['jit-full', 'jit', 'interpreter']) {
      assert.throws(() => check(readSrc('example.sh').replace(POOL_SH, `${POOL_SH} --backend ${b}`), readSrc('example.bat')), undefined, `sh ${b}`);
      assert.throws(() => check(readSrc('example.sh'), readSrc('example.bat').replace(POOL_BAT, `${POOL_BAT} --backend ${b}`)), undefined, `bat ${b}`);
    }
    // On the solo line too.
    assert.throws(() => check(readSrc('example.sh').replace('YOUR_MINING_ADDRESS --solo', 'YOUR_MINING_ADDRESS --solo --backend jit-full'), readSrc('example.bat')));
  });

  it('the other launcher rules still hold (no --blu, an address in --user, --dest, a pin)', () => {
    const sh = readSrc('example.sh');
    const bat = readSrc('example.bat');
    assert.throws(() => check(sh.replace(POOL_SH, POOL_SH.replace(' --blu YOUR_MINING_ADDRESS', '')), bat));
    assert.throws(() => check(sh.replace(POOL_SH, `${POOL_SH} --dest YOUR_SSA1`), bat));
    assert.throws(() => check(sh.replace(POOL_SH, `${POOL_SH} --tls-insecure`), bat));
    assert.throws(() => check(sh, bat.replace(POOL_BAT, POOL_BAT.replace('--user pc1', '--user YOUR_SHE1'))));
    assert.throws(() => check(sh.replace(/exec \.\/ShearK-Miner --pool stratum[^\n]*\n/, ''), bat), undefined, 'pool line missing');
  });

  it('assertAutoBackend accepts each ladder mode and refuses a mismatched label', () => {
    assert.equal(typeof pc.assertAutoBackend, 'function', 'pack_common.assertAutoBackend missing');
    assert.equal(typeof pc.printConfig, 'function', 'pack_common.printConfig missing');
    const ok = [['jit-full', 'full'], ['jit', 'light'], ['interpreter', 'light']];
    for (const [backend, rxMode] of ok) pc.assertAutoBackend({ backend, rxMode }, pc.LADDER);
    pc.assertAutoBackend({ backend: 'jit', rxMode: 'light' }, ['jit']);
    assert.throws(() => pc.assertAutoBackend({ backend: 'jit-full', rxMode: 'light' }, pc.LADDER));
    assert.throws(() => pc.assertAutoBackend({ backend: 'jit', rxMode: 'full' }, pc.LADDER));
    assert.throws(() => pc.assertAutoBackend({ backend: 'interpreter', rxMode: 'full' }, pc.LADDER));
    assert.throws(() => pc.assertAutoBackend({ backend: 'auto', rxMode: 'light' }, pc.LADDER));
    assert.throws(() => pc.assertAutoBackend({ backend: 'jit', rxMode: 'light' }, ['jit-full']));
  });

  it('the built miner, with no --backend, reports a ladder mode whose label matches', { skip: !fs.existsSync(bin) && 'miner not built' }, () => {
    const j = pc.printConfig(bin, { cwd: pc.root });
    pc.assertAutoBackend(j, pc.LADDER);
  });

  it('under ulimit -v 700000 the built miner auto-selects light jit (Linux)', { skip: (!linux || !fs.existsSync(bin)) && 'Linux with a built miner only' }, () => {
    const j = pc.printConfig(bin, { cwd: pc.root, ulimitKb: 700000 });
    pc.assertAutoBackend(j, ['jit']);
  });
});
