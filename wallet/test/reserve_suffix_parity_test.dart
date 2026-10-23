// Shared vector: crypto/vectors/reserve_suffix_pi.json.
// JS reserveDigestSuffix and Reserve.lockReserveSuffix check the same bytes.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_pack.dart';

Uint8List _unhex(String hex) {
  final out = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Map<String, dynamic> _vector() {
  for (final p in ['../crypto/vectors/reserve_suffix_pi.json', 'crypto/vectors/reserve_suffix_pi.json']) {
    final f = File(p);
    if (f.existsSync()) return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  }
  throw StateError('reserve_suffix_pi.json not found');
}

void main() {
  final vec = _vector();

  test('a lock suffix binds sha256(piProof) the same way the node does', () {
    final commit = _unhex(vec['commit'] as String);
    final proof = _unhex(vec['piProof'] as String);
    final got = reserveDigestSuffixBytes(
      kind: 'lock',
      portalId: vec['portalId'] as String,
      payoutPortalId: '',
      programId: vec['programId'] as String,
      choice: '',
      suffixNanos: 0,
      commit: commit,
      vout: [
        {'kind': 'lock'},
      ],
      oneTimePub: vec['ownerPub'] as String,
      piProof: proof,
    );
    expect(_hex(got), vec['suffix']);
    final empty = reserveDigestSuffixBytes(
      kind: 'lock',
      portalId: vec['portalId'] as String,
      payoutPortalId: '',
      programId: vec['programId'] as String,
      choice: '',
      suffixNanos: 0,
      commit: commit,
      vout: [
        {'kind': 'lock'},
      ],
      oneTimePub: vec['ownerPub'] as String,
    );
    expect(_hex(empty), vec['emptySuffix']);
    expect(_hex(empty), isNot(vec['suffix']));
  });

  test('a vote suffix does not grow a pi-proof word', () {
    final commit = _unhex(vec['commit'] as String);
    Uint8List vote({Uint8List? piProof}) => reserveDigestSuffixBytes(
          kind: 'vote',
          portalId: vec['portalId'] as String,
          payoutPortalId: '',
          programId: vec['programId'] as String,
          choice: 'hold',
          suffixNanos: 0,
          commit: commit,
          vout: [
            {'kind': 'vote'},
          ],
          piProof: piProof,
        );
    expect(_hex(vote()), _hex(vote(piProof: _unhex(vec['piProof'] as String))));
  });
}
