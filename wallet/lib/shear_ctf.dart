import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'shear_identity.dart';

/// Continuum-Tensor-Flow (CTF). Same domain separators as crypto/flow_sheet.js.
const ctfFlowPersonal = 'chronoflux-J-v1';
const ctfClosurePersonal = 'chronoflux-G-v1';

Uint8List ctfEmptyRoot() {
  return Uint8List.fromList(sha256.convert(utf8.encode('shear-empty-root-v1')).bytes);
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

String destForLogin(
  String login, {
  Uint8List? continuityRoot,
  int height = 0,
  String? viewKey,
}) {
  final s = spendHashFromAddress(login);
  if (s == null) return login;
  final c = viewKey != null && viewKey.isNotEmpty
      ? closureCommit(viewKey)
      : impliedClosure(s);
  return encodeShearAddress(flowDestHash(
    spendHash20: s,
    closure: c,
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
      ),
  ];
}

/// Reserve / Vortex lock principal is rest-frame, never a CTF dest.
String reservePrincipal(String restFrame) => restFrame;

bool reserveRejectsDest(String restFrame, String maybeDest, {int height = 1}) {
  final dest = destForLogin(restFrame, height: height);
  return maybeDest == dest && maybeDest != restFrame;
}
