import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ledger.dart';

/// Secret wire keys. `R` on a value proof is public and is not in this set.
const _forbidden = <String>{
  't',
  'r',
  'opening',
  'seed',
  'spendSeed',
  'rngSeed',
  'x',
  'blind',
  'alpha',
  'gamma',
};

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

/// Bytes that actually sit in the posted tree, with a separator so a run
/// cannot form across two public fields.
List<int> _postedBytes(dynamic node) {
  final out = <int>[];
  void walk(dynamic n) {
    if (n is Uint8List) {
      out.addAll(n);
      out.add(-1);
      return;
    }
    if (n is String) {
      final hex = _tryHex(n);
      if (hex != null) {
        out.addAll(hex);
        out.add(-1);
      }
      return;
    }
    if (n is List) {
      for (final item in n) {
        walk(item);
      }
      return;
    }
    if (n is Map) {
      for (final value in n.values) {
        walk(value);
      }
    }
  }

  walk(node);
  return out;
}

Uint8List? _tryHex(String s) {
  if (s.length < 16 || s.length.isOdd) return null;
  final out = Uint8List(s.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    final h = int.tryParse(s.substring(i * 2, i * 2 + 2), radix: 16);
    if (h == null) return null;
    out[i] = h;
  }
  return out;
}

bool _hasRun(List<int> hay, int b) {
  var run = 0;
  for (final x in hay) {
    run = x == b ? run + 1 : 0;
    if (run >= 8) return true;
  }
  return false;
}

void main() {
  test('posted body has no secret key or secret bytes for 1, 2, 4 and 8 inputs', () {
    for (final n in <int>[1, 2, 4, 8]) {
      final blinds = <Uint8List>[];
      final openings = <Uint8List>[];
      final seeds = <Uint8List>[];
      final proofs = <Map<String, dynamic>>[];
      final vin = <Map<String, dynamic>>[];
      final secretBytes = <int>{};
      for (var i = 0; i < n; i++) {
        final blind = _fill(32, 0x10 + i);
        final opening = _fill(32, 0x40 + i);
        final leaked = _fill(32, 0x70 + i);
        final seed = _fill(32, 0x80 + i);
        final blindName = _fill(32, 0xA1);
        final alpha = _fill(32, 0xA2);
        final gamma = _fill(32, 0xA3);
        final unknownX = _fill(32, 0xA4);
        final rng = _fill(32, 0xA5);
        for (final b in <int>[0x10 + i, 0x40 + i, 0x70 + i, 0x80 + i, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x22]) {
          secretBytes.add(b);
        }
        blinds.add(blind);
        openings.add(opening);
        seeds.add(seed);
        proofs.add(<String, dynamic>{
          'v': 3,
          'version': 3,
          'spendTag': _fill(32, i + 1),
          'blob': _fill(8, i + 1),
          'cTilde': _fill(32, 0xc0 + i),
          'c0': _fill(32, 0x01),
          'admit_proof': <String, dynamic>{
            'anchor': _fill(32, 0x02),
            'blind': blindName,
            'alpha': alpha,
            'gamma': gamma,
            'nested': <String, dynamic>{'t': _fill(32, 0x10 + i), 'seed': seed},
          },
          'members': <Map<String, dynamic>>[
            <String, dynamic>{
              'commit': _fill(32, 0x04),
              'r': opening,
              'opening': leaked,
              'blind': blindName,
              'alpha': alpha,
              'gamma': gamma,
            },
          ],
          't': blind,
          'r': opening,
          'opening': leaked,
          'seed': seed,
          'spendSeed': seed,
          'rngSeed': rng,
          'x': unknownX,
          'blind': blindName,
          'alpha': alpha,
          'gamma': gamma,
        });
        vin.add(<String, dynamic>{
          'commit': _fill(32, 0xb0 + i),
          'r': opening,
          't': blind,
          'noteCommit': _fill(32, 0x06),
          'prev': _fill(32, 0x07),
          'blind': blindName,
        });
      }
      final shared = seeds.first;
      final sharedBefore = Uint8List.fromList(shared);
      final vout = <Map<String, dynamic>>[
        <String, dynamic>{
          'kind': 'pot',
          'commit': _fill(32, 0x09),
          'noteCommit': _fill(32, 0x08),
          'r': _fill(32, 0x22),
          'valueProof': <String, dynamic>{
            'R': _fill(32, 0x52),
            'z': _fill(32, 0x53),
            'v': 1,
            'seed': shared,
            'blind': _fill(32, 0xA1),
            'alpha': _fill(32, 0xA2),
            'gamma': _fill(32, 0xA3),
          },
          'nested': <String, dynamic>{'opening': openings.first, 'gamma': _fill(32, 0xA3)},
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
        final bytes = _postedBytes(tree);
        for (final b in secretBytes) {
          expect(_hasRun(bytes, b), isFalse, reason: 'n=$n secret 0x${b.toRadixString(16)}');
        }
      }
      expect(seen.contains('R'), isTrue, reason: 'n=$n public R');
      expect(seen.contains('commit'), isTrue, reason: 'n=$n');
      expect(seen.contains('spendTag'), isTrue, reason: 'n=$n');
      expect((body['admit_proofs'] as List).length, n, reason: 'n=$n');
      expect((body['vin'] as List).length, n, reason: 'n=$n');
      expect(shared, sharedBefore, reason: 'n=$n shared spendSeed');
      for (var i = 0; i < n; i++) {
        expect(blinds[i], everyElement(0x10 + i), reason: 'n=$n blind left intact');
        expect(openings[i], everyElement(0x40 + i), reason: 'n=$n opening left intact');
        expect(seeds[i], everyElement(0x80 + i), reason: 'n=$n seed left intact');
      }
    }
  });

  test('a shared spendSeed survives the scrubber and the worker wipes only its t', () {
    final seed = _fill(32, 0x81);
    final before = Uint8List.fromList(seed);
    final blind = _fill(32, 0x11);
    final posted = postedAdmitProof(<String, dynamic>{
      'spendTag': _fill(32, 0x03),
      'spendSeed': seed,
      'seed': seed,
      'opening': seed,
      'x': seed,
      't': blind,
      'blind': _fill(32, 0xA1),
      'alpha': _fill(32, 0xA2),
      'gamma': _fill(32, 0xA3),
    });
    expect(seed, before);
    expect(posted.containsKey('spendSeed'), isFalse);
    expect(posted.containsKey('t'), isFalse);
    expect(posted.containsKey('blind'), isFalse);
    expect(posted['spendTag'], everyElement(0x03));

    final ownT = _fill(32, 0x11);
    final worker = workerAdmitProof(<String, dynamic>{
      'spendSeed': seed,
      't': ownT,
      'spendTag': _fill(32, 0x03),
      'admit_proof': <String, dynamic>{'t': ownT, 'blob': _fill(4, 0x02)},
    });
    expect(seed, before);
    expect(ownT, everyElement(0));
    expect(worker.containsKey('t'), isFalse);
    expect((worker['admit_proof'] as Map).containsKey('t'), isFalse);
    expect(worker['spendSeed'], same(seed));

    final aliased = workerAdmitProof(<String, dynamic>{
      'spendSeed': seed,
      't': seed,
      'v': 1,
    });
    expect(seed, before);
    expect(aliased.containsKey('t'), isFalse);
    expect(aliased['spendSeed'], same(seed));
  });
}
