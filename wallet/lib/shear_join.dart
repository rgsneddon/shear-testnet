import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_identity.dart';
import 'shear_ledger.dart';

const kJoinProgram = 'shear-join-v1';
const kJoinKindGenesis = 'join-genesis';
const kJoinWindowDays = 99;
const kJoinWindowMs = kJoinWindowDays * 86400000;
const kPriorUnitsPerCoin = 100000000000;
const kPriorToShearUnits = 1;
const kJoinLeafPersonal = 'shear-join-leaf-v1';
const kJoinWindowClosed =
    'The ninety-nine day window is closed. Unclaimed allocation has been burned.';

/// Mint a single-leaf `join1.` key from a prior-ledger wallet owner + coins.
/// Same leaf as the node snapshot (`shear-join-leaf-v1`). Empty proof: root is the leaf.
String mintJoinKey({required String owner, required double coins}) {
  final amountPrior = (coins * kPriorUnitsPerCoin).round();
  if (owner.isEmpty || amountPrior <= 0) return '';
  final commit = sha256
      .convert(utf8.encode(kJoinLeafPersonal) + utf8.encode(owner) + utf8.encode('$amountPrior'))
      .toString();
  final body = jsonEncode({
    'v': 1,
    'owner': owner,
    'amountPrior': amountPrior,
    'commit': commit,
    'index': 0,
    'proof': [],
  });
  return 'join1.${base64Url.encode(utf8.encode(body)).replaceAll('=', '')}';
}

class JoinClaim {
  const JoinClaim({
    required this.owner,
    required this.amountPrior,
    required this.commit,
    required this.index,
    required this.proof,
  });
  final String owner;
  final int amountPrior;
  final String commit;
  final int index;
  final List<Map<String, String>> proof;
  int get shearNanos => amountPrior * kPriorToShearUnits;
  double get she => shearNanos / kUnitsPerShe;
}

class ShearJoin {
  int genesisMs = 0;
  String root = '';
  int circulatingNanos = 0;
  int remainingNanos = 0;
  bool burned = false;
  final Map<String, int> claimed = {};

  int remainingMs(int nowMs) {
    if (genesisMs == 0) return kJoinWindowMs;
    final left = genesisMs + kJoinWindowMs - nowMs;
    return left < 0 ? 0 : left;
  }

  bool windowOpen(int nowMs) => genesisMs != 0 && !burned && remainingMs(nowMs) > 0;

  void fundGenesis({required int nanos, required int nowMs, required String snapshotRoot}) {
    if (genesisMs != 0) return;
    if (nanos <= 0) return;
    genesisMs = nowMs;
    root = snapshotRoot;
    circulatingNanos = nanos;
    remainingNanos = nanos;
    burned = false;
  }

  JoinClaim? decodeKey(String raw) {
    final s = raw.trim();
    const prefix = 'join1.';
    if (!s.startsWith(prefix)) return null;
    try {
      final body = jsonDecode(utf8.decode(base64Url.decode(_pad(s.substring(prefix.length)))));
      if (body is! Map) return null;
      final owner = body['owner']?.toString() ?? '';
      final amountPrior = (body['amountPrior'] as num?)?.toInt() ?? 0;
      final commit = body['commit']?.toString() ?? '';
      final index = (body['index'] as num?)?.toInt() ?? 0;
      final proofRaw = body['proof'];
      final proof = <Map<String, String>>[];
      if (proofRaw is List) {
        for (final p in proofRaw) {
          if (p is Map) {
            proof.add({
              'side': p['side']?.toString() ?? 'R',
              'hash': p['hash']?.toString() ?? '',
            });
          }
        }
      }
      if (owner.isEmpty || amountPrior <= 0 || commit.isEmpty) return null;
      final want = sha256.convert(utf8.encode(kJoinLeafPersonal) + utf8.encode(owner) + utf8.encode('$amountPrior')).toString();
      if (want != commit) return null;
      return JoinClaim(
        owner: owner,
        amountPrior: amountPrior,
        commit: commit,
        index: index,
        proof: proof,
      );
    } catch (_) {
      return null;
    }
  }

