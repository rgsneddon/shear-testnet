import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_ed25519.dart';
import 'package:shear_wallet/shear_fs1.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_native_prove.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_pack.dart';

/// Production hops. Run with `dart run test/t18_off_ui_check.dart`.
/// flutter test injects FLUTTER_TEST. SHEAR_FLOW_OFF_UI=1 still takes the
/// isolate hop. Without that flag, FLUTTER_TEST is the caller shortcut.

Future<void> main() async {
  final forceOff = Platform.environment['SHEAR_FLOW_OFF_UI'] == '1';
  if (Platform.environment['FLUTTER_TEST'] == 'true' && !forceOff) {
    throw StateError('FLUTTER_TEST is set; this is the caller shortcut');
  }
  if (debugNativeSealNote != null) {
    throw StateError('debug prover hooks are set');
  }
  if (sealFlowOnCaller || debugFlowCryptoOnCaller) {
    throw StateError('caller crypto flag is set');
  }
  final ui = identityHashCode(Isolate.current).toString();
  final heavyBefore = debugUiHeavyCount;
  final id = createIdentity();
  final ledger = ShearLedger()..bindIdentity(id);
  for (final memo in [false, true]) {
    for (final amount in [1e-6, 1.0, 1000.0]) {
      await ledger.quoteSendLevyUnits(
        restFrame: id.address,
        paymentCode: id.paymentCode,
        amount: amount,
        memo: memo,
      );
      if (debugSendSelectStamp.isEmpty || debugSendSelectStamp == ui) {
        throw StateError('select stamp $debugSendSelectStamp ui $ui memo $memo amount $amount');
      }
    }
  }

  // Exact nanos above 2^53. The SHE double is not the amount. The selector
  // must put that digit string in the batch, off this isolate.
  const above = '9007199254740993';
  final dest = ledger.currentDest(id.address, paymentCode: id.paymentCode);
  // A coin the selector may spend has a sealed commit, a note commit, and
  // an opening, a value proof that opened (verified), and a block height
  // with 9 confirmations at a checked tip (gate 3). Without any one of those
  // it stays out of the pay set.
  ledger.noteNodeCheckedTip(ShearLedger.spendableConfirmations);
  ledger.rememberNote(<String, dynamic>{
    'address': dest,
    'dest': dest,
    'nanos': above,
    'commit': Uint8List(32)..[0] = 11,
    'noteCommit': Uint8List(32)..[0] = 21,
    'r': Uint8List(32)..[0] = 31,
    'verified': true,
    'height': 1,
  });
  ledger.rememberNote(<String, dynamic>{
    'address': dest,
    'dest': dest,
    'nanos': '100000000000',
    'commit': Uint8List(32)..[1] = 12,
    'noteCommit': Uint8List(32)..[1] = 22,
    'r': Uint8List(32)..[1] = 32,
    'verified': true,
    'height': 1,
  });
  await ledger.quoteSendLevyUnits(
    restFrame: id.address,
    paymentCode: id.paymentCode,
    amount: 1,
    nanosWire: above,
  );
  if (!debugSendSelectNanos.contains(above)) {
    throw StateError('select nanos $debugSendSelectNanos want $above dest $dest');
  }
  if (debugSendSelectStamp.isEmpty || debugSendSelectStamp == ui) {
    throw StateError('exact select stamp $debugSendSelectStamp ui $ui');
  }

  // An empty output list still runs sealFlowSpendVouts on the worker.
  Object? sealErr;
  final sealed = await sealFlowOffUi(<String, dynamic>{
    'spendSeed': Uint8List(32)..[0] = 3,
    'destTo': '',
    'src': '',
    'vouts': <Map<String, dynamic>>[],
  }).timeout(const Duration(seconds: 20));
  final vouts = sealed['vouts'];
  if (vouts is! List || vouts.isNotEmpty) {
    throw StateError('empty seal returned $vouts');
  }
  if (debugSendSealStamp.isEmpty || debugSendSealStamp == ui) {
    throw StateError('seal stamp $debugSendSealStamp ui $ui err $sealErr');
  }

  // One real output. The range blob is the node proof, checked against the
  // commitment. Amounts cross 2^53. Each seal is capped.
  final rangeMs = <int>[];
  final sealedSends = <Map<String, dynamic>>[];
  for (final nanos in <int>[0, 1, 1000, 9007199254740993]) {
    final sw = Stopwatch()..start();
    // A send to an empty address is a short ssa1 and is refused before the
    // range proof. Seal to this wallet's own dest, the change path.
    final one = await sealFlowOffUi(<String, dynamic>{
      'spendSeed': Uint8List(32)..[0] = 4,
      'destTo': '',
      'src': dest,
      'vouts': <Map<String, dynamic>>[
        {
          'kind': nanos == 0 ? 'dummy' : 'send',
          'nanos': nanos,
          'address': nanos == 0 ? '' : dest,
        },
      ],
    }).timeout(const Duration(seconds: 30));
    final outs = one['vouts'];
    if (outs is! List || outs.length != 1) {
      throw StateError('range outs nanos=$nanos $outs');
    }
    final note = Map<String, dynamic>.from(outs.single as Map);
    final proof = note['rangeProof'];
    final commit = note['commit'];
    if (proof is! Uint8List || proof.length < 2 || proof[0] != 2) {
      throw StateError('range blob nanos=$nanos');
    }
    if (commit is! Uint8List || commit.length != 32) {
      throw StateError('range commit nanos=$nanos');
    }
    if (note['nanos'] != nanos) throw StateError('range nanos field $nanos');
    if (debugSendSealStamp.isEmpty || debugSendSealStamp == ui) {
      throw StateError('range stamp $debugSendSealStamp ui $ui nanos=$nanos');
    }
    await _rangeOpens(commit, proof, nanos);
    if (nanos != 0) sealedSends.add(note);
    rangeMs.add(sw.elapsedMilliseconds);
  }

  Object? proveErr;
  try {
    final stranger = sealCoinbaseNote(5, dest20: Uint8List(20), kind: 'pot');
    await proveFlowOffUi(<String, dynamic>{
      'notes': Uint8List(64)
        ..[0] = 4
        ..setRange(32, 64, stranger['commit'] as Uint8List),
      'indices': <int>[0],
      'spent': <Map<String, dynamic>>[
        {'kind': 'pot', 'commit': stranger['commit'], 'noteCommit': stranger['noteCommit'], 'r': stranger['r']},
      ],
      'spendSeed': Uint8List(32)..[0] = 9,
      'vout': <Map<String, dynamic>>[],
      'digest': Uint8List(32),
      'anchor': 8,
      'tree': const Fs1TreeState().toWire(),
    }).timeout(const Duration(seconds: 30));
    throw StateError('prove accepted a pub that is not the note');
  } on StateError catch (e) {
    proveErr = e.message;
    if (e.message != 'fs1_not_owner') rethrow;
  }
  if (debugSendProveStamp.isEmpty || debugSendProveStamp == ui) {
    throw StateError('prove stamp $debugSendProveStamp ui $ui err $proveErr');
  }

  // Every sealed note joins the admit set as an FS-1 leaf. One owned note
  // among them proves off the caller isolate.
  final flowSeed = Uint8List(32)..[0] = 4;
  final owned = attachAdmitPub(sealCoinbaseNote(1000, dest20: Uint8List(20)..[0] = 1, kind: 'pot'), spendSeed: flowSeed);
  final book = <Map<String, dynamic>>[...sealedSends, owned];
  final notes = Uint8List(64 * book.length);
  for (var i = 0; i < book.length; i++) {
    final pub = book[i]['admitPub'];
    final commit = book[i]['commit'];
    if (pub is! Uint8List || pub.length != 32 || commit is! Uint8List || commit.length != 32) {
      throw StateError('admit pub nanos=${book[i]['nanos']}');
    }
    if (!noteIsFs1Leaf(pub, commit)) throw StateError('not a leaf nanos=${book[i]['nanos']}');
    notes.setRange(64 * i, 64 * i + 32, pub);
    notes.setRange(64 * i + 32, 64 * (i + 1), commit);
  }
  final proveWatch = Stopwatch()..start();
  final proved = await proveFlowOffUi(<String, dynamic>{
    'notes': notes,
    'indices': <int>[book.length - 1],
    'spent': <Map<String, dynamic>>[
      {'kind': 'pot', 'commit': owned['commit'], 'noteCommit': owned['noteCommit'], 'r': owned['r']},
    ],
    'spendSeed': flowSeed,
    'vout': <Map<String, dynamic>>[],
    'digest': Uint8List(32),
    'anchor': 8,
    'tree': const Fs1TreeState().toWire(),
  }).timeout(const Duration(minutes: 2));
  final closed = proveWatch.elapsedMilliseconds;
  final blob = proved['fs1'];
  if (blob is! Uint8List || blob.isEmpty || blob[0] != kFs1Wire) throw StateError('fs1 blob');
  if (proved.containsKey('t')) throw StateError('blind left the worker');
  if (debugSendProveStamp.isEmpty || debugSendProveStamp == ui) {
    throw StateError('spend stamp $debugSendProveStamp ui $ui');
  }

  final seed = Uint8List(32)..[0] = 7;
  for (final n in [0, 1, 32, 64]) {
    final msg = Uint8List(n);
    for (var i = 0; i < n; i++) {
      msg[i] = (i + 1) & 0xff;
    }
    final signed = await signSpendOffUi(<String, dynamic>{
      'spendSeed': seed,
      'message': msg,
    });
    final sig = signed['sig'];
    final pub = signed['pub'];
    if (sig is! Uint8List || pub is! Uint8List) throw StateError('sign bytes');
    if (!ed25519Verify(pub, msg, sig)) throw StateError('sign verify len $n');
    if (debugSendSignStamp.isEmpty || debugSendSignStamp == ui) {
      throw StateError('sign stamp $debugSendSignStamp ui $ui len $n');
    }
  }
  final packed = spendMessage(
    from: id.address,
    vout: const <Map<String, dynamic>>[],
    kind: 'send',
    vin: const <Map<String, dynamic>>[],
  );
  final packedSig = await signSpendOffUi(<String, dynamic>{
    'spendSeed': seed,
    'message': packed,
  });
  final packedBytes = packedSig['sig'];
  final packedPub = packedSig['pub'];
  if (packedBytes is! Uint8List || packedPub is! Uint8List) throw StateError('packed sign');
  if (!ed25519Verify(packedPub, packed, packedBytes)) throw StateError('packed verify');
  if (debugSendSignStamp == ui) throw StateError('packed sign on caller');

  final shared = Uint8List(32)..[31] = 11;
  final stealth = await signSpendOffUi(<String, dynamic>{
    'spendSeed': seed,
    'message': packed,
    'shared': shared,
  });
  final stealthSig = stealth['sig'];
  if (stealthSig is! Uint8List || stealthSig.length != 64) throw StateError('stealth len');
  if (_same(stealthSig, packedBytes)) throw StateError('stealth matched plain');
  if (debugSendSignStamp.isEmpty || debugSendSignStamp == ui) {
    throw StateError('stealth stamp $debugSendSignStamp');
  }
  if (debugUiHeavyCount != heavyBefore) {
    throw StateError('ui heavy ${debugUiHeavyCount - heavyBefore}');
  }
  stdout.writeln(
    'T18_OFF_UI pass select=$debugSendSelectStamp seal=$debugSendSealStamp '
    'prove=$debugSendProveStamp sign=$debugSendSignStamp ui=$ui '
    'sealErr=$sealErr proveErr=$proveErr rangeMs=${rangeMs.join(',')} '
    'proveMs=$closed '
    'selectNanos=${debugSendSelectNanos.join(',')}',
  );
}

Future<void> _rangeOpens(Uint8List commit, Uint8List proof, int nanos) async {
  final script = File('test/t18_range_verify.mjs');
  if (!script.existsSync()) {
    throw StateError('missing ${script.absolute.path}');
  }
  final tmp = File(
    '${Directory.systemTemp.path}/t18-range-${DateTime.now().microsecondsSinceEpoch}.json',
  );
  tmp.writeAsStringSync(
    '{"commit":"${_hex(commit)}","proof":"${_hex(proof)}"}',
    flush: true,
  );
  try {
    final result = await Process.run(
      'node',
      [script.absolute.path, tmp.absolute.path],
    );
    final out = result.stdout.toString();
    final err = result.stderr.toString();
    if (result.exitCode != 0 || !out.contains('ok')) {
      throw StateError(
        'range verify nanos=$nanos exit=${result.exitCode} out=$out err=$err',
      );
    }
  } finally {
    if (tmp.existsSync()) tmp.deleteSync();
  }
}

String _hex(Uint8List b) =>
    b.map((e) => e.toRadixString(16).padLeft(2, '0')).join();

bool _same(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
