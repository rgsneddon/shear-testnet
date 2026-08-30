import 'dart:io';

import 'package:path/path.dart' as p;

import 'shear_shewall.dart';

/// User-visible dest for Export shewall.bin. Never Directory.systemTemp alone.
File defaultShewallExportFile({
  String? home,
  String? userProfile,
  bool Function(String path)? existsDir,
}) {
  bool has(String path) =>
      existsDir != null ? existsDir(path) : Directory(path).existsSync();

  if (Platform.isWindows) {
    final root = userProfile ?? Platform.environment['USERPROFILE'] ?? '.';
    final dl = p.join(root, 'Downloads');
    if (has(dl)) return File(p.join(dl, shewallName));
    return File(p.join(root, 'Documents', shewallName));
  }
  if (Platform.isAndroid) {
    const pub = '/storage/emulated/0/Download';
    if (has(pub)) return File(p.join(pub, shewallName));
    return File(p.join('/data/user/0/com.shear.shear_wallet/files', shewallName));
  }
  final h = home ?? Platform.environment['HOME'] ?? '.';
  if (Platform.isIOS) {
    return File(p.join(h, 'Documents', shewallName));
  }
  final dl = p.join(h, 'Downloads');
  if (has(dl)) return File(p.join(dl, shewallName));
  return File(p.join(h, 'Documents', shewallName));
}

bool isTempOnlyShewallPath(String path) {
  final tmp = Directory.systemTemp.path;
  return p.equals(path, p.join(tmp, shewallName));
}
