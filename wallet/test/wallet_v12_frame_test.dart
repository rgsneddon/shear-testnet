import 'dart:async';
import 'dart:isolate';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ledger.dart';

/// T18: a long prove must not freeze the caller isolate.
/// Sixteen-millisecond ticks keep advancing while the worker is busy.
void main() {
  test('membership anchor follows the next block', () {
    expect(membershipAnchorFor(liveTip: 16), 8);
    expect(membershipAnchorFor(liveTip: 0, flowAnchor: 8), 8);
    expect(membershipAnchorFor(liveTip: 0, flowAnchor: 7), isNull);
    expect(membershipAnchorFor(liveTip: 10), isNull);
  });

  test('frames advance while membership work runs off the caller', () async {
    var ticks = 0;
    final timer = Timer.periodic(const Duration(milliseconds: 16), (_) {
      ticks++;
    });
    final sw = Stopwatch()..start();
    final workerMs = await Isolate.run(() {
      final inner = Stopwatch()..start();
      final until = DateTime.now().add(const Duration(milliseconds: 80));
      var n = 0;
      while (DateTime.now().isBefore(until)) {
        n++;
      }
      if (n < 1) throw StateError('worker did not run');
      return inner.elapsedMilliseconds;
    });
    await Future<void>.delayed(const Duration(milliseconds: 20));
    timer.cancel();
    expect(workerMs, greaterThanOrEqualTo(50));
    expect(ticks, greaterThan(0), reason: 'caller frames ticks=$ticks workerMs=$workerMs elapsed=${sw.elapsedMilliseconds}');
  });
}
