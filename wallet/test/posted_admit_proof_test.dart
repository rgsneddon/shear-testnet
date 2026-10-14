import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ledger.dart';

/// Secret wire keys. `R` on a value proof is public and is not in this set.
const _forbidden = <String>{'t', 'r', 'opening', 'seed', 'spendSeed', 'rngSeed', 'x'};

void _walk(dynamic node, void Function(String key) onKey) {
  if (node is Map) {
    for (final entry in node.entries) {
      onKey(entry.key.toString());
      _walk(entry.value, onKey);
    }
    return;
  }
  if (node is List) {
    for (final item in node) {
      _walk(item, onKey);
    }
  }
}

Uint8List _fill(int n, int b) => Uint8List.fromList(List<int>.filled(n, b));

void main() {
  test('posted body has no secret key for 1, 2, 4 and 8 inputs', () {
    for (final n in <int>[1, 2, 4, 8]) {
      final blinds = <Uint8List>[];
      final openings = <Uint8List>[];
      final seeds = <Uint8List>[];
      final proofs = <Map<String, dynamic>>[];
      final vin = <Map<String, dynamic>>[];
      for (var i = 0; i < n; i++) {
        final blind = _fill(32, 0x10 + i);
        final opening = _fill(32, 0x40 + i);
        final leaked = _fill(32, 0x70 + i);
        final seed = _fill(32, 0x80 + i);
        blinds.add(blind);
        openings.add(opening);
        seeds.add(seed);
        proofs.add(<String, dynamic>{
          'v': 3,
          'version': 3,
          'spendTag': _fill(32, i),
          'blob': _fill(8, i),
          'cTilde': _fill(32, 0xc0 + i),
          'c0': _fill(32, 1),
          'admit_proof': <String, dynamic>{
            'anchor': _fill(32, 2),
            'nested': <String, dynamic>{'t': _fill(32, 3), 'seed': seed},
          },
          'members': <Map<String, dynamic>>[
            <String, dynamic>{'commit': _fill(32, 4), 'r': opening, 'opening': leaked},
          ],
          't': blind,
          'r': opening,
          'opening': leaked,
          'seed': seed,
          'spendSeed': seed,
          'x': _fill(32, 5),
        });
        vin.add(<String, dynamic>{
          'commit': _fill(32, 0xa0 + i),
          'r': opening,
          't': blind,
          'noteCommit': _fill(32, 6),
          'prev': _fill(32, 7),
        });
      }
      final vout = <Map<String, dynamic>>[
        <String, dynamic>{
          'kind': 'pot',
          'commit': _fill(32, 9),
          'noteCommit': _fill(32, 8),
          'r': _fill(32, 0x22),
          'valueProof': <String, dynamic>{
            'R': _fill(32, 0x52),
            'z': _fill(32, 0x53),
            'v': 1,
            'seed': seeds.first,
          },
          'nested': <String, dynamic>{'opening': openings.first},
        },
      ];
      final posted = postedFlowBody(vin: vin, vout: vout, proofs: proofs);
      final wire = flowPostHex(<String, dynamic>{
        'vin': vin,
        'vout': vout,
        'admitProof': proofs.first,
        'admitProofs': proofs,
      });
      final body = <String, dynamic>{
        'vin': wire['vin'],
        'vout': wire['vout'],
        'admit_proof': wire['admitProof'],
        'admit_proofs': wire['admitProofs'],
      };
      final seen = <String>{};
      for (final tree in <dynamic>[posted, wire, body]) {
        _walk(tree, (key) {
          seen.add(key);
          expect(_forbidden.contains(key), isFalse, reason: 'n=$n key=$key');
        });
      }
      expect(seen.contains('R'), isTrue, reason: 'n=$n public R');
      expect(seen.contains('commit'), isTrue, reason: 'n=$n');
      expect(seen.contains('spendTag'), isTrue, reason: 'n=$n');
      expect((body['admit_proofs'] as List).length, n, reason: 'n=$n');
      expect((body['vin'] as List).length, n, reason: 'n=$n');
      for (final blind in blinds) {
        expect(blind, everyElement(0), reason: 'n=$n blind wiped');
      }
      for (final opening in openings) {
        expect(opening[0], isNot(0), reason: 'n=$n opening left intact');
      }
    }
  });
}
