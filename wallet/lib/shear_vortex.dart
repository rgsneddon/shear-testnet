import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';

const vortexPersonal = 'chronoflux-Omega-v1';
const vorticeKeyPrefix = 'vort1.';
const reserveProgram = 'shear-reserve-v1';
const joinProgram = 'shear-join-v1';
const joinWatchProgram = 'shear-join-watch-v1';

class Vortice {
  const Vortice({
    required this.id,
    required this.name,
    this.pinned = false,
    this.origin,
    this.bundle,
    this.source,
  });
  final String id;
  final String name;
  final bool pinned;
  final String? origin;
  final String? bundle;
  final String? source;

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'pinned': pinned,
        if (origin != null) 'origin': origin,
        if (bundle != null) 'bundle': bundle,
        if (source != null) 'source': source,
      };

  factory Vortice.fromJson(Map<String, dynamic> j) => Vortice(
        id: j['id']?.toString() ?? '',
        name: j['name']?.toString() ?? '',
        pinned: j['pinned'] == true,
        origin: j['origin']?.toString(),
        bundle: j['bundle']?.toString(),
        source: j['source']?.toString(),
      );
}

const reserveVortice = Vortice(id: reserveProgram, name: 'The Reserve', pinned: true);
/// Reserved dead id. Not a chip. Impersonation keys must still fail.
const joinVortice = Vortice(id: joinProgram, name: 'The Join', pinned: true);
const joinWatchVortice = Vortice(id: joinWatchProgram, name: '', pinned: true);

const poolUnlockProgram = 'pool-unlock-2044';

Map<String, dynamic>? parseVorticeSource(String? source) {
  if (source == null || source.isEmpty) return null;
  try {
    final v = jsonDecode(source);
    return v is Map<String, dynamic> ? v : null;
  } catch (_) {
    return null;
  }
}

bool isPinnedProgram(String id) =>
    id == reserveProgram || id == joinProgram || id == joinWatchProgram;

bool isReservedProgram(String id) => isPinnedProgram(id) || id == poolUnlockProgram;

bool vorticeChipVisible(Vortice v) =>
    v.id != joinWatchProgram && v.id != joinProgram && v.id.isNotEmpty;

List<Vortice> reapExpiredJoin(List<Vortice> list, {required bool expired}) {
  return list.where((v) => v.id != joinProgram && v.id != joinWatchProgram).toList();
}

String? validProgramId(String programId) {
  final id = programId.trim().toLowerCase();
  if (!RegExp(r'^[a-z0-9._-]{3,64}$').hasMatch(id)) return null;
  if (isReservedProgram(id)) return null;
  return id;
}

String? validOrigin(String origin) {
  final raw = origin.trim();
  final u = Uri.tryParse(raw);
  if (u == null || !u.hasScheme || u.host.isEmpty) return null;
  if (u.scheme != 'https' && u.scheme != 'http') return null;
  return raw;
}

String vorticeBundleHash({
  required String programId,
  required String name,
  required String origin,
  required String source,
}) {
  final bytes = <int>[
    ...utf8.encode(vortexPersonal),
    ...utf8.encode(programId),
    0,
    ...utf8.encode(name),
    0,
    ...utf8.encode(origin),
    0,
    ...utf8.encode(source),
  ];
  return sha256.convert(bytes).toString();
}

String _mintNonce() {
  final r = Random.secure();
  return List<int>.generate(16, (_) => r.nextInt(256))
      .map((b) => b.toRadixString(16).padLeft(2, '0'))
      .join();
}

String _canonicalBody({
  required String id,
  required String name,
  required String origin,
  required String bundle,
  String? n,
}) {
  final body = <String, Object>{
    'v': 1,
    'id': id,
    'name': name,
    'origin': origin,
    'bundle': bundle,
  };
  if (n != null && n.isNotEmpty) body['n'] = n;
  return jsonEncode(body);
}

