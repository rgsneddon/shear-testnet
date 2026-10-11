import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:shear_wallet/shear_ed25519.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_native_prove.dart';
import 'package:shear_wallet/shear_pack.dart';

/// Production hops. Run with `dart run test/t18_off_ui_check.dart`.
/// flutter test injects FLUTTER_TEST. SHEAR_FLOW_OFF_UI=1 still takes the
/// isolate hop. Without that flag, FLUTTER_TEST is the caller shortcut.

Future<void> main() async {
  final forceOff = Platform.environment['SHEAR_FLOW_OFF_UI'] == '1';
  if (Platform.environment['FLUTTER_TEST'] == 'true' && !forceOff) {
    throw StateError('FLUTTER_TEST is set; this is the caller shortcut');
  }
  if (debugNativeSealNote != null || debugNativeSpendProver != null) {
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

  // An empty output list still runs sealFlowSpendVouts on the worker.
  // A dummy output calls proveRange, which did not return on this host
  // inside two minutes, so this check does not time that body.
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

  Object? proveErr;
  try {
    await proveFlowOffUi(<String, dynamic>{
      'vin': <Map<String, dynamic>>[
        {'commit': Uint8List(32), 'r': Uint8List(32)},
      ],
      'vout': <Map<String, dynamic>>[],
      'spendSeed': Uint8List(32)..[0] = 9,
      'spentNote': <String, dynamic>{
        'kind': 'pot',
        'commit': Uint8List(32)..[0] = 1,
        'noteCommit': Uint8List(32)..[0] = 2,
        'r': Uint8List(32)..[0] = 3,
      },
      'pubs': <Uint8List>[Uint8List(32)..[0] = 4],
      'commits': <Uint8List>[Uint8List(32)..[0] = 5],
    }).timeout(const Duration(seconds: 30));
    throw StateError('prove accepted a pub that is not the note');
  } on StateError catch (e) {
    proveErr = e.message;
    if (e.message != 'not_in_fluxset' && e.message != 'admit_native_required') rethrow;
  }
  if (debugSendProveStamp.isEmpty || debugSendProveStamp == ui) {
    throw StateError('prove stamp $debugSendProveStamp ui $ui err $proveErr');
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
    'sealErr=$sealErr proveErr=$proveErr',
  );
}

bool _same(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
