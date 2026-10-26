/**
 * wallet/pubspec.yaml is the one source of the wallet release pin (x.y of
 * x.y.0+N). The wallet pack dispatches build with --build-name from it, so
 * every other copy in the tree must say the same: the PKGBUILD once said 0.71
 * while the app said 0.72, and a pack built from it would have named a 0.72
 * wallet 0.71 (Russell 26 Oct: fix it at the source).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r/g, '');
const one = (text, re, what) => {
  const m = re.exec(text);
  assert.ok(m, what);
  return m[1];
};

describe('wallet version pins', () => {
  const pubspec = read('wallet/pubspec.yaml');
  const pin = one(pubspec, /^version: (\d+\.\d+)\.0\+\d+$/m, 'pubspec version x.y.0+N');

  it('every copy of the release pin is pubspec\'s', () => {
    const pkgbuild = read('wallet/pack/archlinux/PKGBUILD');
    const copies = {
      'pubspec description': one(pubspec, /^description: ".*\] (\d+\.\d+)"$/m, 'pubspec description'),
      'pubspec displayed pin': one(pubspec, /Displayed pin is (\d+\.\d+)\./, 'pubspec comment'),
      'PKGBUILD pkgver': one(pkgbuild, /^pkgver=(.+)$/m, 'pkgver'),
      'PKGBUILD pkgdesc': one(pkgbuild, /^pkgdesc='.* (\d+\.\d+)'$/m, 'pkgdesc'),
      kWalletVersion: one(read('wallet/lib/main.dart'), /^const kWalletVersion = '(.+)';$/m, 'kWalletVersion'),
      kCliVersion: one(read('wallet/lib/shear_cli.dart'), /^const kCliVersion = '(.+)';$/m, 'kCliVersion'),
      'Android label': one(read('wallet/android/app/src/main/AndroidManifest.xml'), /android:label="Shear (.+)"/, 'android:label'),
      'packaging smoke': one(read('scripts/packaging/smoke.sh'), /grep -q 'Shear wallet (.+)'/, 'smoke.sh'),
      'genesis cut': one(read('scripts/v12-genesis-cut.mjs'), /pins\.walletVersion !== '(.+?)'/, 'v12-genesis-cut'),
    };
    const runner = read('wallet/linux/runner/my_application.cc');
    const titles = [...runner.matchAll(/_set_title\([a-z_]+, "Shear (.+?)"\)/g)].map((m) => m[1]);
    assert.equal(titles.length, 2, 'header bar and window titles');
    titles.forEach((t, i) => { copies[`Linux title ${i + 1}`] = t; });
    for (const [where, got] of Object.entries(copies)) assert.equal(got, pin, `${where} is ${got}, pubspec is ${pin}`);
  });

  it('no stale copy of the wallet-windows workflow sits outside .github', () => {
    assert.equal(fs.existsSync(new URL('../wallet/pack/github-wallet-windows.yml', import.meta.url)), false);
  });
});
