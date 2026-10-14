import 'dart:math';

/// Whole blocks in one Q-epoch. Spec: docs/wallet-auto-send-delay.md.
const int kAutoSendEpochBlocks = 8;

/// Bytes out of 256 that select a delay of 0, 1, … whole Q-epochs.
/// Spec: docs/wallet-auto-send-delay.md `weights`.
const List<int> kAutoSendDelayWeights = [4, 12, 28, 52, 68, 52, 28, 12];

/// Sealed-tip epoch. `floor(S / Q)` for `S >= 0`.
int autoSendEpoch(int sealedTip) {
  if (sealedTip < 0) throw ArgumentError('sealedTip');
  return sealedTip ~/ kAutoSendEpochBlocks;
}

/// Delay in whole Q-epochs for one CSPRNG byte `0..255`.
int autoSendDelayEpochs(int byte) {
  if (byte < 0 || byte > 255) throw ArgumentError('byte');
  var acc = 0;
  for (var i = 0; i < kAutoSendDelayWeights.length; i++) {
    acc += kAutoSendDelayWeights[i];
    if (byte < acc) return i;
  }
  throw StateError('auto_send_weights');
}

/// One draw, kept until the automatic broadcast is accepted.
class AutoSendHold {
  const AutoSendHold({
    required this.epochBase,
    required this.epochs,
    required this.releaseEpoch,
  });

  final int epochBase;
  final int epochs;
  final int releaseEpoch;

  bool ready(int sealedTip) => autoSendEpoch(sealedTip) >= releaseEpoch;

  Map<String, dynamic> toJson() => {
        'v': 1,
        'epochBase': epochBase,
        'epochs': epochs,
        'releaseEpoch': releaseEpoch,
      };

  static AutoSendHold draw({required int sealedTip, required int byte}) {
    final base = autoSendEpoch(sealedTip);
    final k = autoSendDelayEpochs(byte);
    return AutoSendHold(epochBase: base, epochs: k, releaseEpoch: base + k);
  }

  static AutoSendHold? tryParse(Object? raw) {
    if (raw is! Map) return null;
    if ((raw['v'] as num?)?.toInt() != 1) return null;
    final base = (raw['epochBase'] as num?)?.toInt();
    final epochs = (raw['epochs'] as num?)?.toInt();
    final release = (raw['releaseEpoch'] as num?)?.toInt();
    if (base == null || epochs == null || release == null) return null;
    if (base < 0 || epochs < 0 || epochs >= kAutoSendDelayWeights.length) return null;
    if (release != base + epochs) return null;
    return AutoSendHold(epochBase: base, epochs: epochs, releaseEpoch: release);
  }
}

/// One OS CSPRNG byte. Failure is `rng_unavailable` and draws nothing.
int autoSendCsprngByte() {
  try {
    final b = Random.secure().nextInt(256);
    if (b < 0 || b > 255) throw StateError('rng_unavailable');
    return b;
  } catch (e) {
    if (e is StateError && e.message == 'rng_unavailable') rethrow;
    throw StateError('rng_unavailable');
  }
}
