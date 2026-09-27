import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRODUCT_VERSION } from '../../crypto/asert.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runPython(args, extraEnv = {}) {
  for (const bin of ['python', 'py', 'python3']) {
    const r = spawnSync(bin, args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, ...extraEnv },
    });
    if (r.error && r.error.code === 'ENOENT') continue;
    return r;
  }
  return { status: 1, stdout: '', stderr: 'python missing' };
}

describe('portable node packs', () => {
  it('launchers call node/src/node.js and zip_node.py names every OS flavor including opensuse', () => {
    const cmd = fs.readFileSync(path.join(root, 'node/pack/shear-node.cmd'), 'utf8');
    const sh = fs.readFileSync(path.join(root, 'node/pack/shear-node.sh'), 'utf8');
    const py = fs.readFileSync(path.join(root, 'node/pack/zip_node.py'), 'utf8');
    const mac = fs.readFileSync(path.join(root, 'node/pack/pack_macos.sh'), 'utf8');
    const handoff = fs.readFileSync(path.join(root, 'NODE-MACBOOK-HANDOFF.md'), 'utf8');
    assert.match(cmd, /node\\src\\node\.js/);
    assert.match(sh, /node\/src\/node\.js/);
    assert.match(cmd, /SHEAR_NETWORK=shear-testnet-v5/);
    assert.match(sh, /SHEAR_NETWORK:-shear-testnet-v5/);
    assert.match(cmd, /pause/i);
    assert.match(cmd, /SHEAR_NODE_NOPAUSE/);
    assert.match(cmd, /Shear node stopped/);
    assert.doesNotMatch(cmd, /SHEAR_BOOTSTRAP=1/);
    assert.doesNotMatch(sh, /SHEAR_BOOTSTRAP=1/);
    assert.match(py, /FLAVORS = \("windows", "linux", "archlinux", "fedora", "opensuse", "macos"\)/);
    assert.match(mac, /zip_node\.py macos/);
    assert.match(handoff, /shear-node-v6-macos\.zip/);
    assert.match(handoff, /opensuse/i);
    assert.equal(PRODUCT_VERSION, '6.0');
    assert.match(py, /shear-node-\{pack_label\}-\{flavor\}\.zip/);
    assert.match(cmd, /pause/i);
    const bat = fs.readFileSync(path.join(root, 'node/pack/shear-node.bat'), 'utf8');
    assert.match(bat, /pause/i);
    assert.match(bat, /node\\src\\node\.js/);
  });

  it('zip_node.py writes a windows zip that contains the launcher and node entry', () => {
    const r = runPython(['node/pack/zip_node.py', 'windows'], { SHEAR_NODE_PACK_DEPS: '0' });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const zipPath = path.join(root, 'dist', 'shear-node-v6-windows.zip');
    assert.equal(fs.existsSync(zipPath), true, zipPath);
    const listed = runPython([
      '-c',
      'import zipfile,sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))',
      zipPath,
    ]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /shear-node\.cmd/);
    assert.match(listed.stdout, /node\/src\/node\.js/);
    assert.match(listed.stdout, /pool\/src\/wallet_api\.js/);
    assert.match(listed.stdout, /pool\/src\/hash_credit\.js/);
    assert.match(listed.stdout, /pool\/src\/withdraw_state\.js/);
    assert.doesNotMatch(listed.stdout, /SHEAR_BOOTSTRAP=1/);
  });
});
