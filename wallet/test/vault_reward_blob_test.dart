import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_vault_reward.dart';

/// Fixed buffers. The hex is the JS packer output in crypto/vault_reward_blob.vector.
void main() {
  test('0xab blob matches the JS packer byte for byte', () {
    final word = (int b) => Uint8List(32)..fillRange(0, 32, b);
    final fs1 = Uint8List.fromList([0xf1, ...List<int>.filled(8, 0x11)]);
    final record = Uint8List.fromList([0xf1, ...List<int>.filled(320, 0x22)]);
    final blob = packVaultRewardProof(
      fs1: fs1,
      record: record,
      bps: 281,
      span: 3840,
      epoch: 3,
      reward: 551742209,
      covered: 240,
      nullBase: word(1),
      nullP: word(2),
      nullA1: word(3),
      openR: word(4),
      openZ: word(5),
      noteR: word(6),
      noteZ: word(7),
    );
    final vector = File('../crypto/vault_reward_blob.vector').readAsStringSync().trim();
    expect(blob[0], 0xab);
    expect(blob.length, 595);
    expect(_hex(blob), vector);
  });
}

String _hex(List<int> b) {
  const d = '0123456789abcdef';
  final s = StringBuffer();
  for (final x in b) {
    s
      ..write(d[x >> 4])
      ..write(d[x & 15]);
  }
  return s.toString();
}
