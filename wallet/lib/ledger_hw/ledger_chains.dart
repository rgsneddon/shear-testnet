/// Ledger vortice per-chain modules (docs/LEDGER-VORTICE.md §2-3): app
/// detection, address read and verify-on-device, and EIP-1559 signing.
/// Every signature comes from the device after the user confirms on it.
library;

import 'dart:typed_data';

import '../shear_eip712.dart' show keccak256;
import 'ledger_transport.dart';

/// `B0 01`: the open app's name and version. `BOLOS` is the dashboard.
class LedgerApp {
  const LedgerApp(this.name, this.version);
  final String name;
  final String version;
  bool get isDashboard => name == 'BOLOS';

  static Future<LedgerApp> read(LedgerTransport t) async {
    final r = await send(t, apdu(0xb0, 0x01, 0x00, 0x00));
    if (r.isEmpty || r[0] != 0x01) throw const FormatException('app format');
    var i = 1;
    final nl = r[i++];
    final name = String.fromCharCodes(r.sublist(i, i + nl));
    i += nl;
    final vl = r[i++];
    final ver = String.fromCharCodes(r.sublist(i, i + vl));
    return LedgerApp(name, ver);
  }

  /// The chain module key for this app, or null when no reader exists yet.
  String? get chain {
    if (name == 'Ethereum' || name.contains('EVM')) return 'ETH';
    return const {'Bitcoin': 'BTC', 'Litecoin': 'LTC', 'Dogecoin': 'DOGE', 'Solana': 'SOL', 'Shear': 'SHE'}[name];
  }
}

// ---------------------------------------------------------------- ETH / EVM

const String kEthPath = "44'/60'/0'/0/0";

/// EIP-55 checksum of a 20-byte address.
String eip55(List<int> addr20) {
  final lower = hexOf(addr20);
  final h = hexOf(keccak256(Uint8List.fromList(lower.codeUnits)));
  final b = StringBuffer('0x');
  for (var i = 0; i < 40; i++) {
    final c = lower[i];
    b.write(int.parse(h[i], radix: 16) >= 8 ? c.toUpperCase() : c);
  }
  return b.toString();
}

/// `E0 02`: address at [path]. With [verify] the device shows it.
Future<String> ethAddress(LedgerTransport t, {String path = kEthPath, bool verify = false}) async {
  final r = await send(t, apdu(0xe0, 0x02, verify ? 0x01 : 0x00, 0x00, encodePath(path)));
  final pl = r[0];
  final al = r[1 + pl];
  final ascii = String.fromCharCodes(r.sublist(2 + pl, 2 + pl + al));
  return eip55(bytesOf(ascii));
}

/// RLP. Items are [Uint8List], [BigInt], [int] or [List].
Uint8List rlp(Object item) {
  Uint8List lenPrefix(int len, int base) {
    if (len < 56) return Uint8List.fromList([base + len]);
    final lb = _beInt(BigInt.from(len));
    return Uint8List.fromList([base + 55 + lb.length, ...lb]);
  }

  if (item is List && item is! Uint8List) {
    final body = BytesBuilder();
    for (final e in item) {
      body.add(rlp(e as Object));
    }
    final b = body.toBytes();
    return Uint8List.fromList([...lenPrefix(b.length, 0xc0), ...b]);
  }
  final Uint8List bytes = switch (item) {
    Uint8List b => b,
    BigInt v => _beInt(v),
    int v => _beInt(BigInt.from(v)),
    String s => Uint8List.fromList(s.codeUnits),
    _ => throw ArgumentError('rlp item'),
  };
  if (bytes.length == 1 && bytes[0] < 0x80) return bytes;
  return Uint8List.fromList([...lenPrefix(bytes.length, 0x80), ...bytes]);
}

Uint8List _beInt(BigInt v) {
  if (v < BigInt.zero) throw ArgumentError('negative');
  if (v == BigInt.zero) return Uint8List(0);
  var h = v.toRadixString(16);
  if (h.length.isOdd) h = '0$h';
  return bytesOf(h);
}

