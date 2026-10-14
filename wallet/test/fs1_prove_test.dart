// In-process FS-1 prove through libshear_admit (debug candidate
// ../crypto/native/admit/target/release). Skipped when the library is not built.
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_fs1.dart';
import 'package:shear_wallet/shear_identity.dart' show kBookMagic;
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_ristretto.dart';

Map<String, dynamic> _pot(int v, int i, Uint8List seed) {
  final note = sealCoinbaseNote(v, dest20: Uint8List(20)..fillRange(0, 20, i + 1), kind: 'pot');
  return attachAdmitPub(note, spendSeed: seed);
}

void main() {
  final lib = Fs1Native.tryLoad();

  test('two owned notes prove, verify, and balance against the kernel excess', () {
    final seed = Uint8List(32)..fillRange(0, 32, 9);
    final other = Uint8List(32)..fillRange(0, 32, 4);
    final book = <Map<String, dynamic>>[
      for (var i = 0; i < 10; i++) _pot(5000 + i, i, i == 2 || i == 7 ? seed : other),
    ];
    final pubs = [for (final n in book) n['admitPub'] as Uint8List];
    final commits = [for (final n in book) n['commit'] as Uint8List];
    const fee = 100;
    final total = 5002 + 5007;
    final out = sealCoinbaseNote(total - fee, dest20: Uint8List(20)..fillRange(0, 20, 0x33), kind: 'send');
    final vout = [out];
    final digest = fs1BodyDigest(magic: kBookMagic, kind: 'send', anchor: 8, fee: fee, nIn: 2, vout: vout);
    final spent = [
      for (final i in [2, 7])
        {'kind': 'pot', 'commit': book[i]['commit'], 'noteCommit': book[i]['noteCommit'], 'r': book[i]['r']},
    ];
    final proved = proveFs1SpendWire({
      'notes': fs1NotesBytes(pubs, commits, 10),
      'indices': [2, 7],
      'spent': spent,
      'spendSeed': seed,
      'vout': vout,
      'digest': digest,
      'anchor': 8,
      'tree': const Fs1TreeState().toWire(),
    });
    final records = [for (final r in (proved['records'] as List)) r as Uint8List];
    final fs1 = proved['fs1'] as Uint8List;
    expect(records.length, 2);
    expect(fs1[0], kFs1Wire);
    expect(fs1.length, lib!.blobCap(2));
    final tree = Fs1TreeState.fromWire(proved['tree']);
    expect(tree.len, 10);
    final root = lib.treeRoot(tree.handle)!;
    expect(fs1.sublist(3, 35), root);
    expect(lib.verify(fs1, records, root, digest, 8), isTrue);
    expect(lib.verify(fs1, records, root, digest, 16), isFalse);
    expect(lib.verify(fs1, records.reversed.toList(), root, digest, 8), isFalse);

    // Σ C_out + fee·G − Σ C̃ = excess·H.
    final proofs = [for (final r in records) fs1PostedProof(r)];
    var lhs = addEl(pointFrom(out['commit'] as Uint8List), mulG(scalarFromInt(fee)));
    for (final p in proofs) {
      lhs = subEl(lhs, pointFrom(p['cTilde'] as Uint8List));
    }
    final rhs = mulEl(noteH, scalarFromBytes(proved['excess'] as Uint8List));
    expect(elementEq(lhs, rhs), isTrue);

    // A longer admit set keeps the tree prefix and appends.
    final more = [...book, _pot(77, 11, other), _pot(78, 12, other)];
    final again = proveFs1SpendWire({
      'notes': fs1NotesBytes([for (final n in more) n['admitPub'] as Uint8List], [for (final n in more) n['commit'] as Uint8List], 12),
      'indices': [2],
      'spent': [spent.first],
      'spendSeed': seed,
      'vout': vout,
      'digest': digest,
      'anchor': 16,
      'tree': tree.toWire(),
    });
    final next = Fs1TreeState.fromWire(again['tree']);
    expect(next.handle, tree.handle);
    expect(next.len, 12);

    expect(
      () => proveFs1SpendWire({
        'notes': fs1NotesBytes(pubs, commits, 10),
        'indices': [3],
        'spent': [
          {'kind': 'pot', 'commit': book[3]['commit'], 'noteCommit': book[3]['noteCommit'], 'r': book[3]['r']},
        ],
        'spendSeed': seed,
        'vout': vout,
        'digest': digest,
        'anchor': 8,
        'tree': next.toWire(),
      }),
      throwsA(isA<StateError>().having((e) => e.message, 'msg', 'fs1_not_owner')),
    );
    lib.treeFree(next.handle);
  }, skip: lib == null ? 'libshear_admit with shear_fs1_* is not built' : false);
}
