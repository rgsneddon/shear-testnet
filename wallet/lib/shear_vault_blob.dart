import 'dart:typed_data';

/// Claim blob version. The JS packer writes the same byte.
const int kVaultBlobVer = 0xab;

/// Version, FS-1, record, then bps, epoch-block span, period, reward,
/// covered blocks, and five 32-byte words. A1 and zGap live only in the
/// gap tail. The unlock integer is not a field.
Uint8List packVaultRewardProof({
  required Uint8List fs1,
  required Uint8List record,
  required int bps,
  required int span,
  required int epoch,
  required int reward,
  required int covered,
  required Uint8List nullBase,
  required Uint8List nullP,
  required Uint8List nullA1,
  required Uint8List noteR,
  required Uint8List noteZ,
}) {
  return _concat([
    Uint8List.fromList([kVaultBlobVer]),
    _u32(fs1.length),
    fs1,
    record,
    _u32(bps),
    _u64(span),
    _u64(epoch),
    _u64(reward),
    _u64(covered),
    nullBase,
    nullP,
    nullA1,
    noteR,
    noteZ,
  ]);
}

Uint8List _u32(int n) {
  final b = Uint8List(4);
  ByteData.sublistView(b).setUint32(0, n, Endian.little);
  return b;
}

Uint8List _u64(int n) {
  final b = Uint8List(8);
  var x = n < 0 ? 0 : n;
  for (var i = 0; i < 8; i++) {
    b[i] = x & 0xff;
    x >>= 8;
  }
  return b;
}

Uint8List _concat(List<Uint8List> parts) {
  final out = BytesBuilder();
  for (final p in parts) {
    out.add(p);
  }
  return out.toBytes();
}
