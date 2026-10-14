/**
 * Wallet cdylib must not export the bucket-32 v3 prover. The node addon
 * turns admit-v3 on in its own target dir.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('wallet artifacts omit admit v3 exports', () => {
  it('wallet builds do not pass admit-v3 and macOS codesign is not soft-failed', () => {
    const wallet = [
      'wallet/linux/CMakeLists.txt',
      'wallet/windows/CMakeLists.txt',
      'wallet/ios/Runner.xcodeproj/project.pbxproj',
      'wallet/macos/Runner.xcodeproj/project.pbxproj',
      'crypto/native/build-android-arm64.sh',
    ];
    for (const rel of wallet) {
      assert.doesNotMatch(read(rel), /--features[^\n]*admit-v3/, rel);
    }
    const make = read('crypto/native/Makefile');
    assert.match(make, /ADMIT_FEATURES := --features admit-v3/);
    assert.match(make, /target\/node/);
    assert.match(make, /ios-staticlib:/);
    const ios = make.slice(make.indexOf('ios-staticlib:'));
    assert.doesNotMatch(ios.slice(0, 240), /admit-v3/);
    const mac = read('wallet/macos/Runner.xcodeproj/project.pbxproj');
    assert.match(mac, /codesign --force --sign -/);
    assert.doesNotMatch(mac, /\|\| true/);
    assert.match(mac, /stamp_admit_pin\.py\\" --dart/);
    const win = read('wallet/windows/runner/main.cpp');
    assert.match(win, /SetDefaultDllDirectories/);
    assert.match(win, /LOAD_LIBRARY_SEARCH_APPLICATION_DIR/);
    assert.match(win, /LOAD_LIBRARY_SEARCH_SYSTEM32/);
  });

  it('debug cdylib exports shear_range_prove and not the v3 symbols', () => {
    execFileSync(
      'cargo',
      ['build', '--lib', '--manifest-path', path.join(root, 'crypto/native/admit/Cargo.toml')],
      { stdio: 'inherit' },
    );
    const so = path.join(root, 'crypto/native/admit/target/debug/libshear_admit.so');
    assert.equal(fs.existsSync(so), true, so);
    const nm = execFileSync('nm', ['-D', so], { encoding: 'utf8' });
    assert.match(nm, /\bshear_range_prove\b/);
    assert.match(nm, /\bshear_range_verify\b/);
    assert.doesNotMatch(nm, /shear_admit_prove_v3/);
    assert.doesNotMatch(nm, /shear_admit_verify_v3/);
  });
});
