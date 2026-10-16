import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRODUCT_VERSION } from '../../crypto/asert.js';
import { NODE_DISPLAY } from '../src/product.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function mingwCompiler() {
  const bins = process.platform === 'win32'
    ? ['gcc', 'x86_64-w64-mingw32-gcc']
    : ['x86_64-w64-mingw32-gcc'];
  const paths = [
    process.env.MINGW_GCC,
    '/opt/mingw-bin/gcc',
    '/usr/bin/x86_64-w64-mingw32-gcc',
    'C:\\msys64\\mingw64\\bin\\gcc.exe',
  ].filter(Boolean);
  for (const bin of [...bins, ...paths]) {
    if ((bin.includes('/') || bin.includes('\\')) && !fs.existsSync(bin)) continue;
    const r = spawnSync(bin, ['-dumpmachine'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && /mingw/i.test(`${r.stdout || ''}${r.stderr || ''}`)) return bin;
  }
  return '';
}

const WINDOWS_ZIP_SKIP = mingwCompiler()
  ? false
  : 'windows zip needs the MinGW toolchain (x86_64-w64-mingw32-gcc or MSYS2 mingw64 gcc, with static libgcc, libstdc++, and winpthread). This host has no MinGW compiler, so the Windows pack is skipped instead of recorded as a pass.';

