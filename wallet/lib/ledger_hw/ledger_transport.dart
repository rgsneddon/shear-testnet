/// Ledger vortice transport layer (docs/LEDGER-VORTICE.md §1).
///
/// One [LedgerTransport] interface. The HID and BLE framing is in
/// [LedgerFrame]. Platform shims (desktop HID over FFI, Android BLE) implement
/// the interface and live outside this file, so the core and the tests never
/// import a plugin.
library;

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

/// The APDU exchange. The response ends with the 2-byte status word.
abstract class LedgerTransport {
  Future<Uint8List> exchange(Uint8List apdu);
  Future<void> close();
}

/// A device status word that isn't `9000`.
class LedgerStatusError implements Exception {
  LedgerStatusError(this.sw);
  final int sw;

  /// One message table for the UI (docs §2).
  String get message => switch (sw) {
        0x6985 => 'Refused on the device.',
        0x5515 || 0x6982 => 'The device is locked. Unlock it with your PIN.',
        0x6e00 || 0x6d00 || 0x6e01 || 0x6511 => 'Wrong app. Open the right coin app on the device.',
        0x6a80 || 0x6a87 => 'The device rejected the data.',
        0x6b00 => 'Bad parameter for this app version.',
        _ => 'Device error 0x${sw.toRadixString(16).padLeft(4, '0')}.',
      };

  @override
  String toString() => 'LedgerStatusError(0x${sw.toRadixString(16)}): $message';
}

/// Build a short APDU: `cla ins p1 p2 lc data`.
Uint8List apdu(int cla, int ins, int p1, int p2, [List<int> data = const []]) {
  if (data.length > 255) throw ArgumentError('apdu data > 255');
  return Uint8List.fromList([cla, ins, p1, p2, data.length, ...data]);
}

/// Send, check `9000`, and return the body without the status word.
Future<Uint8List> send(LedgerTransport t, Uint8List a) async {
  final r = await t.exchange(a);
  if (r.length < 2) throw LedgerStatusError(0);
  final sw = (r[r.length - 2] << 8) | r[r.length - 1];
  if (sw != 0x9000) throw LedgerStatusError(sw);
  return Uint8List.sublistView(r, 0, r.length - 2);
}

