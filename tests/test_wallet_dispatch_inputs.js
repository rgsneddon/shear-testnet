/**
 * The wallet pack workflows (wallet-linux, wallet-windows, wallet-release)
 * take their pin and build number from wallet/pubspec.yaml through
 * scripts/wallet_pin.sh, and never publish unless asked. Stale default pins
 * (0.35, 0.32, 0.70) once refused a check build or named another release,
 * stale build numbers (51, 48, 95) could never match the version.json that
 * zip_windows.py checks, and wallet-windows defaulted to uploading over a
 * published asset (Russell 26 Oct).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r/g, '');
const script = fileURLToPath(new URL('../scripts/wallet_pin.sh', import.meta.url));

function inputBlock(yml, name) {
  const at = yml.indexOf(`      ${name}:`);
  assert.ok(at >= 0, `input ${name}`);
  const next = yml.slice(at + 1).search(/\n {6}[a-z_]+:\n|\n[a-z]/);
  return yml.slice(at, next < 0 ? undefined : at + 1 + next);
}

/** A copy of scripts/wallet_pin.sh in a temp tree with this pubspec and PKGBUILD. */
function pinTree(version, pkgver) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-pin-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'wallet/pack/archlinux'), { recursive: true });
  fs.copyFileSync(script, path.join(root, 'scripts/wallet_pin.sh'));
  fs.writeFileSync(path.join(root, 'wallet/pubspec.yaml'), `name: shear_wallet\r\nversion: ${version}\r\n`);
  fs.writeFileSync(path.join(root, 'wallet/pack/archlinux/PKGBUILD'), `pkgname=shear-wallet\npkgver=${pkgver}\n`);
  return path.join(root, 'scripts/wallet_pin.sh');
}

function resolve(file, ...args) {
  const env = { ...process.env };
  delete env.GITHUB_ENV;
  return spawnSync('bash', [file, ...args], { encoding: 'utf8', env, timeout: 60_000 });
}

describe('wallet pack dispatch inputs', () => {
  for (const wf of ['wallet-linux', 'wallet-windows', 'wallet-release']) {
    it(`${wf}: pin and build number come from pubspec through wallet_pin.sh in every job`, () => {
      const yml = read(`.github/workflows/${wf}.yml`);
      for (const name of ['pin', 'build_number']) {
        const block = inputBlock(yml, name);
        assert.match(block, /required: false/, `${name} required`);
        assert.match(block, /default: ''/, `${name} default`);
      }
      // Every job's checkout is followed at once by the resolver.
      const checkouts = yml.split('      - uses: actions/checkout@v4\n').length - 1;
      assert.ok(checkouts >= 1);
      const resolved = yml.match(/- uses: actions\/checkout@v4\n {6}- name: Wallet pin\n(?: {8}.*\n)*? {8}run: (?:\|\n {10})?bash scripts\/wallet_pin\.sh "\$ASKED" "\$ASKED_BUILD"\n/g) || [];
      assert.equal(resolved.length, checkouts, 'one resolver per checkout');
      // The raw inputs only feed the resolver.
      assert.equal((yml.match(/\$\{\{ inputs\.pin \}\}/g) || []).length, checkouts, 'inputs.pin only feeds the resolver');
      assert.equal((yml.match(/\$\{\{ inputs\.build_number \}\}/g) || []).length, checkouts, 'inputs.build_number only feeds the resolver');
      const names = yml.match(/--build-name=\S+/g) || [];
      const numbers = yml.match(/--build-number=\S+/g) || [];
      assert.ok(names.length >= 1 && names.length === numbers.length);
      for (const n of names) assert.equal(n, '--build-name=${{', n);
      assert.equal((yml.match(/--build-name=\$\{\{ env\.WALLET_NAME \}\}/g) || []).length, names.length);
      assert.equal((yml.match(/--build-number=\$\{\{ env\.WALLET_BUILD \}\}/g) || []).length, numbers.length);
    });
  }

  it('wallet-windows publishes only when asked', () => {
    const attach = inputBlock(read('.github/workflows/wallet-windows.yml'), 'attach');
    assert.match(attach, /type: boolean/);
    assert.match(attach, /default: false/);
  });

  it('wallet_pin.sh reads pubspec, and refuses a pin, build number or PKGBUILD that differs', () => {
    const tree = pinTree('0.72.0+97', '0.72');
    const ok = resolve(tree);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.equal(ok.stdout, 'WALLET_PIN=0.72\nWALLET_BUILD=97\nWALLET_NAME=0.72.0\n');
    assert.equal(resolve(tree, '0.72', '97').status, 0);
    for (const [args, why] of [[['0.71'], /pin 0\.71 is not pubspec's 0\.72/], [['', '48'], /build_number 48 is not pubspec's \+97/]]) {
      const bad = resolve(tree, ...args);
      assert.equal(bad.status, 1, why.source);
      assert.match(bad.stdout, why);
    }
    const stale = resolve(pinTree('0.72.0+97', '0.71'));
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /PKGBUILD pkgver 0\.71 is not pubspec's 0\.72/);
    const shapeless = resolve(pinTree('0.72+97', '0.72'));
    assert.equal(shapeless.status, 1);
    assert.match(shapeless.stdout, /no x\.y\.0\+N version/);
  });

  it('the tree resolves to its own pubspec', () => {
    const want = /^version: (\d+)\.(\d+)\.0\+(\d+)$/m.exec(read('wallet/pubspec.yaml'));
    assert.ok(want, 'pubspec x.y.0+N');
    const got = resolve(script);
    assert.equal(got.status, 0, got.stdout + got.stderr);
    assert.equal(got.stdout, `WALLET_PIN=${want[1]}.${want[2]}\nWALLET_BUILD=${want[3]}\nWALLET_NAME=${want[1]}.${want[2]}.0\n`);
  });

  it('no pack script hard-codes a build name or number', () => {
    for (const f of ['wallet/pack/build_linux.sh', 'wallet/pack/pack_android.sh', 'wallet/pack/pack_linux_de.sh']) {
      const text = read(f);
      assert.equal(/--build-name=\d/.test(text), false, `${f} build-name literal`);
      assert.equal(/--build-number=\d/.test(text), false, `${f} build-number literal`);
    }
  });
});
