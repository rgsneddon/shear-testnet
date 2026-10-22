/// PLACEHOLDER until the v12 testnet cut fills [kReleaseCheckpoint].
/// A release build refuses to start while this is true. Tests install a fixture.
const bool kCheckpointIsPlaceholder = true;

/// Shipped pin. Empty on purpose until the cut. [requireReleaseCheckpoint]
/// rejects it. Do not put a host header here.
const CheckpointPin kReleaseCheckpoint = CheckpointPin(
  network: 'testnet-v12',
  height: 0,
  hashHex: '',
  timeMs: 0,
  bits: 0,
  anchorHeight: 0,
  anchorTimeMs: 0,
  anchorBits: 0,
  priorTimesMs: <int>[],
);

/// One release checkpoint. The hash is the block id. The anchor is the ASERT
/// state the next header is checked against. [priorTimesMs] is the ten header
/// times before this block, oldest first, so median-time-past has 11 samples.
class CheckpointPin {
  const CheckpointPin({
    required this.network,
    required this.height,
    required this.hashHex,
    required this.timeMs,
    required this.bits,
    required this.anchorHeight,
    required this.anchorTimeMs,
    required this.anchorBits,
    required this.priorTimesMs,
  });

  final String network;
  final int height;
  final String hashHex;
  final int timeMs;
  final int bits;
  final int anchorHeight;
  final int anchorTimeMs;
  final int anchorBits;
  final List<int> priorTimesMs;
}

bool _hex32(String hex) {
  if (hex.length != 64) return false;
  for (var i = 0; i < hex.length; i++) {
    final c = hex.codeUnitAt(i);
    final digit = c >= 48 && c <= 57;
    final lower = c >= 97 && c <= 102;
    final upper = c >= 65 && c <= 70;
    if (!digit && !lower && !upper) return false;
  }
  return true;
}

/// A pin a release can ship. The placeholder fails this.
bool checkpointPinWellFormed(CheckpointPin pin) {
  if (pin.network.isEmpty || pin.height < 11) return false;
  if (!_hex32(pin.hashHex)) return false;
  if (pin.timeMs <= 0 || pin.bits < 65536) return false;
  if (pin.anchorHeight < 1 || pin.anchorHeight > pin.height) return false;
  if (pin.anchorTimeMs <= 0 || pin.anchorBits < 65536) return false;
  if (pin.priorTimesMs.length != 10) return false;
  var prev = 0;
  for (final t in pin.priorTimesMs) {
    if (t <= prev) return false;
    prev = t;
  }
  if (pin.priorTimesMs.last >= pin.timeMs) return false;
  return true;
}

/// Throws when the shipped pin is missing or malformed. Release and CI call this.
void requireReleaseCheckpoint([CheckpointPin? pin]) {
  final got = pin ?? kReleaseCheckpoint;
  if (kCheckpointIsPlaceholder || !checkpointPinWellFormed(got)) {
    throw StateError('checkpoint_pin');
  }
}

/// Release startup. Debug and tests keep running on the placeholder.
void guardReleaseCheckpoint() {
  if (!const bool.fromEnvironment('dart.vm.product')) return;
  requireReleaseCheckpoint();
}
