import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';

Uint8List hexToBytes(String hex) {
  final out = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

void main() {
  test('n1_leaf.txt agrees with noteIsFs1Leaf', () {
    final repo = Directory.current.path.replaceAll('\\', '/').endsWith('/wallet')
        ? Directory.current.parent.path
        : Directory.current.path;
    final file = File(
      '$repo/crypto/native/vendor/monero-oxide-77788c3/shear-fs1/vectors/n1_leaf.txt',
    );
    final lines = file
        .readAsLinesSync()
        .where((line) => line.isNotEmpty && !line.startsWith('#'))
        .toList();
    expect(lines.length, greaterThanOrEqualTo(12));
    for (final line in lines) {
      final cols = line.split('\t');
      expect(cols.length, 4, reason: line);
      final want = cols[3] != 'skip';
      expect(
        noteIsFs1Leaf(hexToBytes(cols[1]), hexToBytes(cols[2])),
        want,
        reason: cols[0],
      );
    }
  });
}
