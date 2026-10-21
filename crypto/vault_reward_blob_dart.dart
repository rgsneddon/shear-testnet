import 'dart:io';
import 'dart:typed_data';

import '../wallet/lib/shear_vault_blob.dart';

/// Packs the same fixed fields the JS test packs and checks the shared vector.
void main() {
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
    noteR: word(6),
    noteZ: word(7),
  );
  final vector = File('crypto/vault_reward_blob.vector').readAsStringSync().trim();
  final hex = blob.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  if (blob.length != 531 || blob[0] != 0xab || hex != vector) {
    stderr.writeln('dart blob diverges from JS (${blob.length} bytes)');
    exit(1);
  }
  stdout.writeln('dart blob matches JS');
}