  String? claim({required String key, required String payout, required int nowMs}) {
    if (!isDestAddress(payout) || isShearAddress(payout)) return 'bad_dest';
    if (!windowOpen(nowMs)) return 'window_closed';
    final parsed = decodeKey(key);
    if (parsed == null) return 'bad_key';
    if (!_merkleOk(parsed)) return 'bad_proof';
    if (claimed.containsKey(parsed.commit)) return 'already_claimed';
    final nanos = parsed.shearNanos;
    if (nanos <= 0 || nanos > remainingNanos) return 'empty';
    claimed[parsed.commit] = nanos;
    remainingNanos -= nanos;
    return null;
  }

  Map<String, int>? claimTo(
    ShearLedger ledger, {
    required String key,
    required String payout,
    required int nowMs,
  }) {
    final parsed = decodeKey(key);
    final err = claim(key: key, payout: payout, nowMs: nowMs);
    if (err != null || parsed == null) return null;
    ledger.creditJoin(to: payout, amount: parsed.she);
    return {'nanos': parsed.shearNanos};
  }

  void applyRemote(Map<String, dynamic> json) {
    genesisMs = (json['genesisMs'] as num?)?.toInt() ?? genesisMs;
    remainingNanos = (json['remainingNanos'] as num?)?.toInt() ?? remainingNanos;
    circulatingNanos = (json['circulatingNanos'] as num?)?.toInt() ?? circulatingNanos;
    burned = json['burned'] == true;
    final r = json['root']?.toString();
    if (r != null && r.isNotEmpty) root = r;
  }

  /// Pool/node Join VAULT claim. Verifies `join1.` against the snapshot.
  Future<Map<String, int>?> claimViaPool(
    ShearLedger ledger, {
    required ShearPoolClient pool,
    required String key,
    required String payout,
  }) async {
    final parsed = decodeKey(key);
    if (parsed == null) return null;
    try {
      final json = await pool.joinClaim(key: key, payout: payout);
      if (json['ok'] != true) return null;
      final she = (json['she'] as num?)?.toDouble() ?? parsed.she;
      if (she <= 0) return null;
      ledger.creditJoin(to: payout, amount: she);
      applyRemote(json);
      claimed[parsed.commit] = parsed.shearNanos;
      remainingNanos = (json['remainingNanos'] as num?)?.toInt() ?? remainingNanos;
      return {'nanos': ((she * kUnitsPerShe).round())};
    } catch (_) {
      return null;
    }
  }

  void burnUnclaimed(int nowMs) {
    if (genesisMs == 0 || remainingMs(nowMs) > 0) return;
    remainingNanos = 0;
    burned = true;
  }

  Map<String, Object?> publicView(int nowMs) => {
        'programId': kJoinProgram,
        'genesisMs': genesisMs,
        'remainingMs': remainingMs(nowMs),
        'circulatingNanos': circulatingNanos,
        'remainingNanos': remainingNanos,
        'claimedCount': claimed.length,
        'burned': burned,
        'root': root,
      };

  bool _merkleOk(JoinClaim parsed) {
    if (root.isEmpty) return false;
    final start = _hex(parsed.commit);
    if (start == null) return false;
    var acc = start;
    for (final step in parsed.proof) {
      final sib = _hex(step['hash'] ?? '');
      if (sib == null) return false;
      final left = step['side'] == 'L';
      final cat = left
          ? Uint8List.fromList([...sib, ...acc])
          : Uint8List.fromList([...acc, ...sib]);
      acc = Uint8List.fromList(sha256.convert(cat).bytes);
    }
    final want = _hex(root);
    if (want == null || acc.length != want.length) return false;
    for (var i = 0; i < acc.length; i++) {
      if (acc[i] != want[i]) return false;
    }
    return true;
  }

  Uint8List? _hex(String s) {
    final h = s.trim().toLowerCase();
    if (h.length != 64 || h.contains(RegExp(r'[^0-9a-f]'))) return null;
    final out = Uint8List(32);
    for (var i = 0; i < 32; i++) {
      out[i] = int.parse(h.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }
}

String _pad(String b64) {
  final m = b64.length % 4;
  if (m == 0) return b64;
  return b64 + '=' * (4 - m);
}
