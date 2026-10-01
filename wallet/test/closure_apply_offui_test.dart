import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';
import 'package:shear_wallet/shear_shewall.dart';

void main() {
  test('Apply serializes a burst and keeps the newest path', () async {
    var inflight = 0;
    var maxInflight = 0;
    final side = ShearNodeSidecar(
      nodeBinary: 'node',
      dataDir: '/tmp/shear-node',
      emptyDatadir: true,
      startProcess: (binary, env, args) async {
        inflight += 1;
        if (inflight > maxInflight) maxInflight = inflight;
        await Future<void>.delayed(const Duration(milliseconds: 30));
        inflight -= 1;
      },
    );
    side.select(ClosureSendMode.localNode);
    final first = side.apply();
    side.select(ClosureSendMode.localNodeFull);
    final middle = side.apply();
    side.select(ClosureSendMode.localNode);
    final last = side.apply();
    await Future.wait([first, middle, last]);
    expect(maxInflight, 1);
    expect(side.debugApplyEntered, lessThan(3));
    expect(side.debugApplyCoalesced, greaterThan(0));
    expect(side.committed, ClosureSendMode.localNode);
    expect(side.running, isTrue);
  });

  test('session persist seals off the UI isolate', () async {
    final dir = Directory.systemTemp.createTempSync('shear-persist-offui-');
    final store = File('${dir.path}${Platform.pathSeparator}session.json');
    final session = ShearSession(store: store);
    await session.loadOrCreate();
    final caller = identityHashCode(Isolate.current).toString();
    await session.setPassword('test-pass-1');
    expect(store.existsSync(), isTrue);
    expect(debugSessionPersistStamp, isNotEmpty);
    expect(debugSessionPersistStamp, isNot(caller));
    final again = ShearSession(store: store);
    expect(await again.loadOrCreate(), isNull);
    final id = await again.unlock('test-pass-1');
    expect(id.address.startsWith('shear1'), isTrue);
    expect(debugSessionUnlockStamp, isNotEmpty);
    expect(debugSessionUnlockStamp, isNot(caller));
  });

  test('export argon seals and opens off the UI isolate', () async {
    final caller = identityHashCode(Isolate.current).toString();
    final packed = Uint8List.fromList(const [9, 8, 7, 6, 5]);
    final sealed = await sealShewallBin(packed, 'test-pass-1');
    expect(debugShewallSealStamp, isNotEmpty);
    expect(debugShewallSealStamp, isNot(caller));
    final opened = await openShewallBin(sealed, 'test-pass-1');
    expect(opened, packed);
    expect(debugShewallOpenStamp, isNotEmpty);
    expect(debugShewallOpenStamp, isNot(caller));
  });

  test('sealed note scan hexifies inside the worker', () {
    final raw = <String, dynamic>{
      'vouts': [
        {
          'noteCommit': Uint8List.fromList(List<int>.filled(32, 1)),
          'commit': Uint8List.fromList(List<int>.filled(32, 2)),
        },
      ],
      'dests': <String>[],
      'dest': null,
      'spendSeed': Uint8List(32),
      'seenCommitHex': <String>[],
      'txHints': <Map<String, dynamic>>[],
      'prev': null,
      'startIndex': 0,
    };
    final out = scanSealedWire(raw);
    expect(out['notes'], isA<List>());
    expect(out['hashFolds'], isA<List>());
  });
}