/// BIP32 path `44'/60'/0'/0/0` to `n ‖ u32 BE…`.
Uint8List encodePath(String path) {
  final parts = path.replaceFirst(RegExp(r'^m/'), '').split('/');
  if (parts.isEmpty || parts.length > 10) throw ArgumentError('path');
  final out = BytesBuilder()..addByte(parts.length);
  for (final p in parts) {
    final hard = p.endsWith("'") || p.endsWith('h');
    final n = int.parse(hard ? p.substring(0, p.length - 1) : p);
    if (n < 0 || n >= 0x80000000) throw ArgumentError('path');
    final v = hard ? n | 0x80000000 : n;
    out.add([(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  }
  return out.toBytes();
}

/// HID and BLE framing. HID has the channel `0x0101` and 64-byte padded
/// packets. BLE has no channel, and its packet size is the MTU.
class LedgerFrame {
  const LedgerFrame.hid() : channel = 0x0101, packetSize = 64, pad = true;
  const LedgerFrame.ble({this.packetSize = 20}) : channel = null, pad = false;

  final int? channel;
  final int packetSize;
  final bool pad;
  static const int tag = 0x05;
  static const int maxApdu = 0x10000;

  int get _head => (channel == null ? 0 : 2) + 3;

  List<Uint8List> encode(Uint8List data) {
    if (data.length >= maxApdu) throw ArgumentError('apdu too long');
    final out = <Uint8List>[];
    var off = 0;
    var seq = 0;
    do {
      final b = BytesBuilder();
      if (channel != null) b.add([channel! >> 8, channel! & 0xff]);
      b.add([tag, seq >> 8, seq & 0xff]);
      if (seq == 0) b.add([data.length >> 8, data.length & 0xff]);
      final room = packetSize - b.length;
      final take = (data.length - off).clamp(0, room);
      b.add(data.sublist(off, off + take));
      off += take;
      var p = b.toBytes();
      if (pad && p.length < packetSize) p = Uint8List(packetSize)..setAll(0, p);
      out.add(p);
      seq++;
    } while (off < data.length);
    return out;
  }

  /// Reassembles packets. Returns null until the message is complete.
  /// Throws on a wrong channel, tag or sequence.
  Uint8List? decode(List<Uint8List> packets) {
    final body = BytesBuilder();
    int? len;
    for (var seq = 0; seq < packets.length; seq++) {
      final p = packets[seq];
      var i = 0;
      if (channel != null) {
        if (p.length < 2 || ((p[0] << 8) | p[1]) != channel) throw const FormatException('channel');
        i = 2;
      }
      if (p.length < i + 3 || p[i] != tag) throw const FormatException('tag');
      if (((p[i + 1] << 8) | p[i + 2]) != seq) throw const FormatException('sequence');
      i += 3;
      if (seq == 0) {
        if (p.length < i + 2) throw const FormatException('length');
        len = (p[i] << 8) | p[i + 1];
        i += 2;
      }
      body.add(p.sublist(i));
      if (body.length >= len!) return Uint8List.fromList(body.toBytes().sublist(0, len));
    }
    return null;
  }

  int get headerBytes => _head;
}

/// Replays a recorded trace. Any APDU that differs from the trace fails.
class MockLedgerTransport implements LedgerTransport {
  MockLedgerTransport(this.trace);

  /// Pairs of (expected APDU hex, response hex including SW).
  final List<(String, String)> trace;
  int _at = 0;
  bool get done => _at == trace.length;

  /// Parses `=> e0020000…` / `<= 04ab…9000` lines.
  factory MockLedgerTransport.parse(String text) {
    final lines = text.split('\n').map((l) => l.trim()).where((l) => l.isNotEmpty && !l.startsWith('#')).toList();
    final pairs = <(String, String)>[];
    for (var i = 0; i + 1 < lines.length; i += 2) {
      if (!lines[i].startsWith('=>') || !lines[i + 1].startsWith('<=')) throw const FormatException('trace');
      pairs.add((lines[i].substring(2).trim().toLowerCase(), lines[i + 1].substring(2).trim().toLowerCase()));
    }
    return MockLedgerTransport(pairs);
  }

  @override
  Future<Uint8List> exchange(Uint8List a) async {
    if (_at >= trace.length) throw StateError('trace exhausted');
    final (want, resp) = trace[_at++];
    final got = hexOf(a);
    if (got != want) throw StateError('trace mismatch at ${_at - 1}: sent $got, expected $want');
    return bytesOf(resp);
  }

  @override
  Future<void> close() async {}
}

/// Speculos APDU port (TCP 9999): 4-byte BE length and APDU out; 4-byte BE
/// length, data, then SW back (the length excludes the SW).
class SpeculosTransport implements LedgerTransport {
  SpeculosTransport._(this._s) {
    _s.listen(_buf.add, onDone: () => _closed = true);
  }
  final Socket _s;
  final _buf = BytesBuilder();
  bool _closed = false;

  static Future<SpeculosTransport> connect({String host = '127.0.0.1', int port = 9999}) async =>
      SpeculosTransport._(await Socket.connect(host, port, timeout: const Duration(seconds: 5)));

  @override
  Future<Uint8List> exchange(Uint8List a) async {
    final n = a.length;
    _s.add([n >> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, ...a]);
    await _s.flush();
    final deadline = DateTime.now().add(const Duration(seconds: 120));
    while (true) {
      final b = _buf.toBytes();
      if (b.length >= 4) {
        final len = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
        if (b.length >= 4 + len + 2) {
          final out = Uint8List.fromList(b.sublist(4, 4 + len + 2));
          final rest = b.sublist(4 + len + 2);
          _buf.clear();
          _buf.add(rest);
          return out;
        }
      }
      if (_closed || DateTime.now().isAfter(deadline)) throw const SocketException('speculos closed');
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  @override
  Future<void> close() => _s.close();
}

String hexOf(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Uint8List bytesOf(String h) {
  final s = h.startsWith('0x') ? h.substring(2) : h;
  if (s.length.isOdd) throw const FormatException('hex');
  return Uint8List.fromList([for (var i = 0; i < s.length; i += 2) int.parse(s.substring(i, i + 2), radix: 16)]);
}
