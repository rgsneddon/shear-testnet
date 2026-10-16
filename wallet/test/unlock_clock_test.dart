import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_asert.dart' hide kTargetBlockIntervalMs;
import 'package:shear_wallet/shear_hash.dart';
import 'package:shear_wallet/shear_hash_v3.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_reserve.dart';

void _stage() {
  stageBundledShearHashForTest(
    '${Directory.current.path}/../crypto/native/libshearhash.so',
  );
}

void _u32(Uint8List header, int offset, int value) {
  header[offset] = value & 0xff;
  header[offset + 1] = (value >> 8) & 0xff;
  header[offset + 2] = (value >> 16) & 0xff;
  header[offset + 3] = (value >> 24) & 0xff;
}

void _u64(Uint8List header, int offset, int value) {
  var v = value;
  for (var i = 0; i < 8; i++) {
    header[offset + i] = v & 0xff;
    v >>= 8;
  }
}

String _hex(Uint8List bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

class _Window {
  _Window(this.genesisMs, this.parent, this.tip, this.rows);
  final int genesisMs;
  final Uint8List parent;
  final int tip;
  final List<({int height, Uint8List header, Uint8List digest})> rows;
  int get parentHeight => rows.first.height - 1;
}

_Window _mine(int tipMs) {
  _stage();
  expect(shearHashV3Ready, isTrue);
  const count = 11;
  final tip = 20 + count - 1;
  final genesisMs = tipMs - 3 * 24 * 3600 * 1000;
  final parent = Uint8List(32)..[0] = 0x11;
  final rows = <({int height, Uint8List header, Uint8List digest})>[];
  var prev = parent;
  for (var h = tip - count + 1; h <= tip; h++) {
    final quote = asertNextBits(
      anchorTimeMs: genesisMs,
      blockTimeMs: tipMs,
      blockHeight: h,
      parentTimeMs: tipMs,
    );
    expect(quote.packed, kLiveMinBits * kBitsFpScale);
    final header = Uint8List(shearHeaderLen);
    header[0] = 1;
    header.setRange(4, 36, prev);
    _u64(header, 100, tipMs);
    _u32(header, 108, quote.packed);
    Uint8List? digest;
    for (var n = 0; n < 256; n++) {
      shearSetNonce(header, n);
      final got = shearHashV3(header);
      if (got != null && shearMeetsTarget(got, quote.packed)) {
        digest = got;
        break;
      }
    }
    expect(digest, isNotNull, reason: 'height $h');
    rows.add((height: h, header: Uint8List.fromList(header), digest: digest!));
    prev = digest;
  }
  return _Window(genesisMs, parent, tip, rows);
}

void _accept(_Window w, ShearLedger ledger) {
  final stamp = headerTimestampMs(w.rows.first.header);
  ledger.noteGenesisPin(w.genesisMs);
  ledger.noteUnlockAnchor(
    height: w.parentHeight,
    digestHex: _hex(w.parent),
    timeMs: stamp,
  );
  final tip = w.rows.last;
  final prev = w.rows[w.rows.length - 2];
  ledger.noteUnlockAnchor(
    height: prev.height,
    digestHex: _hex(prev.digest),
    timeMs: headerTimestampMs(prev.header),
  );
  ledger.noteUnlockAnchor(
    height: tip.height,
    digestHex: _hex(tip.digest),
    timeMs: headerTimestampMs(tip.header),
  );
  ledger.noteAcceptedTip(w.tip);
  for (final row in w.rows) {
    expect(
      ledger.noteVerifiedHeader(header: row.header, height: row.height, hashHex: ''),
      isTrue,
      reason: 'height ${row.height}',
    );
  }
}

Future<HttpServer> _serve(Map<int, Uint8List> headers, int tip, int rawTipMs) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((req) async {
    req.response.headers.contentType = ContentType.json;
    final height = int.tryParse(req.uri.queryParameters['height'] ?? '') ?? 0;
    if (req.uri.path == '/stats' || req.uri.path == '/api/stats') {
      final raw = Uint8List(shearHeaderLen);
      _u64(raw, 100, rawTipMs);
      req.response.write(jsonEncode({
        'ok': true,
        'height': tip,
        'magic': 'shear-testnet-v12',
        'network': 'shear-testnet-v12',
        'header': _hex(raw),
      }));
    } else if (req.uri.path == '/header' || req.uri.path == '/api/explorer/header') {
      final body = headers[height];
      req.response.write(jsonEncode({
        'ok': body != null,
        'height': height,
        'header': body == null ? '' : _hex(body),
        'hash': 'ff' * 32,
      }));
    } else {
      req.response.statusCode = 404;
      req.response.write('{"ok":false}');
    }
    await req.response.close();
  });
  return server;
}

