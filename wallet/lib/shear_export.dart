import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:path/path.dart' as p;

import 'shear_shewall.dart';

/// User-visible dest for Export shewall.bin. Never Directory.systemTemp alone.
/// Android public Download is not used: targetSdk 34+ EACCES. Use [saveShewallBytes]
/// (SAF) instead.
File? defaultShewallExportFile({
  String? home,
  String? userProfile,
  bool Function(String path)? existsDir,
  bool? android,
  bool? windows,
  bool? ios,
}) {
  final isAndroid = android ?? Platform.isAndroid;
  if (isAndroid) return null;

  bool has(String path) =>
      existsDir != null ? existsDir(path) : Directory(path).existsSync();

  final isWindows = windows ?? Platform.isWindows;
  if (isWindows) {
    final root = userProfile ?? Platform.environment['USERPROFILE'] ?? '.';
    final dl = p.join(root, 'Downloads');
    if (has(dl)) return File(p.join(dl, shewallName));
    return File(p.join(root, 'Documents', shewallName));
  }
  final h = home ?? Platform.environment['HOME'] ?? '.';
  final isIos = ios ?? Platform.isIOS;
  if (isIos) {
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

bool isPrivateAndroidFilesPath(String path) {
  return path.contains('/data/user/0/') || path.contains('/data/data/');
}

/// Writes sealed bytes to [dest], or opens a user save dialog (SAF on Android).
Future<String> saveShewallBytes(
  Uint8List sealed, {
  File? dest,
  Future<String?> Function(Uint8List bytes)? picker,
}) async {
  if (dest != null) {
    dest.parent.createSync(recursive: true);
    dest.writeAsBytesSync(sealed);
    return dest.path;
  }
  final pick = picker ??
      ((bytes) => FilePicker.platform.saveFile(
            dialogTitle: 'Export shewall.bin',
            fileName: shewallName,
            bytes: bytes,
          ));
  final path = await pick(sealed);
  if (path == null || path.isEmpty) {
    throw const FormatException('export_cancelled');
  }
  final f = File(path);
  if (!f.existsSync() || f.lengthSync() == 0) {
    f.parent.createSync(recursive: true);
    f.writeAsBytesSync(sealed);
  }
  return path;
}

Future<File?> pickShewallImportFile({
  Future<String?> Function()? picker,
}) async {
  if (picker != null) {
    final path = await picker();
    if (path == null || path.isEmpty) return null;
    return File(path);
  }
  final r = await FilePicker.platform.pickFiles(
    dialogTitle: 'Import shewall.bin',
    type: FileType.any,
    allowMultiple: false,
  );
  final path = r?.files.single.path;
  if (path == null || path.isEmpty) return null;
  return File(path);
}
