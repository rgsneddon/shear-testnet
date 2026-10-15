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
const kLevyCapRho = 100000000;

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

const int _kSigHexLen = 128;
const int _kSpendPubHexLen = 64;

Map<String, dynamic> _weightCopy(Map<String, dynamic> source) {
  final draft = <String, dynamic>{};
  source.forEach((key, value) {
    if (key == 'fee' || key == 'maxLevy' || key == 'sig' || key == 'spendPub') return;
    draft[key] = value;
  });
  return draft;
}

void _attachFee(Map<String, dynamic> draft, int fee, {required bool maxLevy}) {
  draft['fee'] = fee;
  if (maxLevy) draft['maxLevy'] = fee;
  draft['sig'] = '0' * _kSigHexLen;
  draft['spendPub'] = '0' * _kSpendPubHexLen;
}

/// One-pass weight fee, then raised until it still covers the body after the
/// signature is attached. The fee never moves down. Any body size.
/// A body whose levy is above [kLevyCapRho] returns the cap; [weightFeeCovers] is then false.
int bindStableWeightFee(Map<String, dynamic> source, {bool maxLevy = false}) {
  final draft = _weightCopy(source);
  var fee = levyFromWeight(flowWeight(draft));
  if (fee > kLevyCapRho) fee = kLevyCapRho;
  _attachFee(draft, fee, maxLevy: maxLevy);
  for (var step = 0; step < 8; step++) {
    final need = levyFromWeight(flowWeight(draft));
    if (need <= fee) return fee;
    if (need > kLevyCapRho) return fee;
    fee = need;
    draft['fee'] = fee;
    if (maxLevy) draft['maxLevy'] = fee;
  }
  return fee;
}

/// True when [fee] is inside the cap and covers the signed body. Does not write [source].
bool weightFeeCovers(int fee, Map<String, dynamic> source, {bool maxLevy = false}) {
  if (fee < 0 || fee > kLevyCapRho) return false;
  final draft = _weightCopy(source);
  _attachFee(draft, fee, maxLevy: maxLevy);
  final need = levyFromWeight(flowWeight(draft));
  return fee >= need;
}

/// Fee for a reward claim. The same choice a send posts in `fee`.
/// Null is the weight floor of [body], or the levy floor when there is no body.
/// A higher [fee] is the mempool bid. Under the floor or over the cap is `levy`.
int rewardClaimFee({int? fee, Map<String, dynamic>? body}) {
  if (body == null) {
    final floor = levyNanos(0);
    if (fee == null) return floor;
    if (fee < floor || fee > kLevyCapRho) throw StateError('levy');
    return fee;
  }
  final source = Map<String, dynamic>.from(body);
  if (fee == null) return bindStableWeightFee(source);
  if (!weightFeeCovers(fee, source)) throw StateError('levy');
  return fee;
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
    'reward-claim',
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
