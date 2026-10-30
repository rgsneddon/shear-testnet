// STAND-IN (agent-box, not phone): the same production walk below a
// checkpoint, in a worker isolate, over the mined regtest chain, while this
// isolate measures its own event-loop latency (a 4 ms timer's lateness).
// Not part of the wallet suite (it lives in tool/). Run:
//   SHEAR_WALK_CHAIN=/path/chain.bin [SHEAR_WALK_HEADERS=n] \
//     flutter test tool/walk_stand_in_test.dart
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_hash.dart';
import 'package:shear_wallet/shear_hash_v3.dart' as v3;
import 'package:shear_wallet/shear_ledger.dart';

Future<Map<String, dynamic>> _walkInWorker(Map<String, dynamic> input) =>
    Isolate.run(() => walkBelowCheckpointWorker(input));

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

void main() {
  test('STAND-IN walk: per-header time and event-loop latency', () async {
    final path = Platform.environment['SHEAR_WALK_CHAIN'];
    expect(path, isNotNull, reason: 'set SHEAR_WALK_CHAIN to the mined chain');
    final all = File(path!).readAsBytesSync();
    var n = all.length ~/ 128;
    final want = int.tryParse(Platform.environment['SHEAR_WALK_HEADERS'] ?? '');
    if (want != null && want < n) n = want;
    final chain = Uint8List.sublistView(all, 0, n * 128);
    int ts(int h) {
      var v = 0;
      for (var i = 7; i >= 0; i--) {
        v = (v << 8) | chain[(h - 1) * 128 + 100 + i];
      }
      return v;
    }

    final last = Uint8List.sublistView(chain, (n - 1) * 128, n * 128);
    final pinHash = shearHashV3(Uint8List.fromList(last))!;
    // Native and Dart give byte-identical digests on these real headers.
    for (final h in [1, n ~/ 2, n]) {
      final hdr = Uint8List.fromList(chain.sublist((h - 1) * 128, h * 128));
      expect(_hex(v3.shearHashV3(hdr)!), _hex(shearHashV3(hdr)!), reason: 'height $h');
    }
    final pin = {
      'network': 'regtest-walk-frames',
      'height': n,
      'hashHex': _hex(pinHash),
      'timeMs': ts(n),
      'bits': chain[(n - 1) * 128 + 108] |
          (chain[(n - 1) * 128 + 109] << 8) |
          (chain[(n - 1) * 128 + 110] << 16) |
          (chain[(n - 1) * 128 + 111] << 24),
      'anchorHeight': 1,
      'anchorTimeMs': ts(1),
      'anchorBits': 17 * 65536,
      'priorTimesMs': [for (var i = 0; i < 10; i++) ts(n - 10 + i)],
    };
    final late = <int>[];
    var last4 = DateTime.now().microsecondsSinceEpoch;
    final timer = Timer.periodic(const Duration(milliseconds: 4), (_) {
      final now = DateTime.now().microsecondsSinceEpoch;
      late.add(now - last4 - 4000);
      last4 = now;
    });
    final progress = ReceivePort();
    var messages = 0;
    progress.listen((_) => messages++);
    final result = await _walkInWorker({
      'headers': Uint8List.fromList(chain),
      'pin': pin,
      'progress': progress.sendPort,
    });
    timer.cancel();
    progress.close();
    expect(result['ok'], isTrue);
    late.sort();
    final worst = late.isEmpty ? 0 : late.last / 1000;
    final p99 = late.isEmpty ? 0 : late[((late.length - 1) * 0.99).round()] / 1000;
    final ms = result['ms'] as int;
    // ignore: avoid_print
    print('SHEAR_WALK_STAND_IN ${jsonEncode({
      'label': 'STAND-IN (agent-box, not phone)',
      'backend': result['backend'],
      'headers': n,
      'walk_ms': ms,
      'per_header_ms': (ms / n).toStringAsFixed(1),
      'progress_messages': messages,
      'loop_late_worst_ms': worst,
      'loop_late_p99_ms': p99,
      'loop_samples': late.length,
    })}');
    // A refused link: one header changed below the pin is not accepted.
    final bent = Uint8List.fromList(chain);
    bent[(n - 3) * 128 + 100] ^= 1; // height n - 2
    final refused = await _walkInWorker({'headers': bent, 'pin': pin, 'progress': null});
    expect(refused['ok'], isFalse);
  }, timeout: const Timeout(Duration(hours: 2)));
}
