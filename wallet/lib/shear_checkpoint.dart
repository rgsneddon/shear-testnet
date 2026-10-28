/// PLACEHOLDER until the v12 testnet cut fills [kReleaseCheckpoint].
/// A release build shows the checkpoint-missing screen while this is true.
/// Tests install a fixture.
const bool kCheckpointIsPlaceholder = true;

/// v12 genesis header time in milliseconds. 0 until the cut publishes it.
/// [releaseCheckpointReady] stays false while this is 0.
const int kV12GenesisMs = 0;

/// Consensus ASERT anchor height. chain.js headerLinkReason uses 1.
const int kConsensusAnchorHeight = 1;

/// GENESIS_BITS_PACKED. 17 bits in Q16.16. chain.js anchor for a non-genesis parent.
const int kConsensusAnchorBits = 17 * 65536;

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
/// The ASERT anchor is consensus: height 1 and [kConsensusAnchorBits].
bool checkpointPinWellFormed(CheckpointPin pin) {
  if (pin.network.isEmpty || pin.height < 11) return false;
  if (!_hex32(pin.hashHex)) return false;
  if (pin.timeMs <= 0 || pin.bits < 65536) return false;
  final pinBits = pin.bits / 65536;
  if (pinBits < 4 || pinBits > 256) return false;
  if (pin.anchorHeight != kConsensusAnchorHeight) return false;
  if (pin.anchorTimeMs <= 0 || pin.anchorBits != kConsensusAnchorBits) return false;
  if (pin.priorTimesMs.length != 10) return false;
  var prev = 0;
  for (final t in pin.priorTimesMs) {
    if (t <= prev) return false;
    prev = t;
  }
  if (pin.priorTimesMs.last >= pin.timeMs) return false;
  return true;
}

/// True when [pin] may ship: not a placeholder, well formed, and its anchor
/// time is the published v12 genesis millisecond.
bool releaseCheckpointReady([CheckpointPin? pin]) {
  final got = pin ?? kReleaseCheckpoint;
  if (kCheckpointIsPlaceholder || !checkpointPinWellFormed(got)) return false;
  if (kV12GenesisMs <= 0 || got.anchorTimeMs != kV12GenesisMs) return false;
  return true;
}

/// Throws when the shipped pin is missing or malformed. Release CI calls this.
void requireReleaseCheckpoint([CheckpointPin? pin]) {
  if (!releaseCheckpointReady(pin)) throw StateError('checkpoint_pin');
}

/// Release startup. Debug and tests keep the normal shell.
/// A product build with no pin shows [CheckpointMissingApp] instead of throwing.
bool releaseCheckpointMissing() {
  if (!const bool.fromEnvironment('dart.vm.product')) return false;
  return !releaseCheckpointReady();
}

/// A pin handed to the credit worker, which checks the same chain from it.
Map<String, Object> checkpointPinToJson(CheckpointPin pin) => {
      'network': pin.network,
      'height': pin.height,
      'hashHex': pin.hashHex,
      'timeMs': pin.timeMs,
      'bits': pin.bits,
      'anchorHeight': pin.anchorHeight,
      'anchorTimeMs': pin.anchorTimeMs,
      'anchorBits': pin.anchorBits,
      'priorTimesMs': List<int>.from(pin.priorTimesMs),
    };

/// Null unless every field is there and the pin is well formed.
CheckpointPin? checkpointPinFromJson(Map<String, dynamic> j) {
  try {
    final pin = CheckpointPin(
      network: j['network'] as String,
      height: (j['height'] as num).toInt(),
      hashHex: j['hashHex'] as String,
      timeMs: (j['timeMs'] as num).toInt(),
      bits: (j['bits'] as num).toInt(),
      anchorHeight: (j['anchorHeight'] as num).toInt(),
      anchorTimeMs: (j['anchorTimeMs'] as num).toInt(),
      anchorBits: (j['anchorBits'] as num).toInt(),
      priorTimesMs: [for (final t in j['priorTimesMs'] as List) (t as num).toInt()],
    );
    return checkpointPinWellFormed(pin) ? pin : null;
  } catch (_) {
    return null;
  }
}
