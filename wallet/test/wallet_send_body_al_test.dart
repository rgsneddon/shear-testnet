// AL-3 / AL-7: flow sends carry amtCt to the recipient and post no plaintext amount or addresses.
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_native_prove.dart';
import 'package:shear_wallet/shear_note.dart';

Uint8List _seed(int b) => Uint8List.fromList(List.filled(32, b));

const _plainKeys = ['from', 'to', 'amount', 'nanos', 'change', 'open', 'paintedOwedNanos'];

void main() {
  final sender = _seed(7);
  final receiver = _seed(9);
  final src = encodeDestAddress(Uint8List.fromList(List.filled(20, 1)));
  final to = encodeDestAddress(Uint8List.fromList(List.filled(20, 2)), admitBaseBytes(receiver));
  final noBase = encodeDestAddress(Uint8List.fromList(List.filled(20, 3)));

  setUp(() {
    debugNativeSealNote = (v, {dest20, kind = 'send'}) => sealCoinbaseNote(v, dest20: dest20, kind: kind);
  });
  tearDown(() => debugNativeSealNote = null);

  List<Map<String, dynamic>> seal() {
    final built = sealFlowSpendVouts({
      'spendSeed': sender,
      'destTo': to,
      'src': src,
      'vouts': [
        {'address': to, 'nanos': '1500000000', 'kind': 'send'},
        {'address': src, 'nanos': '250', 'kind': 'change'},
      ],
    });
    return [for (final o in built['vouts'] as List) compactSealedVout(Map<String, dynamic>.from(o as Map))];
  }

  test('every sealed flow output carries amtCt; only its owner opens the amount', () {
    final posted = seal();
    for (final o in posted) {
      expect(o['amtCt'], isA<Uint8List>());
      expect(o['rEph'], isA<Uint8List>());
      expect(o['rCt'], isA<Uint8List>());
      expect(o.containsKey('r'), isFalse);
      expect(o.containsKey('nanos'), isFalse);
    }
    expect(openNoteAmount(posted[0], admitBaseScalar(receiver))?['v'], BigInt.from(1500000000));
    expect(openNoteAmount(posted[0], admitBaseScalar(sender)), isNull);
    expect(openNoteAmount(posted[1], admitBaseScalar(sender))?['v'], BigInt.from(250));
  });

  test('sealing refuses a recipient without an admit base', () {
    expect(
      () => sealFlowSpendVouts({
        'spendSeed': sender,
        'destTo': noBase,
        'src': src,
        'vouts': [
          {'address': noBase, 'nanos': '5', 'kind': 'send'},
        ],
      }),
      throwsA(isA<StateError>()),
    );
  });

  Map<String, dynamic> body({String? dest, List<dynamic>? vout, String? sig = 'aa', String? kind}) => walletSendBody(
        from: src,
        to: dest ?? to,
        amount: 1.5,
        nanosWire: '1500000000',
        change: src,
        open: 'deadbeef',
        paintedOwedNanos: 3,
        kind: kind,
        sig: sig,
        spendPub: 'bb',
        vin: const [{'commit': 'cc'}],
        vout: vout ?? seal(),
        admitProof: const {'p': 1},
        fee: 1,
      );

  test('flow body posts the sealed tx only', () {
    final b = body();
    for (final k in _plainKeys) {
      expect(b.containsKey(k), isFalse, reason: k);
    }
    expect(b['vout'], isA<List>());
    expect(b['sig'], 'aa');
  });

  test('flow body refuses no-admit-base dest, unsealed send, and unwrapped vout', () {
    Matcher err(String m) => throwsA(isA<StateError>().having((e) => e.message, 'message', m));
    expect(() => body(dest: noBase), err('send_dest_no_admit_base'));
    expect(() => body(sig: null), err('send_not_sealed'));
    final bare = [
      for (final o in seal()) {...o}..remove('amtCt'),
    ];
    expect(() => body(vout: bare), err('send_vout_not_wrapped'));
  });

  test('a lock post has portalId, dest20, vout, and fs1, and no to, from, or ssa1', () {
    final dest20 = Uint8List(20)..[0] = 0x11;
    final b = walletSendBody(
      from: src,
      to: to,
      amount: 1,
      nanosWire: '314159265358',
      kind: 'lock',
      programId: 'shear-reserve-v1',
      portalId: 'ab' * 32,
      spendPub: 'cc' * 32,
      sig: 'dd' * 64,
      fs1: 'f1${'00' * 8}',
      vin: const [{'commit': 'ee'}],
      vout: [
        {'kind': 'lock', 'address': src, 'dest20': dest20, 'commit': 'ff' * 32, 'portalId': 'ab' * 32},
      ],
      admitProofs: const [
        {'blob': '01', 'cTilde': '02', 'spendTag': '03'},
      ],
    );
    expect(b['kind'], 'lock');
    expect(b['portalId'], 'ab' * 32);
    expect(b['dest20'], '11${'00' * 19}');
    expect(b['fs1'], 'f1${'00' * 8}');
    expect(b['vout'], isA<List>());
    expect(b.containsKey('from'), isFalse);
    expect(b.containsKey('to'), isFalse);
    expect(b.containsKey('spendPub'), isFalse);
    expect(b.containsKey('sig'), isFalse);
    final encoded = b.toString();
    expect(encoded.contains('ssa1'), isFalse);
    expect(encoded.contains('she1'), isFalse);
    expect(encoded.contains('shear1'), isFalse);
    final row = (b['vout'] as List).first as Map;
    expect(row.containsKey('address'), isFalse);
  });
}
