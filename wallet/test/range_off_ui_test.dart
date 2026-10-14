import 'dart:async';
import 'dart:isolate';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit_ffi.dart';

/// Spawned from the test. Calls the isolate guard only, not the native prover.
void rangeOffUiWorker(List<Object> args) {
  final n = args[0] as int;
  final send = args[1] as SendPort;
  try {
    for (var i = 0; i < n; i++) {
      requireRangeOffUi(enforce: true);
    }
    send.send(n);
  } catch (e) {
    send.send('err:$e');
  }
}

void main() {
  testWidgets('UI isolate throws and 1, 2, 4, 8 proofs stay in the worker', (tester) async {
    expect(rangeOnUiIsolate(), isTrue);
    expect(
      () => requireRangeOffUi(enforce: true),
      throwsA(isA<StateError>().having((e) => e.toString(), 'toString', contains('range_on_ui_isolate'))),
    );

    final spreads = <int>[];
    for (final n in <int>[1, 2, 4, 8]) {
      final result = await tester.runAsync(() async {
        final port = ReceivePort();
        Object? msg;
        port.listen((event) {
          msg = event;
        });
        final gaps = <int>[];
        final clock = Stopwatch()..start();
        var last = clock.elapsedMicroseconds;
        await Isolate.spawn(rangeOffUiWorker, <Object>[n, port.sendPort]);
        var frames = 0;
        while (frames < 4 || msg == null) {
          await Future<void>.delayed(const Duration(milliseconds: 16));
          final now = clock.elapsedMicroseconds;
          gaps.add(now - last);
          last = now;
          frames++;
          if (frames > 40) break;
        }
        port.close();
        return <Object?>[msg, gaps];
      });
      final msg = result![0];
      final gaps = (result[1] as List).cast<int>();
      expect(msg, n, reason: 'n=$n gaps=$gaps');
      expect(gaps.length, greaterThan(1), reason: 'n=$n');
      final minGap = gaps.reduce((a, b) => a < b ? a : b);
      final maxGap = gaps.reduce((a, b) => a > b ? a : b);
      final spread = maxGap - minGap;
      spreads.add(spread);
      expect(spread, inInclusiveRange(0, 250000), reason: 'n=$n spread ${spread}us gaps=$gaps');
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(spreads, hasLength(4));
  }, timeout: const Timeout(Duration(seconds: 20)));
}
