import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart';

import 'shear_identity.dart';

/// continuity-tethered Flow (CTF). Same domain separators as crypto/flow_sheet.js.
const ctfFlowPersonal = 'chronoflux-J-v1';
const ctfClosurePersonal = 'chronoflux-G-v1';
const ctfDestIndexPersonal = 'chronoflux-J-n-v1';

Uint8List ctfEmptyRoot() {
  return Uint8List.fromList(sha256.convert(utf8.encode('shear-empty-root-v1')).bytes);
}

/// continuity_root at header offset 68 (120-byte Shear header).
Uint8List lag1ContinuityFromHeader(Uint8List header) {
  if (header.length < 100) return ctfEmptyRoot();
  return Uint8List.fromList(header.sublist(68, 100));
}

Uint8List? headerFromHex(String hex) {
  final s = hex.trim();
  if (s.length < 240) return null;
  final out = Uint8List(s.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(s.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out.length >= 120 ? out.sublist(0, 120) : out;
}

Uint8List _sha(List<int> a, [List<int>? b, List<int>? c, List<int>? d]) {
  final buf = BytesBuilder();
  buf.add(a);
  if (b != null) buf.add(b);
  if (c != null) buf.add(c);
  if (d != null) buf.add(d);
  return Uint8List.fromList(sha256.convert(buf.toBytes()).bytes);
}

Uint8List closureCommit(String viewKey) {
  return _sha(utf8.encode(ctfClosurePersonal), utf8.encode(viewKey));
}

Uint8List impliedClosure(Uint8List spendHash20) {
  return _sha(utf8.encode(ctfClosurePersonal), spendHash20);
}

Uint8List flowTweak({
  required Uint8List closure,
  Uint8List? continuityRoot,
  int height = 0,
}) {
  final root = continuityRoot ?? ctfEmptyRoot();
  final h = ByteData(8)..setUint64(0, height, Endian.little);
  return _sha(utf8.encode(ctfFlowPersonal), closure, root, h.buffer.asUint8List());
}

Uint8List flowDestHash({
  required Uint8List spendHash20,
  required Uint8List closure,
  Uint8List? continuityRoot,
  int height = 0,
}) {
  final t = flowTweak(closure: closure, continuityRoot: continuityRoot, height: height);
  return Uint8List.fromList(_sha(utf8.encode(ctfFlowPersonal), spendHash20, t).sublist(0, 20));
}

List<String> destEncodings(Uint8List hash20) => [
      encodeHrp('she', hash20),
      encodeHrp('sdcard', hash20),
    ];

Uint8List _u64le(int n) {
  final o = Uint8List(8);
  var x = n;
  for (var i = 0; i < 8; i++) {
    o[i] = x & 0xff;
    x >>= 8;
  }
  return o;
}

Uint8List indexedDestHash({
  required Uint8List spendHash20,
  required Uint8List closure,
  required int index,
}) {
  final t = _sha(utf8.encode(ctfDestIndexPersonal), closure, _u64le(index));
  return Uint8List.fromList(_sha(utf8.encode(ctfFlowPersonal), spendHash20, t).sublist(0, 20));
}

String? destAtIndex(
  String restFrame, {
  required int index,
  required String viewKey,
}) {
  if (viewKey.isEmpty || index < 0) return null;
  final s = spendHashFromAddress(restFrame);
  if (s == null) return null;
  return encodeDestAddress(indexedDestHash(
    spendHash20: s,
    closure: closureCommit(viewKey),
    index: index,
  ));
}

String? destForLogin(
  String login, {
  Uint8List? continuityRoot,
  int height = 0,
  String? viewKey,
}) {
  if (isDestAddress(login)) return login;
  final s = spendHashFromAddress(login);
  if (s == null) return null;
  if (viewKey == null || viewKey.isEmpty) return null;
  return encodeDestAddress(flowDestHash(
    spendHash20: s,
    closure: closureCommit(viewKey),
    continuityRoot: continuityRoot,
    height: height,
  ));
}

String? degenerateDest(String login, {Uint8List? continuityRoot, int height = 0}) {
  final s = spendHashFromAddress(login);
  if (s == null) return null;
  return encodeDestAddress(flowDestHash(
    spendHash20: s,
    closure: impliedClosure(s),
    continuityRoot: continuityRoot,
    height: height,
  ));
}

List<String> destsForViewKey(
  String viewKey,
  String restAddress, {
  required List<int> heights,
  List<Uint8List?>? roots,
  String? ownerViewKey,
}) {
  if (viewKey.isEmpty) return const [];
  if (ownerViewKey != null && viewKey != ownerViewKey) return const [];
  return [
    for (var i = 0; i < heights.length; i++)
      destForLogin(
        restAddress,
        continuityRoot: roots != null && i < roots.length ? roots[i] : ctfEmptyRoot(),
        height: heights[i],
        viewKey: viewKey,
      )!,
  ];
}

Uint8List vaultRoot() => _sha(utf8.encode('shear-reserve-v1'));

String? vaultDest(String restFrame, {required String viewKey}) {
  final s = spendHashFromAddress(restFrame);
  if (s == null) return null;
  return encodeDestAddress(flowDestHash(
    spendHash20: s,
    closure: closureCommit(viewKey),
    continuityRoot: vaultRoot(),
    height: 0,
  ));
}

String? reservePrincipal(String restFrame, {required String viewKey}) =>
    vaultDest(restFrame, viewKey: viewKey);

bool reserveRejectsDest(String restFrame, String maybeDest, {int height = 1, required String viewKey}) {
  if (isShearAddress(maybeDest)) return true;
  final dest = destForLogin(restFrame, height: height, viewKey: viewKey);
  final vault = vaultDest(restFrame, viewKey: viewKey);
  return maybeDest == dest && vault != null && maybeDest != vault;
}

Uint8List memoKey(String dest) {
  final d = hash20FromAddress(dest) ?? Uint8List(20);
  return _sha(utf8.encode(ctfFlowPersonal), d);
}

Future<Map<String, dynamic>> memoSeal(String dest, String plaintext) async {
  final nonce = Uint8List.fromList(List<int>.generate(12, (_) => Random.secure().nextInt(256)));
  final box = await AesGcm.with256bits().encrypt(
    utf8.encode(plaintext),
    secretKey: SecretKey(memoKey(dest)),
    nonce: nonce,
  );
  return {
    'v': 1,
    'nonce': base64Encode(nonce),
    'mac': base64Encode(box.mac.bytes),
    'ct': base64Encode(box.cipherText),
  };
}

Future<String?> memoOpen(String dest, Map<String, dynamic>? env) async {
  if (env == null || env['v'] != 1) return null;
  try {
    final nonce = base64Decode(env['nonce'] as String);
    final mac = Mac(base64Decode(env['mac'] as String));
    final ct = base64Decode(env['ct'] as String);
    final clear = await AesGcm.with256bits().decrypt(
      SecretBox(ct, nonce: nonce, mac: mac),
      secretKey: SecretKey(memoKey(dest)),
    );
    return utf8.decode(clear);
  } catch (_) {
    return null;
  }
}
