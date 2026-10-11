import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_identity.dart';

const kLevyFloorUnits = 100;
/// Amount is not the price. Matches `LEVY_BPS` in `crypto/levy.js`.
const kLevyBps = 0;
const kLevyWeightRateDen = 2048;
const kSurgeMax = 3.0;
const kSurgeRef = 2048;
const kChainId = 2701;
/// Hard ceiling: 0.001 SHE. The pool rejects a paid fee above this.
/// [levyFromWeight] does not apply it. The ceiling is not the price.
const kLevyCapNanos = 100000000;

/// JSON byte length. Same one-pass input as `flowWeight` in `crypto/levy.js`.
int flowWeight(Object? tx) {
  try {
    return utf8.encode(jsonEncode(tx ?? <String, dynamic>{})).length;
  } catch (_) {
    return 0;
  }
}

/// max(floor, ceil(weight / 2048)). Any byte length. No amount. No cap.
int levyFromWeight(int weight) {
  final w = weight < 0 ? 0 : weight;
  final raw = (w + kLevyWeightRateDen - 1) ~/ kLevyWeightRateDen;
  return raw < kLevyFloorUnits ? kLevyFloorUnits : raw;
}

int levyBase(int amountNanos) {
  amountNanos;
  return kLevyFloorUnits;
}

double levySurge(int depth) {
  final d = depth < 0 ? 0 : depth;
  final s = d / kSurgeRef;
  if (s <= 0) return 0;
  if (s >= kSurgeMax) return kSurgeMax;
  return s;
}

/// Consensus weight levy. [amountNanos] and [depth] are ignored.
/// A [weight] or a [tx] body quotes [levyFromWeight]. Otherwise the floor.
int levyNanos(int amountNanos, {int depth = 0, int? weight, Map<String, dynamic>? tx}) {
  if (weight != null) return levyFromWeight(weight);
  if (tx != null) return levyFromWeight(flowWeight(tx));
  if (amountNanos < 0 || depth < 0) return kLevyFloorUnits;
  return kLevyFloorUnits;
}

String _bodyKind(Map<String, dynamic> tx) {
  final named = tx['kind']?.toString();
  if (named != null && named.isNotEmpty) return named;
  final vout = tx['vout'];
  if (vout is List && vout.isNotEmpty && vout.first is Map) {
    final k = (vout.first as Map)['kind']?.toString();
    if (k != null && k.isNotEmpty) return k;
  }
  return 'send';
}

/// Set `fee` from the body's current JSON length. One pass: the new fee is
/// not stringified again. Untaxed kinds are left unchanged.
Map<String, dynamic> bindWeightFee(Map<String, dynamic> tx) {
  if (!levyTaxed(_bodyKind(tx))) return tx;
  final l = levyFromWeight(flowWeight(tx));
  tx['fee'] = l;
  if (tx.containsKey('maxLevy') && tx['maxLevy'] != null) tx['maxLevy'] = l;
  return tx;
}

/// The reserved fee already sealed into outputs covers the one-pass weight
/// fee of [posted]. Does not write a smaller fee back onto [posted].
bool sealedFeeCovers(int reserved, Map<String, dynamic> posted) {
  if (reserved < 0) return false;
  final copy = <String, dynamic>{};
  posted.forEach((key, value) {
    copy[key] = value;
  });
  copy['fee'] = reserved;
  copy['maxLevy'] = reserved;
  bindWeightFee(copy);
  final bound = copy['fee'];
  return bound is int && reserved >= bound;
}

bool levyTaxed(String kind, {bool coinbase = false}) {
  if (coinbase) return false;
  const untaxed = {
    'claim',
    'withdraw',
    'hash',
    'pot',
    'reserve',
    'reserve-interest',
    'reserve-shortfall',
  };
  if (untaxed.contains(kind)) return false;
  const taxed = {
    'send',
    'evm-value',
    'pool-withdraw',
    'vortice-register',
    'transfer',
    'user-spend',
    'lock',
    'vote',
  };
  return taxed.contains(kind);
}

/// Canonical pool admin fee dest (ssa1). Same hash as JS `poolFeeDest()`.
/// On-chain payouts cannot target raw she1.
const kPoolFeeDest = 'ssa1q4ke8sdxgma3sstuf6h0lsqh08w0e8qqkf7mfv6';

String poolFeeDest() {
  final d = sha256.convert(utf8.encode('shear-pool-fee-v1'));
  return encodeDestAddress(Uint8List.fromList(d.bytes.sublist(0, 20)));
}