function runPython(args, extraEnv = {}) {
  for (const bin of ['python', 'py', 'python3']) {
    const r = spawnSync(bin, args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 180000,
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
    assert.match(cmd, /SHEAR_NETWORK=shear-testnet-v12/);
    assert.match(cmd, /APPDATA%\\Shear\\testnet-v12/);
    assert.match(sh, /HOME\/\.shear\/testnet-v12/);
    assert.match(sh, /SHEAR_NETWORK:-shear-testnet-v12/);
    assert.match(cmd, /pause/i);
    assert.match(cmd, /SHEAR_NODE_NOPAUSE/);
    assert.match(cmd, /Shear node stopped/);
    const major = PRODUCT_VERSION.split('.')[0];
    assert.match(cmd, new RegExp(`Shear Sentinel v${major}`));
    assert.match(cmd, new RegExp(NODE_DISPLAY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(cmd, /crypto\\native/);
    assert.match(cmd, /libgcc_s_seh-1\.dll|PATH=%ROOT%runtime/);
    assert.doesNotMatch(cmd, /SHEAR_BOOTSTRAP=1/);
    assert.doesNotMatch(sh, /SHEAR_BOOTSTRAP=1/);
    assert.match(py, /FLAVORS = \("windows", "linux", "archlinux", "fedora", "opensuse", "macos"\)/);
    assert.match(py, /write_crlf_launcher/);
    assert.match(mac, /zip_node\.py macos/);
    assert.match(mac, new RegExp(`LABEL=v${major}`));
    assert.match(mac, new RegExp(`want ${major}\\.0`));
    assert.match(mac, new RegExp(`!= "${major}\\.0"`));
    assert.doesNotMatch(mac, /!= "16\.0"/);
    assert.doesNotMatch(mac, /gh release upload v16 /);
    assert.doesNotMatch(mac, /gh release upload 0\.68 /);
    assert.doesNotMatch(mac, /LABEL=v16/);
    assert.doesNotMatch(mac, /LABEL=v15/);
    assert.doesNotMatch(mac, /gh release upload v15 /);
    assert.match(mac, /PRODUCT_VERSION/);
    assert.match(mac, /npm ci/);
    assert.match(mac, /export const MAGIC_TESTNET = MAGIC_TESTNET_V12/);
    assert.match(mac, /testnet-v11/);
    assert.doesNotMatch(mac, /shear-testnet-v11/);
    assert.doesNotMatch(mac, /LABEL=v9/);
    assert.doesNotMatch(mac, /shear-node-v9-macos/);
    assert.match(handoff, /shear-wallet-0\.70-macos\.dmg/);
    assert.match(handoff, /Do not pass `--clobber`/);
    assert.match(handoff, /Do not build Shear Sentinel/);
    assert.match(handoff, /Do not build ShearK/);
    assert.doesNotMatch(handoff, /shear-node-/);
    assert.doesNotMatch(handoff, /zip_node\.py/);
    assert.doesNotMatch(handoff, /node\/pack\/pack_macos\.sh/);
    assert.doesNotMatch(handoff, /gh release upload v17 /);
    assert.doesNotMatch(handoff, /gh release upload 0\.68 /);
    assert.equal(PRODUCT_VERSION, '19.0');
    assert.equal(NODE_DISPLAY, `Shear Sentinel v${major}`);
    assert.match(py, /shear-node-\{pack_label\}-\{flavor\}\.zip/);
    assert.match(cmd, /pause/i);
    const bat = fs.readFileSync(path.join(root, 'node/pack/shear-node.bat'), 'utf8');
    assert.match(bat, /pause/i);
    assert.match(bat, /SHEAR_NODE_NOPAUSE/);
    assert.match(bat, new RegExp(`Shear Sentinel v${major}`));
    assert.match(bat, /node\\src\\node\.js/);
  });

  it('zip_node.py writes a windows zip that contains the launcher and node entry', { skip: WINDOWS_ZIP_SKIP }, () => {
    const r = runPython(['node/pack/zip_node.py', 'windows']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const zipPath = path.join(root, 'dist', `shear-node-v${PRODUCT_VERSION.split('.')[0]}-windows.zip`);
    assert.equal(fs.existsSync(zipPath), true, zipPath);
    const listed = runPython([
      '-c',
      'import zipfile,sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))',
      zipPath,
    ]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /shear-node\.cmd/);
    assert.match(listed.stdout, /shear-node\.bat/);
    assert.match(listed.stdout, /node\/src\/node\.js/);
    assert.match(listed.stdout, /pool\/src\/posture\.js/);
    assert.match(listed.stdout, /pool\/src\/pool\.js/);
    assert.match(listed.stdout, /pool\/src\/wallet_api\.js/);
    assert.match(listed.stdout, /pool\/src\/hash_credit\.js/);
    assert.match(listed.stdout, /pool\/src\/withdraw_state\.js/);
    assert.match(listed.stdout, /contracts\/Reserve\.json/);
    assert.match(listed.stdout, /crypto\/native\/shearhash\.node/);
    assert.doesNotMatch(listed.stdout, /libgcc_s_seh-1\.dll|libstdc\+\+-6\.dll|libwinpthread-1\.dll/);
    assert.match(listed.stdout, /node_modules\/@noble\/curves\/ed25519\.js/);
    assert.match(listed.stdout, /node_modules\/@noble\/curves\/secp256k1\.js/);
    assert.match(listed.stdout, /node_modules\/@noble\/hashes\/sha2\.js/);
    assert.match(listed.stdout, /node_modules\/@noble\/hashes\/sha3\.js/);
    assert.match(listed.stdout, /node_modules\/@noble\/hashes\/argon2\.js/);
    assert.match(listed.stdout, /node_modules\/@noble\/curves\/utils\.js/);
    assert.match(listed.stdout, /node_modules\/@noble\/curves\/esm\/ed25519\.js/);
    assert.match(listed.stdout, /node_modules\/@ethereumjs\/evm\/dist\/esm\/index\.js/);
    assert.match(listed.stdout, /node_modules\/@ethereumjs\/common\/dist\/esm\/index\.js/);
    assert.match(listed.stdout, /node_modules\/@ethereumjs\/util\/dist\/esm\/index\.js/);
    assert.match(listed.stdout, /crypto\/native\/shearadmit\.node/);
    assert.match(listed.stdout, /reserve\/latest\.json/);
    assert.doesNotMatch(listed.stdout, /SHEAR_BOOTSTRAP=1/);
    const crlf = runPython([
      '-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]);\n'
      + 'cmd=z.read("shear-node.cmd"); bat=z.read("shear-node.bat");\n'
      + 'assert cmd.count(b"\\n")==cmd.count(b"\\r\\n") and cmd.count(b"\\r\\n")>0;\n'
      + 'assert bat.count(b"\\n")==bat.count(b"\\r\\n") and bat.count(b"\\r\\n")>0;\n'
      + `assert b"Shear Sentinel v${PRODUCT_VERSION.split('.')[0]}" in cmd and b"pause" in cmd.lower();\n`
      + 'print("crlf-ok")',
      zipPath,
    ]);
    assert.equal(crlf.status, 0, `${crlf.stdout}\n${crlf.stderr}`);
    assert.match(crlf.stdout, /crlf-ok/);
  });

  it('every file named by the node and wallet packers is in the tree', () => {
    function listed(rel, open, close) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      const start = text.indexOf(open);
      assert.ok(start >= 0, `${rel} missing ${open}`);
      const end = text.indexOf(close, start);
      assert.ok(end > start, `${rel} missing ${close}`);
      const body = text.slice(start, end);
      const paths = [];
      for (const m of body.matchAll(/['"]([^'"]+)['"]/g)) {
        if (m[1].includes('/')) paths.push(m[1]);
      }
      assert.ok(paths.length > 0, rel);
      return paths;
    }
    const groups = [
      listed('node/pack/zip_node.py', 'for rel in (', '):'),
      listed('wallet/pack/zip_windows.py', 'for extra in (', '):'),
      listed('node/pack/bundle_modules.py', 'SHIPPED = (', ')'),
    ];
    for (const paths of groups) {
      assert.equal(paths.includes('pool/src/admin.js'), false);
      for (const rel of paths) {
        assert.equal(fs.existsSync(path.join(root, rel)), true, rel);
      }
    }
  });
});
