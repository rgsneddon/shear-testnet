import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_fs1.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_native_prove.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_ristretto.dart';
import 'package:shear_wallet/shear_vault_reward.dart';
import 'package:shear_wallet/shear_withdraw.dart';

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Object? _json(Object? v) {
  if (v is Uint8List) return _hex(v);
  if (v is List<int>) return _hex(v);
  if (v is List) return [for (final row in v) _json(row)];
  if (v is Map) {
    return {for (final e in v.entries) e.key.toString(): _json(e.value)};
  }
  return v;
}

Uint8List _unhex(String hex) {
  final raw = hex.startsWith('0x') ? hex.substring(2) : hex;
  if (raw.length.isOdd) throw StateError('hex');
  final out = Uint8List(raw.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(raw.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

List<int> _ints(Object? raw) {
  if (raw is! List) throw StateError('list');
  return [for (final row in raw) row is int ? row : int.parse(row.toString())];
}

/// A withdraw against a chain fixture. The receipt is the one-time payout.
/// The change is hidden, so the spent note pays the fee and the change only.
void _emitFixture(String path) {
  final raw = jsonDecode(File(path).readAsStringSync());
  if (raw is! Map) throw StateError('fixture');
  if (Fs1Native.tryLoad() == null) throw StateError('fs1_prover_unavailable');
  final seed = _unhex(raw['seed'].toString());
  final nonce = _unhex(raw['nonce'].toString());
  final portal = raw['portalId'].toString();
  final id = raw['id'].toString();
  final anchor = raw['anchor'] as int;
  final fee = raw['fee'] as int;
  final nanos = raw['nanos'] as int;
  final inputValue = raw['inputValue'] as int;
  final changeN = inputValue - fee;
  if (seed.length != 32 || nonce.length != 32 || changeN <= 0) throw StateError('fixture');
  final dest20 = withdrawPayoutDest20(seed, portal, nonce);
  if (dest20 == null) throw StateError('payout');
  final receipt = attachAdmitPub(
    nativeSealNote(nanos, dest20: dest20, kind: 'withdraw'),
    spendSeed: seed,
  );
  receipt['kind'] = 'withdraw';
  receipt['dest20'] = dest20;
  if (!recognisesWithdrawPayout(receipt, seed, portal, nonce)) throw StateError('payout');
  final changeDest = _unhex(raw['changeDest20'].toString());
  final change = hiddenChangeNote(changeN, changeDest);
  if (change == null) throw StateError('change');
  final vout = <Map<String, dynamic>>[receipt, change];
  final notes = _unhex(raw['notes'].toString());
  final spentRow = raw['spent'];
  if (spentRow is! Map) throw StateError('spent');
  final spent = <Map<String, dynamic>>[
    {
      'kind': spentRow['kind'].toString(),
      'commit': _unhex(spentRow['commit'].toString()),
      'noteCommit': _unhex(spentRow['noteCommit'].toString()),
      'r': _unhex(spentRow['r'].toString()),
    },
  ];
  final leaf = raw['leaf'];
  if (leaf is! Map) throw StateError('leaf');
  final digest = fs1BodyDigest(
    magic: kBookMagic,
    kind: 'withdraw',
    anchor: anchor,
    fee: fee,
    nIn: 1,
    vout: vout,
    portalId: portal,
    programId: 'shear-reserve-v1',
    id: id,
    withdrawNonce: nonce,
    reserveNanos: nanos,
  );
  late final Map<String, dynamic> proved;
  try {
    proved = proveFs1SpendWire({
      'notes': notes,
      'indices': [raw['index'] as int],
      'spent': spent,
      'spendSeed': seed,
      'vout': vout,
      'digest': digest,
      'anchor': anchor,
      'tree': const Fs1TreeState().toWire(),
    });
  } catch (e) {
    throw StateError('fs1_prove $e');
  }
  final tree = Fs1TreeState.fromWire(proved['tree']);
  try {
    final records = [for (final r in (proved['records'] as List)) r as Uint8List];
    final posted = [for (final r in records) fs1PostedProof(r)];
    final built = buildProvedWithdraw(
      dest20: dest20,
      nanos: nanos,
      id: id,
      portalId: portal,
      anchor: anchor,
      excess: proved['excess'] as Uint8List,
      fs1: proved['fs1'] as Uint8List,
      vin: [
        for (final p in posted) {'commit': p['cTilde']},
      ],
      admitProofs: [
        for (final p in posted)
          {
            'blob': p['blob'],
            'cTilde': p['cTilde'],
            'spendTag': p['spendTag'],
          },
      ],
      leaves: [
        {
          'scalar': _unhex(leaf['scalar'].toString()),
          'blind': _unhex(leaf['blind'].toString()),
          'note': _unhex(leaf['note'].toString()),
          'unlock': leaf['unlock'] as int,
          'amount': leaf['amount'] as int,
          'epochs': _ints(leaf['epochs']),
          'withdrawPeriod': leaf['withdrawPeriod'] as int,
        },
      ],
      spendSeed: seed,
      releaseEpoch: raw['releaseEpoch'] as int,
      fee: fee,
      withdrawNonce: nonce,
      vout: vout,
      tranches: [
        for (final row in (raw['tranches'] as List? ?? const []))
          if (row is Map<String, dynamic>)
            {
              'commit': row['commit'].toString(),
              'epoch': row['epoch'] is int ? row['epoch'] as int : int.parse(row['epoch'].toString()),
              'remainMs': row['remainMs'] is int ? row['remainMs'] as int : int.parse(row['remainMs'].toString()),
              if (row['noteIsPrincipal'] == true) 'noteIsPrincipal': true,
            },
      ],
    );
    if (built == null) throw StateError('null');
    print(jsonEncode(_json(built)));
  } finally {
    Fs1Native.tryLoad()?.treeFree(tree.handle);
  }
}

/// Two notes this seed owns, inside a four-note anchor row.
Map<String, dynamic> _ownedPot(int v, int i, Uint8List seed) {
  final note = sealCoinbaseNote(v, dest20: Uint8List(20)..fillRange(0, 20, i + 1), kind: 'pot');
  return attachAdmitPub(note, spendSeed: seed);
}

void main() {
  final fixture = Platform.environment['SHEAR_WITHDRAW_FIXTURE'];
  if (fixture != null && fixture.isNotEmpty) {
    _emitFixture(fixture);
    return;
  }
  const pi = 314159265358;
  const anchor = 16;
  const id = 'dart-wd';
  const programId = 'shear-reserve-v1';
  final portal = 'ab' * 32;
  final seed = Uint8List(32)..[0] = 9;
  final nonce = Uint8List(32)..[31] = 7;
  final dest20 = withdrawPayoutDest20(seed, portal, nonce);
  if (dest20 == null) throw StateError('payout');
  if (Fs1Native.tryLoad() == null) {
    throw StateError('fs1_prover_unavailable');
  }
  final receipt = attachAdmitPub(
    sealNote(pi * 2, dest20: dest20, kind: 'withdraw'),
    spendSeed: seed,
  );
  receipt['kind'] = 'withdraw';
  receipt['dest20'] = dest20;
  if (!recognisesWithdrawPayout(receipt, seed, portal, nonce)) {
    throw StateError('payout');
  }
  final vout = <Map<String, dynamic>>[receipt];
  final book = <Map<String, dynamic>>[
    for (var i = 0; i < 4; i++) _ownedPot(1000 + i, i, seed),
  ];
  final pubs = [for (final n in book) n['admitPub'] as Uint8List];
  final commits = [for (final n in book) n['commit'] as Uint8List];
  final spent = [
    for (final i in [0, 1])
      {
        'kind': 'pot',
        'commit': book[i]['commit'],
        'noteCommit': book[i]['noteCommit'],
        'r': book[i]['r'],
      },
  ];
  // The proof binds the sealed receipt. cTilde and the aggregate blob are not in it.
  final digest = fs1BodyDigest(
    magic: kBookMagic,
    kind: 'withdraw',
    anchor: anchor,
    fee: 0,
    nIn: 2,
    vout: vout,
    portalId: portal,
    programId: programId,
    id: id,
    withdrawNonce: nonce,
    reserveNanos: pi * 2,
  );
  late final Map<String, dynamic> proved;
  try {
    proved = proveFs1SpendWire({
      'notes': fs1NotesBytes(pubs, commits, 4),
      'indices': [0, 1],
      'spent': spent,
      'spendSeed': seed,
      'vout': vout,
      'digest': digest,
      'anchor': anchor,
      'tree': const Fs1TreeState().toWire(),
    });
  } catch (e) {
    throw StateError('fs1_prove $e');
  }
  final tree = Fs1TreeState.fromWire(proved['tree']);
  try {
    final records = [for (final r in (proved['records'] as List)) r as Uint8List];
    final posted = [for (final r in records) fs1PostedProof(r)];
    final fs1 = proved['fs1'] as Uint8List;
    final excess = proved['excess'] as Uint8List;
    final leaves = <Map<String, Object?>>[];
    for (var i = 0; i < 2; i++) {
      final scalar = scalarBytes(hashToScalar([utf8Bytes('leaf-scalar-$i')]));
      final blind = scalarBytes(hashToScalar([utf8Bytes('leaf-blind-$i')]));
      final note = vaultLeafNote(amount: pi, scalar: scalar, blind: blind, unlock: 16);
      leaves.add({
        'scalar': scalar,
        'blind': blind,
        'note': note,
        'unlock': 16,
        'amount': pi,
        'epochs': [3, 4, 5],
        'withdrawPeriod': 3,
      });
    }
    final built = buildProvedWithdraw(
      dest20: dest20,
      nanos: pi * 2,
      id: id,
      portalId: portal,
      anchor: anchor,
      excess: excess,
      fs1: fs1,
      vin: [
        for (final p in posted) {'commit': p['cTilde']},
      ],
      admitProofs: [
        for (final p in posted)
          {
            'blob': p['blob'],
            'cTilde': p['cTilde'],
            'spendTag': p['spendTag'],
          },
      ],
      leaves: leaves,
      spendSeed: seed,
      releaseEpoch: 0,
      fee: 0,
      withdrawNonce: nonce,
      vout: vout,
    );
    if (built == null) throw StateError('null');
    print(jsonEncode(_json(built)));
  } finally {
    Fs1Native.tryLoad()?.treeFree(tree.handle);
  }
}
