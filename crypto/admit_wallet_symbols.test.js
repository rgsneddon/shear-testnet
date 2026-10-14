/**
 * Wallet cdylib must not export the bucket-32 v3 prover. The node addon
 * turns admit-v3 on in its own target dir.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
    assert.match(mac, /stamp_admit_pin\.py/);
    assert.doesNotMatch(mac, /--dart/);
    const signAt = mac.indexOf('codesign --force --sign -');
    const stampAt = mac.indexOf('stamp_admit_pin.py');
    assert.ok(signAt > 0 && stampAt > signAt, 'hash the dylib after codesign');
    for (const rel of ['wallet/linux/CMakeLists.txt', 'wallet/windows/CMakeLists.txt']) {
      assert.doesNotMatch(read(rel), /stamp_admit_pin\.py" --dart|stamp_admit_pin\.py\\" --dart|--dart/);
    }
    const pin = read('wallet/lib/shear_admit_pin.dart');
    assert.match(pin, /String\.fromEnvironment\('SHEAR_ADMIT_SHA256'\)/);
    assert.match(pin, /SHEAR_ADMIT_SIGN_ID/);
    const win = read('wallet/windows/runner/main.cpp');
    assert.match(win, /SetDefaultDllDirectories/);
    assert.match(win, /LOAD_LIBRARY_SEARCH_APPLICATION_DIR/);
    assert.match(win, /LOAD_LIBRARY_SEARCH_SYSTEM32/);
  });

  it('stamp_admit_pin writes a sidecar and a dart-define without editing source', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admit-pin-'));
    const lib = path.join(dir, 'libshear_admit.so');
    fs.writeFileSync(lib, Buffer.from([1, 2, 3, 4]));
    const pinPath = path.join(root, 'wallet/lib/shear_admit_pin.dart');
    const before = fs.readFileSync(pinPath, 'utf8');
    const out = execFileSync('python3', [path.join(root, 'crypto/native/stamp_admit_pin.py'), '--define', lib], {
      encoding: 'utf8',
    }).trim();
    const digest = crypto.createHash('sha256').update(Buffer.from([1, 2, 3, 4])).digest('hex');
    assert.equal(out, `--dart-define=SHEAR_ADMIT_SHA256=${digest}`);
    assert.equal(fs.readFileSync(`${lib}.sha256`, 'utf8').trim(), digest);
    assert.equal(fs.readFileSync(pinPath, 'utf8'), before);
    assert.doesNotMatch(before, new RegExp(digest));
  });

  it('debug cdylib and staticlib omit the v3 symbols', () => {
    execFileSync(
      'cargo',
      ['build', '--lib', '--manifest-path', path.join(root, 'crypto/native/admit/Cargo.toml')],
      { stdio: 'inherit' },
    );
    const dir = path.join(root, 'crypto/native/admit/target/debug');
    assertNoV3(nmText(['-D', path.join(dir, 'libshear_admit.so')]), 'debug so');
    assertNoV3(nmText(['-g', '--defined-only', path.join(dir, 'libshear_admit.a')]), 'debug a');
    const release = path.join(root, 'crypto/native/admit/target/release/libshear_admit.so');
    if (fs.existsSync(release)) {
      assertNoV3(nmText(['-D', release]), 'release so');
    }
    const android = path.join(root, 'wallet/android/app/src/main/jniLibs/arm64-v8a/libshear_admit.so');
    if (fs.existsSync(android)) {
      assertNoV3(nmText(['-D', android]), 'android so');
    }
  });
});

function nmText(args) {
  return execFileSync('nm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function assertNoV3(nm, label) {
  assert.match(nm, /\bshear_range_prove\b/, label);
  assert.match(nm, /\bshear_range_verify\b/, label);
  assert.doesNotMatch(nm, /shear_admit_prove_v3/, label);
  assert.doesNotMatch(nm, /shear_admit_verify_v3/, label);
}