void main() {
  test('ASERT quotes match crypto/asert.js', () {
    final on = asertNextBits(
      anchorTimeMs: 0,
      blockTimeMs: 10 * kTargetBlockIntervalMs,
      blockHeight: 11,
      parentTimeMs: 0,
    );
    expect(on.ok, isTrue);
    expect(on.packed, kGenesisBitsPacked);
    expect(on.eased, 1093014);
    expect(bitsAcceptAsert(kGenesisBitsPacked, on), isTrue);
    final step = asertNextBits(
      anchorTimeMs: 1000,
      blockTimeMs: 46000,
      blockHeight: 2,
      parentTimeMs: 1000,
    );
    expect(step.packed, 1114522);
    expect(step.easeBits, 0);
    expect(bitsAcceptAsert(1114522, step), isTrue);
    expect(bitsAcceptAsert(1114521, step), isFalse);
    expect(headerBitsMatchAsert(
      height: 2,
      bits: 1,
      timestampMs: 46000,
      genesisMs: 1000,
    ), isFalse);
  });

  test('the hash loader ignores env, cwd, and a bare name', () {
    final got = shearHashLibraryCandidates(
      operatingSystem: 'linux',
      exeDir: '/app',
      envPath: '/tmp/evil/libshearhash.so',
      cwd: '/tmp/cwd',
    );
    expect(got, ['/app/lib/libshearhash.so']);
    expect(bundledShearHashLibrary(operatingSystem: 'windows', exeDir: r'C:\app'),
        r'C:\app\libshearhash.dll');
    expect(bundledShearHashLibrary(operatingSystem: 'android', exeDir: '/app'),
        'libshearhash.so');
    expect(
      bundledShearHashLibrary(
        operatingSystem: 'macos',
        exeDir: '/App.app/Contents/MacOS',
      ),
      '/App.app/Contents/Frameworks/libshearhash.dylib',
    );
    expect(shearHashPinFailure([1, 2, 3], ''), 'missing sha256 pin');
    expect(shearHashPinFailure([1, 2, 3], '00'), 'sha256 mismatch');
    expect(kMtpFutureMs, 7200000);
    const maps = '7f000000-7f001000 r-xp 00000000 00:00 1 /data/app/pkg/lib/arm64/libflutter.so\n';
    expect(
      androidShearHashLibraryFromMaps(maps),
      '/data/app/pkg/lib/arm64/libshearhash.so',
    );
    expect(
      androidShearHashLibraryFromMaps('7f0-7f1 r-xp 0 /data/app/pkg/lib/x86_64/libapp.so'),
      '/data/app/pkg/lib/x86_64/libshearhash.so',
    );
    expect(androidShearHashLibraryFromMaps(''), isNull);
    final loader = File('lib/shear_hash_v3.dart').readAsStringSync();
    final androidOpen = loader.indexOf('void _openAndroid()');
    final pin = loader.indexOf('shearHashBundledFailure', androidOpen);
    final dlopen = loader.indexOf('DynamicLibrary.open', androidOpen);
    expect(androidOpen, greaterThan(0));
    expect(pin, greaterThan(androidOpen));
    expect(dlopen, greaterThan(pin));
    expect(shearHashMemoryOkFromMeminfo('MemAvailable:        100 kB\n'), isFalse);
    expect(shearHashMemoryOkFromMeminfo('MemAvailable:        400000 kB\n'), isTrue);
    expect(shearHashMemoryOkFromMeminfo(''), isFalse);
  });

  test('each shipped Android ABI loads its own pin', () {
    final arm = 'aa' * 32;
    final arm64 = 'bb' * 32;
    final x86 = 'cc' * 32;
    final x64 = 'dd' * 32;
    final raw = 'armeabi-v7a=$arm,arm64-v8a=$arm64,x86=$x86,x86_64=$x64';
    final pins = parseShearHashAndroidPins(raw);
    expect(pins.keys, kShearHashAndroidAbis);
    expect(androidAbiFromLibraryPath('/data/app/pkg/lib/arm64/libshearhash.so'), 'arm64-v8a');
    expect(androidAbiFromLibraryPath('/data/app/pkg/lib/arm64-v8a/libflutter.so'), 'arm64-v8a');
    expect(androidAbiFromLibraryPath('/data/app/pkg/lib/armeabi-v7a/libshearhash.so'), 'armeabi-v7a');
    expect(androidAbiFromLibraryPath('/data/app/pkg/lib/arm/libapp.so'), 'armeabi-v7a');
    expect(androidAbiFromLibraryPath('/data/app/pkg/lib/x86_64/libshearhash.so'), 'x86_64');
    expect(androidAbiFromLibraryPath('/data/app/pkg/lib/x86/libshearhash.so'), 'x86');
    expect(androidAbiFromLibraryPath('/app/lib/libshearhash.so'), isNull);
    expect(
      shearHashExpectedPin('/data/app/pkg/lib/arm64/libshearhash.so', androidPins: raw, desktopPin: 'ff' * 32),
      arm64,
    );
    expect(
      shearHashExpectedPin('/data/app/pkg/lib/x86/libshearhash.so', androidPins: raw, desktopPin: 'ff' * 32),
      x86,
    );
    expect(
      shearHashExpectedPin('/data/app/pkg/lib/armeabi-v7a/libshearhash.so', androidPins: raw, desktopPin: 'ff' * 32),
      arm,
    );
    expect(
      shearHashExpectedPin('/data/app/pkg/lib/x86_64/libshearhash.so', androidPins: '--dart-define=SHEAR_HASH_SHA256_ANDROID=$raw'),
      x64,
    );
    // One compiled-in desktop pin must not authorize an Android ABI.
    expect(
      shearHashExpectedPin('/data/app/pkg/lib/arm64/libshearhash.so', androidPins: '', desktopPin: 'ff' * 32),
      '',
    );
    expect(shearHashExpectedPin('/app/lib/libshearhash.so', androidPins: raw, desktopPin: 'ee' * 32), 'ee' * 32);
  });

  test('a low-difficulty 11-header window and an unanchored window are rejected', () async {
    const tipMs = 1700000000000;
    final window = _mine(tipMs);
    final easyParent = Uint8List(32)..[0] = 0xcd;
    final easy = <({int height, Uint8List header})>[];
    var prev = easyParent;
    for (var h = 20; h <= 30; h++) {
      final header = Uint8List(shearHeaderLen);
      header[0] = 1;
      header.setRange(4, 36, prev);
      _u64(header, 100, tipMs);
      header[108] = 1;
      Uint8List? digest;
      for (var n = 0; n < 64; n++) {
        shearSetNonce(header, n);
        final got = shearHashV3(header);
        if (got != null && shearMeetsTarget(got, 1)) {
          digest = got;
          break;
        }
      }
      expect(digest, isNotNull);
      easy.add((height: h, header: Uint8List.fromList(header)));
      prev = digest!;
    }
    final low = ShearLedger()
      ..noteGenesisPin(window.genesisMs)
      ..noteUnlockAnchor(height: 19, digestHex: _hex(easyParent))
      ..noteAcceptedTip(30);
    expect(
      low.noteVerifiedHeader(header: easy.first.header, height: 20, hashHex: 'ff' * 32),
      isFalse,
    );
    expect(low.verifiedMedianTimeMs, isNull);

    final bare = ShearLedger()..noteGenesisPin(window.genesisMs)..noteAcceptedTip(window.tip);
    expect(
      bare.noteVerifiedHeader(
        header: window.rows.first.header,
        height: window.rows.first.height,
        hashHex: '',
      ),
      isFalse,
    );
    final headers = {for (final row in window.rows) row.height: row.header};
    final server = await _serve(headers, window.tip, tipMs + 3600000);
    addTearDown(() => server.close(force: true));
    final live = ShearLedger(
      pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}'),
    )
      ..noteGenesisPin(window.genesisMs)
      ..noteAcceptedTip(window.tip);
    await live.syncTip(proveChain: false);
    expect(live.verifiedMedianTimeMs, isNull);
    expect(live.verifiedClockTip, 0);
    expect(live.tipTimestampMs, tipMs + 3600000);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('a conflicting digest drops that height and the clock refills from the accepted tip', () async {
    const tipMs = 1700000001000;
    final window = _mine(tipMs);
    final ledger = ShearLedger();
    final before = shearHashV3CallCount;
    _accept(window, ledger);
    expect(shearHashV3CallCount, greaterThan(before));
    final hashed = shearHashV3CallCount;
    _accept(window, ledger);
    expect(shearHashV3CallCount, hashed);
    expect(ledger.verifiedClockTip, window.tip);
    final fork = window.rows.firstWhere((row) => row.height == 25);
    final below = window.rows.firstWhere((row) => row.height == 24);
    expect(ledger.verifiedTimeAtHeight(28), tipMs);
    expect(ledger.verifiedTimeAtHeight(24), tipMs);
    final replacement = Uint8List.fromList(fork.header);
    Uint8List? digest;
    for (var n = 0; n < 256; n++) {
      shearSetNonce(replacement, 1000 + n);
      final got = shearHashV3(replacement);
      if (got != null && shearMeetsTarget(got, kLiveMinBits * kBitsFpScale) && _hex(got) != _hex(fork.digest)) {
        digest = got;
        break;
      }
    }
    expect(digest, isNotNull);
    expect(
      ledger.noteVerifiedHeader(header: replacement, height: 25, hashHex: 'ee' * 32),
      isTrue,
    );
    expect(ledger.verifiedTimeAtHeight(28), isNull);
    expect(ledger.verifiedTimeAtHeight(26), isNull);
    expect(ledger.verifiedTimeAtHeight(24), tipMs);
    expect(ledger.verifiedClockTip, 0);
    const nextMs = tipMs + 60000;
    var prev = digest!;
    final served = <int, Uint8List>{
      for (final row in window.rows)
        if (row.height < 25) row.height: row.header,
      25: replacement,
    };
    for (var h = 26; h <= window.tip; h++) {
      final quote = asertNextBits(
        anchorTimeMs: window.genesisMs,
        blockTimeMs: nextMs,
        blockHeight: h,
        parentTimeMs: h == 26 ? tipMs : nextMs,
      );
      expect(quote.ok, isTrue);
      final header = Uint8List(shearHeaderLen);
      header[0] = 1;
      header.setRange(4, 36, prev);
      _u64(header, 100, nextMs);
      _u32(header, 108, quote.packed);
      Uint8List? got;
      for (var n = 0; n < 256; n++) {
        shearSetNonce(header, n);
        final hash = shearHashV3(header);
        if (hash != null && shearMeetsTarget(hash, quote.packed)) {
          got = hash;
          break;
        }
      }
      expect(got, isNotNull, reason: 'refill $h');
      final stored = Uint8List.fromList(header);
      served[h] = stored;
      // Tip and tip-1 still name the old Flyclient digests. Those two
      // headers must not move the clock until the anchors are replaced.
      if (h >= window.tip - 1) {
        expect(
          ledger.noteVerifiedHeader(header: stored, height: h, hashHex: ''),
          isFalse,
          reason: 'height $h still bound to the old anchor',
        );
      } else {
        expect(ledger.noteVerifiedHeader(header: stored, height: h, hashHex: ''), isTrue);
      }
      prev = got!;
    }
    expect(ledger.verifiedClockTip, 0);
    final newPrev = served[window.tip - 1]!;
    final newTip = served[window.tip]!;
    ledger
      ..noteUnlockAnchor(
        height: window.tip - 1,
        digestHex: _hex(shearHashV3(newPrev)!),
        timeMs: nextMs,
      )
      ..noteUnlockAnchor(
        height: window.tip,
        digestHex: _hex(shearHashV3(newTip)!),
        timeMs: nextMs,
      );
    expect(
      ledger.noteVerifiedHeader(header: newPrev, height: window.tip - 1, hashHex: ''),
      isTrue,
    );
    expect(
      ledger.noteVerifiedHeader(header: newTip, height: window.tip, hashHex: ''),
      isTrue,
    );
    expect(ledger.verifiedClockTip, window.tip);
    expect(ledger.verifiedTimeAtHeight(28), nextMs);
    expect(ledger.verifiedTimeAtHeight(28), isNot(tipMs));
    expect(ledger.verifiedTimeAtHeight(below.height), tipMs);

    final cap = ShearLedger.verifiedHeaderCap;
    ShearLedger.verifiedHeaderCap = 4;
    addTearDown(() => ShearLedger.verifiedHeaderCap = cap);
    final outside = Uint8List(shearHeaderLen);
    outside[0] = 1;
    outside.setRange(4, 36, window.parent);
    _u64(outside, 100, tipMs);
    final outsideQuote = asertNextBits(
      anchorTimeMs: window.genesisMs,
      blockTimeMs: tipMs,
      blockHeight: 18,
      parentTimeMs: tipMs,
    );
    _u32(outside, 108, outsideQuote.packed);
    Uint8List? outsideDigest;
    for (var n = 0; n < 256; n++) {
      shearSetNonce(outside, n);
      final hash = shearHashV3(outside);
      if (hash != null && shearMeetsTarget(hash, outsideQuote.packed)) {
        outsideDigest = hash;
        break;
      }
    }
    expect(outsideDigest, isNotNull);
    ledger.noteUnlockAnchor(height: 17, digestHex: _hex(window.parent));
    expect(ledger.noteVerifiedHeader(header: outside, height: 18, hashHex: ''), isTrue);
    expect(ledger.verifiedTimeAtHeight(18), isNull);
    expect(ledger.verifiedTimeAtHeight(28), nextMs);
  });

  test('a mismatched anchor digest is rejected and the clock stays off', () {
    const tipMs = 1700000002000;
    final window = _mine(tipMs);
    final tip = window.rows.last;
    final prev = window.rows[window.rows.length - 2];
    final ledger = ShearLedger()
      ..noteGenesisPin(window.genesisMs)
      ..noteUnlockAnchor(
        height: window.parentHeight,
        digestHex: _hex(window.parent),
        timeMs: tipMs,
      )
      ..noteUnlockAnchor(
        height: prev.height,
        digestHex: _hex(prev.digest),
        timeMs: tipMs,
      )
      ..noteUnlockAnchor(height: tip.height, digestHex: 'ab' * 32, timeMs: tipMs)
      ..noteAcceptedTip(window.tip);
    for (final row in window.rows) {
      final ok = ledger.noteVerifiedHeader(
        header: row.header,
        height: row.height,
        hashHex: 'ff' * 32,
      );
      expect(ok, row.height == tip.height ? isFalse : isTrue, reason: 'height ${row.height}');
    }
    expect(ledger.verifiedMedianTimeMs, isNull);
    expect(ledger.verifiedClockTip, 0);
    ledger.noteUnlockAnchor(height: tip.height, digestHex: _hex(tip.digest), timeMs: tipMs);
    expect(
      ledger.noteVerifiedHeader(header: tip.header, height: tip.height, hashHex: ''),
      isTrue,
    );
    expect(ledger.verifiedClockTip, window.tip);
    expect(ledger.verifiedMedianTimeMs, tipMs);
  });

  test('a future-dated low-target window is rejected', () {
    const honest = 1700000003000;
    final futureMs = honest + kMtpFutureMs + 1000;
    final window = _mine(futureMs);
    final first = window.rows.first;
    final quote = asertNextBits(
      anchorTimeMs: window.genesisMs,
      blockTimeMs: futureMs,
      blockHeight: first.height,
      parentTimeMs: honest,
    );
    expect(quote.packed, kLiveMinBits * kBitsFpScale);
    expect(quote.easeBits, greaterThan(0));
    expect(
      headerBitsMatchAsert(
        height: first.height,
        bits: quote.packed,
        timestampMs: futureMs,
        parentTimestampMs: honest,
        genesisMs: window.genesisMs,
      ),
      isTrue,
    );
    expect(shearMeetsTarget(first.digest, quote.packed), isTrue);
    final tip = window.rows.last;
    final prev = window.rows[window.rows.length - 2];
    final ledger = ShearLedger()
      ..noteGenesisPin(window.genesisMs)
      ..noteUnlockAnchor(
        height: window.parentHeight,
        digestHex: _hex(window.parent),
        timeMs: honest,
      )
      ..noteUnlockAnchor(
        height: prev.height,
        digestHex: _hex(prev.digest),
        timeMs: futureMs,
      )
      ..noteUnlockAnchor(
        height: tip.height,
        digestHex: _hex(tip.digest),
        timeMs: futureMs,
      )
      ..noteAcceptedTip(window.tip);
    expect(
      ledger.noteVerifiedHeader(header: first.header, height: first.height, hashHex: ''),
      isFalse,
    );
    expect(ledger.verifiedMedianTimeMs, isNull);
    expect(ledger.verifiedClockTip, 0);
  });

  test('deposit matching does not treat a blind id as the tx id', () {
    const older = 1700000000000;
    const newer = older + 1000;
    final notes = <Map<String, dynamic>>[
      {'kind': 'lock', 'txId': 'dep-new', 'id': 'dep-old', 'unlockAtMs': newer},
      {'kind': 'lock', 'id': 'ab' * 32, 'unlockAtMs': older},
      {'kind': 'lock', 'id': 'dep-old', 'unlockAtMs': older},
    ];
    expect(sealedUnlockForTx(notes, 'dep-old'), isNull);
    expect(sealedUnlockForTx(notes, 'dep-new'), newer);
    expect(sealedUnlockForTx(notes, 'ab' * 32), isNull);
    expect(sealedUnlockForTx([
      {'kind': 'lock', 'id': 'only-id', 'unlockAtMs': older},
    ], 'only-id'), older);
  });
}