/// An unsigned EIP-1559 (type 2) transfer.
class Eip1559Tx {
  Eip1559Tx({
    required this.chainId,
    required this.nonce,
    required this.maxPriorityFeePerGas,
    required this.maxFeePerGas,
    required this.gasLimit,
    required this.to,
    required this.value,
    Uint8List? data,
  }) : data = data ?? Uint8List(0) {
    if (bytesOf(to).length != 20) throw ArgumentError('to');
  }
  final int chainId;
  final int nonce;
  final BigInt maxPriorityFeePerGas;
  final BigInt maxFeePerGas;
  final int gasLimit;
  final String to;
  final BigInt value;
  final Uint8List data;

  List<Object> get _fields => [
        chainId,
        nonce,
        maxPriorityFeePerGas,
        maxFeePerGas,
        gasLimit,
        bytesOf(to),
        value,
        data,
        <Object>[],
      ];

  /// `0x02 ‖ rlp(fields)`: the bytes the device hashes and signs.
  Uint8List unsigned() => Uint8List.fromList([0x02, ...rlp(_fields)]);

  /// `0x02 ‖ rlp(fields ‖ yParity ‖ r ‖ s)`: the broadcast bytes.
  Uint8List signed(int yParity, Uint8List r, Uint8List s) => Uint8List.fromList([
        0x02,
        ...rlp([..._fields, yParity, _strip(r), _strip(s)]),
      ]);

  static Uint8List _strip(Uint8List b) {
    var i = 0;
    while (i < b.length && b[i] == 0) {
      i++;
    }
    return Uint8List.sublistView(b, i);
  }
}

/// `E0 04`: the device shows destination, amount and fee, and signs after
/// the user confirms. Returns the broadcast bytes.
Future<Uint8List> ethSign(LedgerTransport t, Eip1559Tx tx, {String path = kEthPath}) async {
  final payload = Uint8List.fromList([...encodePath(path), ...tx.unsigned()]);
  Uint8List? r;
  for (var off = 0, first = true; off < payload.length; first = false) {
    final take = (payload.length - off).clamp(0, 255);
    r = await send(t, apdu(0xe0, 0x04, first ? 0x00 : 0x80, 0x00, payload.sublist(off, off + take)));
    off += take;
  }
  if (r == null || r.length < 65) throw const FormatException('eth signature');
  final v = r[0];
  final parity = v >= 27 ? (v - 27) & 1 : v & 1;
  return tx.signed(parity, Uint8List.fromList(r.sublist(1, 33)), Uint8List.fromList(r.sublist(33, 65)));
}

// ---------------------------------------------------------------- BTC family

/// Legacy app protocol (Litecoin, Dogecoin): `E0 40`. P2: 0 legacy, 1 p2sh,
/// 2 bech32. The response is `pubLen pub addrLen addr chaincode`.
Future<String> btcLegacyAddress(LedgerTransport t, String path, {int format = 2, bool verify = false}) async {
  final r = await send(t, apdu(0xe0, 0x40, verify ? 0x01 : 0x00, format, encodePath(path)));
  final pl = r[0];
  final al = r[1 + pl];
  return String.fromCharCodes(r.sublist(2 + pl, 2 + pl + al));
}

/// Bitcoin app 2.x: `E1 00` extended pubkey (no client commands needed).
/// The verify-on-device address (`E1 03`) needs the merkle client-command
/// loop, which is listed in the handoff as still to do.
Future<String> btcXpub(LedgerTransport t, String path, {bool verify = false}) async {
  final r = await send(t, apdu(0xe1, 0x00, 0x00, 0x00, [verify ? 1 : 0, ...encodePath(path)]));
  return String.fromCharCodes(r);
}

// ---------------------------------------------------------------- SOL

const String kSolPath = "44'/501'/0'";

/// `E0 05`: 32-byte Ed25519 pubkey, base58 is the address.
Future<String> solAddress(LedgerTransport t, {String path = kSolPath, bool verify = false}) async {
  final r = await send(t, apdu(0xe0, 0x05, verify ? 0x01 : 0x00, 0x00, encodePath(path)));
  if (r.length != 32) throw const FormatException('sol pubkey');
  return base58(r);
}

const _b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

String base58(List<int> b) {
  var n = BigInt.zero;
  for (final x in b) {
    n = (n << 8) | BigInt.from(x);
  }
  final s = StringBuffer();
  final f = BigInt.from(58);
  while (n > BigInt.zero) {
    s.write(_b58[(n % f).toInt()]);
    n ~/= f;
  }
  for (final x in b) {
    if (x != 0) break;
    s.write('1');
  }
  return s.toString().split('').reversed.join();
}