String _macOf(String body) {
  final h = sha256.convert(utf8.encode(vortexPersonal) + utf8.encode(body)).bytes;
  return h.take(20).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

String _b64url(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

List<int>? _b64urlDecode(String s) {
  var t = s.replaceAll('-', '+').replaceAll('_', '/');
  final pad = t.length % 4;
  if (pad == 1) return null;
  if (pad != 0) t = t.padRight(t.length + (4 - pad), '=');
  try {
    return base64.decode(t);
  } catch (_) {
    return null;
  }
}

String? mintVorticeDeployKey({
  required String programId,
  required String origin,
  required String source,
  String? name,
}) {
  final id = validProgramId(programId);
  final url = validOrigin(origin);
  if (id == null || url == null) return null;
  final label = (name ?? id).trim();
  if (label.isEmpty || label.length > 64) return null;
  final bundle = vorticeBundleHash(programId: id, name: label, origin: url, source: source);
  final n = _mintNonce();
  final body = _canonicalBody(id: id, name: label, origin: url, bundle: bundle, n: n);
  final payload = jsonEncode({
    'v': 1,
    'id': id,
    'name': label,
    'origin': url,
    'bundle': bundle,
    'n': n,
    'mac': _macOf(body),
  });
  return '$vorticeKeyPrefix${_b64url(utf8.encode(payload))}';
}

String? issueVorticeKey(String programId, {String? origin, String source = ''}) {
  if (origin == null || origin.isEmpty) return null;
  return mintVorticeDeployKey(programId: programId, origin: origin, source: source);
}

Vortice? parseVorticeKey(String key) {
  final raw = key.trim();
  if (!raw.startsWith(vorticeKeyPrefix)) return null;
  final bytes = _b64urlDecode(raw.substring(vorticeKeyPrefix.length));
  if (bytes == null) return null;
  try {
    final payload = jsonDecode(utf8.decode(bytes));
    if (payload is! Map) return null;
    final id = validProgramId(payload['id']?.toString() ?? '');
    final origin = validOrigin(payload['origin']?.toString() ?? '');
    final name = payload['name']?.toString() ?? '';
    final bundle = payload['bundle']?.toString() ?? '';
    final mac = (payload['mac']?.toString() ?? '').toLowerCase();
    final n = payload['n']?.toString() ?? '';
    if (n.isNotEmpty && !RegExp(r'^[0-9a-f]{32}$', caseSensitive: false).hasMatch(n)) {
      return null;
    }
    if (id == null || origin == null || bundle.isEmpty || name.isEmpty || name.length > 64) {
      return null;
    }
    final want = _macOf(_canonicalBody(
      id: id,
      name: name,
      origin: origin,
      bundle: bundle,
      n: n.isEmpty ? null : n,
    ));
    if (want != mac) return null;
    return Vortice(id: id, name: name, origin: origin, bundle: bundle);
  } catch (_) {
    return null;
  }
}

Vortice? verifyVorticeDownload(String key, String source) {
  final parsed = parseVorticeKey(key);
  if (parsed == null || parsed.origin == null || parsed.bundle == null) return null;
  final bundle = vorticeBundleHash(
    programId: parsed.id,
    name: parsed.name,
    origin: parsed.origin!,
    source: source,
  );
  if (bundle != parsed.bundle) return null;
  return Vortice(
    id: parsed.id,
    name: parsed.name,
    origin: parsed.origin,
    bundle: bundle,
    source: source,
  );
}

/// Enable only after the hosted dapp has been downloaded and the bundle matches.
List<Vortice> addVortice(List<Vortice> list, String key, {String? source}) {
  if (source == null) return list;
  final got = verifyVorticeDownload(key, source);
  if (got == null) return list;
  if (list.any((v) => v.id == got.id)) return list;
  return [...list, got];
}

List<Vortice> deployVortice(List<Vortice> list, Vortice v) {
  if (v.id.isEmpty || isPinnedProgram(v.id)) return list;
  if (list.any((x) => x.id == v.id)) return list;
  return [...list, v];
}

Future<Vortice?> downloadVorticeFromOrigin(
  String key, {
  HttpClient? http,
  String? source,
}) async {
  if (source != null) return verifyVorticeDownload(key, source);
  final parsed = parseVorticeKey(key);
  if (parsed == null || parsed.origin == null) return null;
  final client = http ?? HttpClient();
  try {
    final req = await client.getUrl(Uri.parse(parsed.origin!));
    final res = await req.close();
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    final body = await utf8.decodeStream(res);
    return verifyVorticeDownload(key, body);
  } catch (_) {
    return null;
  }
}
