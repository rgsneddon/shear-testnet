/**
 * Android floor and ELF shape. A missing APK does not skip the source or
 * fixture checks. A present pack that is the wrong ABI, page size, or pin
 * fails.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function elfFixture(machine, align) {
  const buf = Buffer.alloc(64 + 56);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 2;
  buf[5] = 1;
  buf.writeUInt16LE(machine, 18);
  buf.writeBigUInt64LE(64n, 32);
  buf.writeUInt16LE(56, 54);
  buf.writeUInt16LE(1, 56);
  buf.writeUInt32LE(1, 64);
  buf.writeBigUInt64LE(BigInt(align), 64 + 48);
  return buf;
}

function elfArm64Page16k(bytes) {
  if (bytes.length < 64) return false;
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) return false;
  if (bytes[4] !== 2 || bytes[5] !== 1) return false;
  if (bytes.readUInt16LE(18) !== 183) return false;
  const phoff = Number(bytes.readBigUInt64LE(32));
  const phentsize = bytes.readUInt16LE(54);
  const phnum = bytes.readUInt16LE(56);
  if (phentsize < 56 || phnum === 0) return false;
  let saw = false;
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    if (off + 56 > bytes.length) return false;
    if (bytes.readUInt32LE(off) !== 1) continue;
    saw = true;
    const align = Number(bytes.readBigUInt64LE(off + 48));
    if (align < 16384) return false;
  }
  return saw;
}

function walkSos(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkSos(p, out);
    else if (name.endsWith('.so')) out.push(p);
  }
}

describe('android native libs', () => {
  it('minSdk is 29 and the script is arm64 with 16 KiB pages', () => {
    const gradle = fs.readFileSync(path.join(root, 'wallet/android/app/build.gradle.kts'), 'utf8');
    const script = fs.readFileSync(path.join(root, 'crypto/native/build-android-arm64.sh'), 'utf8');
    assert.match(gradle, /minSdk = 29/);
    assert.doesNotMatch(gradle, /flutter\.minSdkVersion/);
    assert.match(gradle, /abiFilters\.add\("armeabi-v7a"\)/);
    assert.match(gradle, /abiFilters\.add\("arm64-v8a"\)/);
    assert.match(gradle, /abiFilters\.add\("x86"\)/);
    assert.match(gradle, /abiFilters\.add\("x86_64"\)/);
    assert.match(gradle, /build-shearhash-android\.sh/);
    assert.doesNotMatch(gradle, /lib\/armeabi-v7a\/\*\*/);
    assert.match(script, /SHEAR_ANDROID_API:-29/);
    assert.match(script, /max-page-size=16384/);
    assert.match(script, /jniLibs\/arm64-v8a/);
    assert.doesNotMatch(script, /--features[^\n]*admit-v3/);
    assert.equal(elfArm64Page16k(elfFixture(183, 16384)), true);
    assert.equal(elfArm64Page16k(elfFixture(62, 16384)), false);
    assert.equal(elfArm64Page16k(elfFixture(183, 4096)), false);
  });

  it('libshear_admit.so is present for the APK and pin-matched', () => {
    const so = path.join(root, 'wallet/android/app/src/main/jniLibs/arm64-v8a/libshear_admit.so');
    assert.equal(
      fs.existsSync(so),
      true,
      'libshear_admit.so is gitignored. android-admit CI builds it with NDK r27c.',
    );
    const jni = path.join(root, 'wallet/android/app/src/main/jniLibs');
    const sos = [];
    walkSos(jni, sos);
    const apkCandidates = [
      path.join(root, 'dist/shear-wallet-0.48-android.apk'),
      path.join(root, 'wallet/../dist/shear-wallet-0.48-android.apk'),
    ];
    const apk = apkCandidates.find((p) => fs.existsSync(p));
    const hashAbis = ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'];
    for (const so of sos) {
      const rel = so.replaceAll('\\', '/');
      const bytes = fs.readFileSync(so);
      if (rel.endsWith('/libshearhash.so')) {
        assert.equal(hashAbis.some((abi) => rel.includes(`/${abi}/`)), true, rel);
        assert.equal(fs.existsSync(so + '.sha256'), true, `${so}.sha256 missing`);
        const want = fs.readFileSync(so + '.sha256', 'utf8').trim();
        const got = crypto.createHash('sha256').update(bytes).digest('hex');
        assert.equal(got, want, rel);
        if (rel.includes('/arm64-v8a/')) assert.equal(elfArm64Page16k(bytes), true, rel);
      } else {
        assert.equal(rel.includes('/arm64-v8a/'), true, rel);
        assert.equal(rel.includes('/armeabi'), false, rel);
        assert.equal(rel.includes('/x86'), false, rel);
        assert.equal(elfArm64Page16k(bytes), true, rel);
        if (so.endsWith('libshear_admit.so')) {
          assert.equal(fs.existsSync(so + '.sha256'), true, `${so}.sha256 missing`);
          const want = fs.readFileSync(so + '.sha256', 'utf8').trim();
          const got = crypto.createHash('sha256').update(bytes).digest('hex');
          assert.equal(got, want, rel);
        }
      }
    }
    if (sos.length > 0) {
      assert.equal(sos.some((p) => p.endsWith('libshear_admit.so')), true);
    }
    if (!apk) return;
    const listed = execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8' });
    const names = listed.split('\n').filter((l) => l.endsWith('.so'));
    assert.equal(names.includes('lib/arm64-v8a/libshear_admit.so'), true, names.join('\n'));
    assert.equal(names.includes('lib/arm64-v8a/libsodium.so'), true, names.join('\n'));
    for (const name of names) {
      if (name.endsWith('/libshearhash.so')) {
        assert.equal(hashAbis.some((abi) => name === `lib/${abi}/libshearhash.so`), true, name);
      } else {
        assert.equal(name.startsWith('lib/arm64-v8a/'), true, name);
      }
    }
  });
});
