/**
 * The one-off wallet pack dispatches (wallet-linux, wallet-windows) take
 * their pin from the tree, and never publish unless asked. A stale default
 * pin (0.35, 0.32) once refused a check build or named another release, and
 * wallet-windows defaulted to uploading over a published asset (Russell
 * 26 Oct).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function inputBlock(yml, name) {
  const at = yml.indexOf(`      ${name}:`);
  assert.ok(at >= 0, `input ${name}`);
  const next = yml.slice(at + 1).search(/\n {6}[a-z_]+:\n|\n[a-z]/);
  return yml.slice(at, next < 0 ? undefined : at + 1 + next);
}

describe('wallet pack dispatch inputs', () => {
  const pkgver = /^pkgver=(.+)$/m.exec(read('wallet/pack/archlinux/PKGBUILD').replace(/\r/g, ''))?.[1];

  for (const wf of ['wallet-linux', 'wallet-windows']) {
    it(`${wf}: an empty pin reads pubspec, and a PKGBUILD or pin that differs is refused`, () => {
      const yml = read(`.github/workflows/${wf}.yml`);
      const pin = inputBlock(yml, 'pin');
      assert.match(pin, /required: false/);
      assert.match(pin, /default: ''/);
      // The pin is pubspec's x.y; the PKGBUILD and a given pin must equal it.
      assert.match(yml, /want="\$\(tr -d '\\r' < wallet\/pubspec\.yaml \| sed -n /);
      assert.match(yml, /have="\$\(tr -d '\\r' < wallet\/pack\/archlinux\/PKGBUILD \| sed -n 's\/\^pkgver=\/\/p' \| head -1\)"/);
      assert.match(yml, /if \[ "\$have" != "\$want" \]; then .*exit 1; fi/);
      assert.match(yml, /pin="\$\{ASKED:-\$want\}"/);
      assert.match(yml, /if \[ "\$pin" != "\$want" \]; then .*exit 1; fi/);
      assert.match(yml, /echo "WALLET_PIN=\$pin" >> "\$GITHUB_ENV"/);
      // Every later use is the resolved pin, never the raw input.
      assert.equal((yml.match(/\$\{\{ inputs\.pin \}\}/g) || []).length, 1, 'inputs.pin only feeds the resolver');
      assert.ok(pkgver && /^\d+\.\d+$/.test(pkgver), `two-part pkgver ${pkgver}`);
    });
  }

  it('wallet-windows publishes only when asked', () => {
    const attach = inputBlock(read('.github/workflows/wallet-windows.yml'), 'attach');
    assert.match(attach, /type: boolean/);
    assert.match(attach, /default: false/);
  });
});
