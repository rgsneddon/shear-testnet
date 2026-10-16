import 'dart:math' as math;

/// Genesis-anchored aserti3-2d. Same rule as `asertNextBits` in crypto/asert.js.
/// Higher bits are harder. The anchor is the genesis seed, not the parent bits.
const kTargetBlockIntervalMs = 90000;
const kLiveMinBits = 4;
const kMaxBits = 256;
const kGenesisBits = 17;
const kBitsFpScale = 65536;
const kGenesisBitsPacked = kGenesisBits * kBitsFpScale;
const kAsertHalflifeMs = 2 * 60 * 60 * 1000;
const kAsertEmergencyEaseMax = 2;
const kAsertEmergencyGapFactor = 8;

class AsertQuote {
  const AsertQuote({
    required this.ok,
    this.packed = 0,
    this.eased = 0,
    this.easeBits = 0,
  });

  final bool ok;
  final int packed;
  final int eased;
  final double easeBits;
}

int packBits(double bitsFp) {
  if (!bitsFp.isFinite) return kGenesisBitsPacked;
  final fp = bitsFp.clamp(kLiveMinBits.toDouble(), kMaxBits.toDouble());
  return (fp * kBitsFpScale).round();
}

double unpackBits(int packed) {
  if (packed <= 0) return kGenesisBits.toDouble();
  if (packed <= kMaxBits) {
    return packed.toDouble().clamp(kLiveMinBits.toDouble(), kMaxBits.toDouble());
  }
  if (packed < kBitsFpScale) return kMaxBits.toDouble();
  return (packed / kBitsFpScale).clamp(kLiveMinBits.toDouble(), kMaxBits.toDouble());
}

bool isPackedBits(int bits) => bits >= kBitsFpScale;

int clampBits(int bits) {
  if (bits <= 0) return kGenesisBitsPacked;
  if (bits <= kMaxBits) {
    return packBits(math.max(kLiveMinBits, math.min(kMaxBits, bits)).toDouble());
  }
  if (bits < kBitsFpScale) return packBits(kMaxBits.toDouble());
  return packBits(unpackBits(bits));
}

int _divRoundNearest(BigInt numer, BigInt denom) {
  final neg = numer < BigInt.zero;
  final abs = neg ? -numer : numer;
  final q = (abs + (denom ~/ BigInt.two)) ~/ denom;
  final signed = neg ? -q : q;
  return signed.toInt();
}

/// [parentTimeMs] null skips the own-timestamp emergency ease, matching asert.js.
AsertQuote asertNextBits({
  int anchorBits = kGenesisBitsPacked,
  required int anchorTimeMs,
  int anchorHeight = 1,
  required int blockTimeMs,
  required int blockHeight,
  int? parentTimeMs,
}) {
  if (blockHeight <= anchorHeight) return const AsertQuote(ok: false);
  final heightDelta = BigInt.from(blockHeight - anchorHeight);
  final timeDelta = BigInt.from(blockTimeMs - anchorTimeMs);
  final numer = heightDelta * BigInt.from(kTargetBlockIntervalMs) - timeDelta;
  final deltaQ = _divRoundNearest(
    numer * BigInt.from(kBitsFpScale),
    BigInt.from(kAsertHalflifeMs),
  );
  final minQ = kLiveMinBits * kBitsFpScale;
  final maxQ = kMaxBits * kBitsFpScale;
  var nextQ = clampBits(anchorBits) + deltaQ;
  if (nextQ < minQ) nextQ = minQ;
  if (nextQ > maxQ) nextQ = maxQ;
  var easeBits = 0.0;
  var eased = nextQ;
  if (parentTimeMs != null) {
    final gap = blockTimeMs - parentTimeMs;
    final trigger = kAsertEmergencyGapFactor * kTargetBlockIntervalMs;
    if (gap > trigger) {
      final raw = math.log(gap / trigger) / math.ln2;
      easeBits = math.min(kAsertEmergencyEaseMax.toDouble(), math.max(0, raw));
      var easedQ = nextQ - (easeBits * kBitsFpScale).round();
      if (easedQ < minQ) easedQ = minQ;
      eased = easedQ;
    }
  }
  return AsertQuote(ok: true, packed: nextQ, eased: eased, easeBits: easeBits);
}

bool bitsAcceptAsert(int gotPacked, AsertQuote quote) {
  if (!quote.ok) return false;
  if (quote.easeBits > 0) {
    return gotPacked <= quote.packed && gotPacked >= quote.eased;
  }
  return gotPacked == quote.packed;
}

/// Header `bits` must be the genesis seed at height 1, and the genesis-anchored
/// ASERT quote above that. A server-chosen easy target does not pass.
bool headerBitsMatchAsert({
  required int height,
  required int bits,
  required int timestampMs,
  int? parentTimestampMs,
  required int genesisMs,
}) {
  if (!isPackedBits(bits) || timestampMs <= 0) return false;
  if (height <= 1) return height == 1 && bits == kGenesisBitsPacked;
  if (genesisMs <= 0) return false;
  final quote = asertNextBits(
    anchorBits: kGenesisBitsPacked,
    anchorTimeMs: genesisMs,
    anchorHeight: 1,
    blockTimeMs: timestampMs,
    blockHeight: height,
    parentTimeMs: parentTimestampMs,
  );
  if (!quote.ok || !bitsAcceptAsert(bits, quote)) return false;
  final fp = unpackBits(bits);
  return fp >= kLiveMinBits && fp <= kMaxBits;
}
