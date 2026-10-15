import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:path/path.dart' as p;

import 'shear_shewall.dart';
import 'shear_shewall_acl.dart';

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

/// file_picker 8.x: Android/iOS [saveFile] requires [bytes]. Desktop (macOS)
/// throws [UnsupportedError] if [bytes] is set; the dialog only returns a path.
///
/// Mobile export passes those bytes into file_picker. The plugin writes the
/// file. That path is not covered by [writePrivateShewallSync]: there is no
/// mode 0600 and no owner-only DACL. Desktop, and an explicit [dest], use the
/// private replace.
bool shewallSavePassesBytes({bool? android, bool? ios}) {
  return (android ?? Platform.isAndroid) || (ios ?? Platform.isIOS);
}

/// Production save dialog. Do not pass [bytes] on desktop.
Future<String?> defaultShewallSavePicker({Uint8List? bytes}) {
  return FilePicker.platform.saveFile(
    dialogTitle: 'Export shewall.bin',
    fileName: shewallName,
    bytes: bytes,
  );
}

/// Writes sealed bytes to [dest], or opens a user save dialog (SAF on Android).
/// Desktop: dialog returns a path; always write (overwrite). Never pass bytes
/// to [saveFile] on macOS/Windows/Linux.
///
/// Mobile (`passBytes`, the Android and iOS default) gives the sealed bytes to
/// file_picker and does not run the private replace. A picked folder, Downloads,
/// Documents, and the CLI working directory are not chmod'd or given a directory
/// DACL. Pass [applicationSupport] only so a dest inside
/// `applicationSupport/shear` can tighten that app-owned directory.
Future<String> saveShewallBytes(
  Uint8List sealed, {
  File? dest,
  Future<String?> Function({Uint8List? bytes})? picker,
  bool? passBytes,
  String? applicationSupport,
}) async {
  if (dest != null) {
    await writeShewallOffUi(
      dest.path,
      sealed,
      applicationSupport: applicationSupport,
    );
    return dest.path;
  }
  final sendBytes = passBytes ?? shewallSavePassesBytes();
  final pick = picker ?? defaultShewallSavePicker;
  final path = await pick(bytes: sendBytes ? sealed : null);
  if (path == null || path.isEmpty) {
    throw const FormatException('export_cancelled');
  }
  if (!sendBytes) {
    await writeShewallOffUi(
      path,
      sealed,
      applicationSupport: applicationSupport,
    );
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
