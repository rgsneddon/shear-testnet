import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/ledger_hw/ledger_chains.dart';
import 'package:shear_wallet/ledger_hw/ledger_transport.dart';

Uint8List _b58decode(String s) {
  const a = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var n = BigInt.zero;
  for (final c in s.split('')) {
    n = n * BigInt.from(58) + BigInt.from(a.indexOf(c));
  }
  final out = <int>[];
  while (n > BigInt.zero) {
    out.insert(0, (n & BigInt.from(0xff)).toInt());
    n >>= 8;
  }
  for (final c in s.split('')) {
    if (c != '1') break;
    out.insert(0, 0);
  }
  return Uint8List.fromList(out);
}

Map<String, dynamic> _donate() {
  var d = Directory.current;
  while (!File('${d.path}/vortices/ledger/donate-addresses.json').existsSync()) {
    d = d.parent;
  }
  return jsonDecode(File('${d.path}/vortices/ledger/donate-addresses.json').readAsStringSync())['addresses']
      as Map<String, dynamic>;
}

void main() {
  group('framing', () {
    for (final f in [const LedgerFrame.hid(), const LedgerFrame.ble(), const LedgerFrame.ble(packetSize: 153)]) {
      test('round trip ${f.channel == null ? 'ble ${f.packetSize}' : 'hid'}', () {
        for (final n in [0, 1, 5, 57, 59, 60, 200, 255, 600]) {
          final data = Uint8List.fromList(List.generate(n, (i) => i * 7 & 0xff));
          final pk = f.encode(data);
          for (final p in pk) {
            expect(p.length <= f.packetSize, isTrue);
            if (f.pad) expect(p.length, 64);
          }
          expect(f.decode(pk), data);
          if (pk.length > 1) expect(f.decode(pk.sublist(0, pk.length - 1)), isNull);
        }
      });
    }
    test('hid first packet header', () {
      final p = const LedgerFrame.hid().encode(bytesOf('b001000000'))[0];
      expect(hexOf(p.sublist(0, 12)), '01010500000005b001000000');
    });
    test('wrong sequence and channel are rejected', () {
      final f = const LedgerFrame.hid();
      final pk = f.encode(Uint8List(100));
      expect(() => f.decode([pk[1], pk[0]]), throwsFormatException);
      final bad = Uint8List.fromList(pk[0])..[1] = 0x02;
      expect(() => f.decode([bad]), throwsFormatException);
    });
  });

  test('path encoding', () {
    expect(hexOf(encodePath("44'/60'/0'/0/0")), '058000002c8000003c800000000000000000000000');
    expect(() => encodePath("44'/x"), throwsFormatException);
  });

  group('rlp (Ethereum yellow paper vectors)', () {
    test('strings, ints, lists', () {
      expect(hexOf(rlp('dog')), '83646f67');
      expect(hexOf(rlp(['cat', 'dog'])), 'c88363617483646f67');
      expect(hexOf(rlp('')), '80');
      expect(hexOf(rlp(<Object>[])), 'c0');
      expect(hexOf(rlp(0)), '80');
      expect(hexOf(rlp(15)), '0f');
      expect(hexOf(rlp(1024)), '820400');
      expect(
          hexOf(rlp([
            <Object>[],
            [<Object>[]],
            [
              <Object>[],
              [<Object>[]]
            ]
          ])),
          'c7c0c1c0c3c0c1c0');
      final lorem = rlp('Lorem ipsum dolor sit amet, consectetur adipisicing elit');
      expect(hexOf(lorem.sublist(0, 3)), 'b8384c');
      expect(lorem.length, 58);
    });
  });

  test('EIP-55 vectors', () {
    for (final a in [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    ]) {
      expect(eip55(bytesOf(a.substring(2).toLowerCase())), a);
    }
  });

  group('mock trace replay', () {
    test('app detection', () async {
      // "Ethereum" 1.13.0, flags 02.
      final t = MockLedgerTransport.parse('''
        => b001000000
        <= 0108457468657265756d06312e31332e3001029000
      ''');
      final app = await LedgerApp.read(t);
      expect((app.name, app.version, app.chain), ('Ethereum', '1.13.0', 'ETH'));
      expect(t.done, isTrue);
    });

    test('ETH address with verify gives Russell\'s checksummed address', () async {
      final want = _donate()['ETH'] as String;
      final ascii = hexOf(want.substring(2).toLowerCase().codeUnits);
      final pub = '04${'11' * 64}';
      final t = MockLedgerTransport.parse('''
        => e002010015058000002c8000003c800000000000000000000000
        <= 41${pub}28$ascii 9000
      '''.replaceAll(' 9000', '9000'));
      expect(await ethAddress(t, verify: true), want);
    });

    test('SOL address', () async {
      final want = _donate()['SOL'] as String;
      final pk = _b58decode(want);
      expect(pk.length, 32);
      final t = MockLedgerTransport.parse('''
        => e00501000d038000002c800001f580000000
        <= ${hexOf(pk)}9000
      ''');
      expect(await solAddress(t, verify: true), want);
      expect(base58(Uint8List(32)), '11111111111111111111111111111111');
    });

    test('LTC legacy bech32 address', () async {
      final want = _donate()['LTC'] as String;
      final t = MockLedgerTransport.parse('''
        => e04001021505${'8000005480000002800000000000000000000000'}
        <= 41${'04${'22' * 64}'}${want.length.toRadixString(16)}${hexOf(want.codeUnits)}${'33' * 32}9000
      ''');
      expect(await btcLegacyAddress(t, "84'/2'/0'/0/0", verify: true), want);
    });

    test('refusal maps to a status error', () async {
      final t = MockLedgerTransport.parse('''
        => e002010015058000002c8000003c800000000000000000000000
        <= 6985
      ''');
      expect(() => ethAddress(t, verify: true),
          throwsA(isA<LedgerStatusError>().having((e) => e.message, 'm', 'Refused on the device.')));
    });

    test('a different APDU from the trace fails', () async {
      final t = MockLedgerTransport.parse('=> b001000000\n<= 9000');
      expect(() => t.exchange(bytesOf('e0020000')), throwsStateError);
    });
  });

  group('EIP-1559', () {
    final tx = Eip1559Tx(
      chainId: 1,
      nonce: 0,
      maxPriorityFeePerGas: BigInt.from(1000000000),
      maxFeePerGas: BigInt.from(30000000000),
      gasLimit: 21000,
      to: _donate()['ETH'] as String,
      value: BigInt.from(10).pow(16),
    );
    test('unsigned payload layout', () {
      final u = tx.unsigned();
      expect(u[0], 0x02);
      // rlp([1, 0, 1 gwei, 30 gwei, 21000, to, 0.01 ETH, '', []])
      expect(hexOf(u),
          '02ef0180843b9aca008506fc23ac0082520894c6d546b4d188a7a695eafcd396817c23e6fb9356872386f26fc1000080c0');
    });
    test('signing chunks over 255 bytes and assembles the broadcast bytes', () async {
      final big = Eip1559Tx(
        chainId: 1,
        nonce: 1,
        maxPriorityFeePerGas: BigInt.one,
        maxFeePerGas: BigInt.two,
        gasLimit: 60000,
        to: tx.to,
        value: BigInt.zero,
        data: Uint8List(300),
      );
      final payload = [...encodePath(kEthPath), ...big.unsigned()];
      final c1 = payload.sublist(0, 255), c2 = payload.sublist(255);
      final r = '01' * 32, s = '02' * 32;
      final t = MockLedgerTransport([
        ('e0040000ff${hexOf(c1)}', '9000'),
        ('e0048000${c2.length.toRadixString(16).padLeft(2, '0')}${hexOf(c2)}', '01$r${s}9000'),
      ]);
      final out = await ethSign(t, big);
      expect(t.done, isTrue);
      expect(out[0], 0x02);
      expect(hexOf(out).endsWith('01a0$r' 'a0$s'), isTrue);
    });
  });
}
