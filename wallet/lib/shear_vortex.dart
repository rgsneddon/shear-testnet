import 'dart:convert';

import 'package:crypto/crypto.dart';

const vortexPersonal = 'chronoflux-Omega-v1';
const reserveProgram = 'shear-reserve-v1';

class Vortice {
  const Vortice({required this.id, required this.name, this.pinned = false});
  final String id;
  final String name;
  final bool pinned;

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'pinned': pinned};

  factory Vortice.fromJson(Map<String, dynamic> j) => Vortice(
        id: j['id']?.toString() ?? '',
        name: j['name']?.toString() ?? '',
        pinned: j['pinned'] == true,
      );
}

const reserveVortice = Vortice(id: reserveProgram, name: 'The Reserve', pinned: true);

String? issueVorticeKey(String programId) {
  final id = programId.trim().toLowerCase();
  if (!RegExp(r'^[a-z0-9._-]{3,64}$').hasMatch(id)) return null;
  if (id == reserveProgram) return null;
  final h = sha256.convert(utf8.encode(vortexPersonal) + utf8.encode(id)).bytes;
  final hex = h.take(20).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '$hex.$id';
}

Vortice? parseVorticeKey(String key) {
  final m = RegExp(r'^([0-9a-f]{40})\.([a-z0-9._-]{3,64})$', caseSensitive: false).firstMatch(key.trim());
  if (m == null) return null;
  final id = m.group(2)!.toLowerCase();
  if (id == reserveProgram) return null;
  final want = issueVorticeKey(id);
  if (want == null || want.split('.').first != m.group(1)!.toLowerCase()) return null;
  return Vortice(id: id, name: id);
}

List<Vortice> addVortice(List<Vortice> list, String key) {
  final parsed = parseVorticeKey(key);
  if (parsed == null) return list;
  if (list.any((v) => v.id == parsed.id)) return list;
  return [...list, parsed];
}
