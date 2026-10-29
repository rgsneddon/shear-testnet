// FS-1 external signer split through libshear_admit (ruling D1, 29 Oct).
// Skipped when the library is not built or predates the exports.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/ledger_hw/ledger_fs1.dart';
import 'package:shear_wallet/ledger_hw/ledger_transport.dart' show bytesOf, hexOf;
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_fs1.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_ristretto.dart';

Map<String, dynamic> _pot(int v, int i, Uint8List seed) {
  final note = sealCoinbaseNote(v, dest20: Uint8List(20)..fillRange(0, 20, i + 1), kind: 'pot');
  return attachAdmitPub(note, spendSeed: seed);
}

bool _contains(Uint8List hay, Uint8List needle) {
  for (var i = 0; i + needle.length <= hay.length; i++) {
    var ok = true;
    for (var k = 0; k < needle.length && ok; k++) {
      ok = hay[i + k] == needle[k];
    }
    if (ok) return true;
  }
  return false;
}

void main() {
  final fs1 = Fs1Native.tryLoad();
  final ext = Fs1External.tryLoad();
  final skip = (fs1 == null || ext == null) ? 'libshear_admit with the external exports not loaded' : null;

  test('shared tag vector matches JS', () {
    var d = Directory.current;
    while (!File('${d.path}/crypto/vectors/fs1_external_v1.json').existsSync()) {
      d = d.parent;
    }
    final v = jsonDecode(File('${d.path}/crypto/vectors/fs1_external_v1.json').readAsStringSync());
    for (final c in v['tags'] as List) {
      expect(hexOf(ext!.referenceTag(bytesOf(c['x'] as String))!), c['tag']);
    }
  }, skip: skip);

  test('host proves without x, device signs, the unchanged verifier accepts', () {
    final seed = Uint8List(32)..fillRange(0, 32, 7);
    final book = [for (var i = 0; i < 12; i++) _pot(3000 + i, i, seed)];
    final pubs = [for (final n in book) n['admitPub'] as Uint8List];
    final commits = [for (final n in book) n['commit'] as Uint8List];
    final h = fs1!.treeNew();
    expect(fs1.treeAppend(h, fs1NotesBytes(pubs, commits, 12)), isTrue);
    final root = fs1.treeRoot(h)!;
    final digest = Uint8List(32)..fillRange(0, 32, 0x5a);
    final picks = [4, 10];
    final xs = [for (final i in picks) scalarBytes(admitScalarFromSeed(seed, book[i]))];
    final tags = [for (final x in xs) ext!.referenceTag(x)!];
    final p = ext!.prove(h, picks, tags, digest, 8)!;
    for (final r in p.requests) {
      for (final x in xs) {
        expect(_contains(r, x), isFalse, reason: 'x is not in a request');
      }
    }
    expect(ext.referenceSign(p.requests[0], xs[1]), isNull, reason: 'a device refuses a tag not its own');
    final sals = [for (var k = 0; k < 2; k++) ext.referenceSign(p.requests[k], xs[k])!];
    for (var k = 0; k < 2; k++) {
      expect(_contains(sals[k], xs[k]), isFalse, reason: 'x is not in the SA+L');
    }
    final out = ext.assemble(p.ctx, sals)!;
    expect(fs1.verify(out.fs1, out.records, root, digest, 8), isTrue);
    expect(fs1.verify(out.fs1, out.records, root, digest, 16), isFalse);
    final q = ext.prove(h, picks, tags, digest, 8)!;
    expect(ext.assemble(q.ctx, [Uint8List(160)..fillRange(0, 160, 1), sals[1]]), isNull, reason: 'forged SA+L');
  }, skip: skip);
}
