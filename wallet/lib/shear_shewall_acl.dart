import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:path/path.dart' as p;

/// Private replace of `shewall.bin`.
///
/// The bytes land in a temp file in the same directory, that file is fsynced,
/// then it is renamed over the destination. A crash before the rename leaves
/// the previous wallet file in place.
///
/// The file is always private: mode 0600 outside Windows, and an owner-only
/// DACL on Windows. The directory is tightened only when it is the app-owned
/// folder [shewallAppDirectory] (`getApplicationSupportDirectory()/shear`).
/// Downloads, Documents, a picked folder, and the CLI working directory are
/// left alone.
///
/// A symlink at the destination, or on any path component, is refused.
/// `chmod` of `/` or of the shared system temp directory is refused.
///
/// On Windows the file DACL is the current user, SYSTEM (`S-1-5-18`), and
/// Administrators (`S-1-5-32-544`), with the user as owner. The file is
/// created with that descriptor. The user SID comes from `GetTokenInformation`
/// (`TokenUser`), not from `whoami`. `icacls.exe` comes from
/// `GetSystemDirectoryW`, and that directory must equal the HKLM `SystemRoot`
/// value plus `\System32`. A mismatch, including a planted
/// `C:\Windows\System32` when Windows lives on another drive, refuses the
/// write. The process environment is not consulted and is not passed to
/// `icacls` (`includeParentEnvironment: false`). The DACL is read back with
/// `icacls /save`, not PowerShell. A mismatch throws before the rename.
///
/// Android and iOS export that hands the bytes to `file_picker` is not covered
/// by this writer. The plugin owns that file.
///
/// This follows `node/src/datadir_acl.js` (PR 96) for the trustees and the
/// icacls grant shape. `/T` is not used.
const shewallFileMode = 0x180; // 0600
const shewallDirMode = 0x1c0; // 0700
const _modeMask = 0x1ff;

/// Folder under `getApplicationSupportDirectory()` whose mode or DACL is set.
const shewallAppFolder = 'shear';

const systemSid = 'S-1-5-18';
const administratorsSid = 'S-1-5-32-544';

const shewallAclSymlink = 'shewall_acl:symlink';
const shewallAclChmod = 'shewall_acl:chmod';
const shewallAclDacl = 'shewall_acl:dacl';
const shewallAclToken = 'shewall_acl:token';
const shewallAclIcacls = 'shewall_acl:icacls';
const shewallAclSystem32 = 'shewall_acl:system32';
const shewallAclFsync = 'shewall_acl:fsync';
const shewallAclIoError = 'shewall_acl:io';
const shewallAclDir = 'shewall_acl:dir';

/// Stamp of the isolate that last ran [writeShewallOffUi]. Differs from the UI isolate.
String debugShewallWriteStamp = '';

typedef ShewallProc =
    String Function(
      String executable,
      List<String> args, {
      Map<String, String>? environment,
      bool includeParentEnvironment,
    });

typedef ShewallChmod = void Function(String path, int mode);

typedef ShewallSecureCreate =
    void Function(String path, Uint8List bytes, String sddl);

/// Test seam. Production leaves every field null and uses the host.
final class ShewallAclIo {
  const ShewallAclIo({
    this.windows,
    this.run,
    this.system32Verified,
    this.chmod,
    this.systemDirectory,
    this.registrySystemRoot,
    this.readOwner,
    this.readUserSid,
    this.createOwnerOnly,
    this.env = const {},
  });

  final bool? windows;
  final ShewallProc? run;
  final bool Function(String absoluteExe)? system32Verified;
  final ShewallChmod? chmod;

  /// `GetSystemDirectoryW`. Null uses the real API, and only on Windows.
  final String Function()? systemDirectory;

  /// HKLM `SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRoot`.
  /// Null uses the real registry, and only on Windows.
  final String Function()? registrySystemRoot;

  /// Owner SID read. Null uses `GetNamedSecurityInfoW` on Windows.
  final String Function(String path)? readOwner;

  /// Current-user SID. Null uses `GetTokenInformation` on Windows.
  final String Function()? readUserSid;

  /// Creates [path] with an owner-only descriptor and writes [bytes].
  /// Null uses `CreateFileW` on Windows.
  final ShewallSecureCreate? createOwnerOnly;

  /// Caller environment. It is never copied into a child process. A test
  /// plants `SystemRoot` and `PSModulePath` here.
  final Map<String, String> env;

  bool get isWindows => windows ?? Platform.isWindows;
}

/// `getApplicationSupportDirectory()/shear`. Only this directory is tightened.
///
/// No production caller passes this path yet. `main.dart:825` and
/// `shear_session.dart:608` write only to a destination the user picks.
/// Moving the default `shewall.bin` into this folder is future work and needs
/// a migration.
String shewallAppDirectory(String applicationSupport) {
  return p.normalize(p.absolute(p.join(applicationSupport, shewallAppFolder)));
}

/// True when [parent] is exactly [shewallAppDirectory]. A folder the user
/// picked, including one named `shear` somewhere else, is not app-owned.
bool shewallParentIsAppOwned(String parent, {String? applicationSupport}) {
  if (applicationSupport == null || applicationSupport.isEmpty) return false;
  final app = shewallAppDirectory(applicationSupport);
  final dir = p.normalize(p.absolute(parent));
  return p.equals(dir, app);
}

/// Owner-only file SDDL. [sid] must already be a SID, not an account name.
///
/// No space between the owner and the DACL. `ConvertStringSecurityDescriptorToSecurityDescriptorW`
/// rejects `O:<sid> D:P...` and the file is never created.
String ownerOnlyFileSddl(String sid) {
  if (!RegExp(r'^S-1-\d+(?:-\d+)+$', caseSensitive: false).hasMatch(sid)) {
    throw const FormatException(shewallAclToken);
  }
  return 'O:${sid}D:P(A;;FA;;;$sid)(A;;FA;;;$systemSid)(A;;FA;;;$administratorsSid)';
}

/// Linux `open` flags. x86 keeps the arch values. arm64 uses the generic ones.
({int nofollow, int directory}) linuxOpenFlags(Abi abi) {
  switch (abi) {
    case Abi.linuxX64:
    case Abi.linuxIA32:
    case Abi.androidX64:
    case Abi.androidIA32:
      return (nofollow: 0x20000, directory: 0x10000);
    case Abi.linuxArm64:
    case Abi.linuxArm:
    case Abi.androidArm64:
    case Abi.androidArm:
    case Abi.linuxRiscv64:
    case Abi.linuxRiscv32:
    case Abi.androidRiscv64:
      return (nofollow: 0x8000, directory: 0x4000);
    default:
      throw const FormatException(shewallAclIoError);
  }
}

/// Byte offset of `st_mode` in glibc `struct stat`.
/// x86_64 stores `st_nlink` before `st_mode` (offset 24). arm64 stores
/// `st_mode` at offset 16.
int linuxStatModeOffset(Abi abi) {
  switch (abi) {
    case Abi.linuxX64:
    case Abi.androidX64:
      return 24;
    case Abi.linuxArm64:
    case Abi.linuxArm:
    case Abi.androidArm64:
    case Abi.androidArm:
    case Abi.linuxRiscv64:
    case Abi.linuxRiscv32:
    case Abi.androidRiscv64:
      return 16;
    default:
      throw const FormatException(shewallAclIoError);
  }
}

/// `_STAT_VER` passed to `__fxstat`. x86_64 uses `_STAT_VER_LINUX` (1).
/// arm64 uses `_STAT_VER_KERNEL` (0).
int linuxFstatVersion(Abi abi) {
  switch (abi) {
    case Abi.linuxX64:
    case Abi.linuxIA32:
    case Abi.androidX64:
    case Abi.androidIA32:
      return 1;
    case Abi.linuxArm64:
    case Abi.linuxArm:
    case Abi.androidArm64:
    case Abi.androidArm:
    case Abi.linuxRiscv64:
    case Abi.linuxRiscv32:
    case Abi.androidRiscv64:
      return 0;
    default:
      throw const FormatException(shewallAclIoError);
  }
}

/// `fstat` was not a dynamic libc symbol before glibc 2.33. Prefer it, then
/// `__fxstat64` / `__fxstat`. Null means the caller must use [FileStat].
String? selectLinuxFstatSymbol(bool Function(String name) present) {
  if (present('fstat')) return 'fstat';
  if (present('__fxstat64')) return '__fxstat64';
  if (present('__fxstat')) return '__fxstat';
  return null;
}

/// Mode word from a `struct stat` buffer. Apple is a 16-bit field at offset 4.
int statModeAt(List<int> bytes, {required Abi abi, bool apple = false}) {
  final data = ByteData.sublistView(Uint8List.fromList(bytes));
  if (apple) return data.getUint16(4, Endian.host);
  return data.getUint32(linuxStatModeOffset(abi), Endian.host);
}

/// Join [name] onto a system directory that [resolveWindowsSystem32] accepted.
String system32Exe(String name, String systemDirectory) {
  if (name != 'icacls.exe') {
    throw const FormatException(shewallAclSystem32);
  }
  final dir = _normalizeWin(systemDirectory);
  if (!_absoluteWin(dir) || _hasDotDot(dir)) {
    throw const FormatException(shewallAclSystem32);
  }
  final full = '$dir\\$name';
  if (full.toLowerCase() != '${dir.toLowerCase()}\\$name') {
    throw const FormatException(shewallAclSystem32);
  }
  return full;
}

/// Fail closed unless `GetSystemDirectoryW` is exactly `SystemRoot\System32`.
String resolveWindowsSystem32({
  required String systemDirectory,
  required String registrySystemRoot,
}) {
  final api = _normalizeWin(systemDirectory);
  final root = _normalizeWin(registrySystemRoot);
  if (!_absoluteWin(api) || !_absoluteWin(root)) {
    throw const FormatException(shewallAclSystem32);
  }
  if (_hasDotDot(api) || _hasDotDot(root)) {
    throw const FormatException(shewallAclSystem32);
  }
  final expected = '$root\\System32';
  if (api.toLowerCase() != expected.toLowerCase()) {
    throw const FormatException(shewallAclSystem32);
  }
  return api;
}

/// True when [sddl] is an owner-only DACL for [ownerSid] plus SYSTEM and
/// Administrators. Aliases `SY` and `BA` count as those SIDs.
bool shewallDaclIsOwnerOnly(
  String sddl, {
  required String ownerSid,
  required bool directory,
}) {
  try {
    _expectDacl(sddl, ownerSid: ownerSid, directory: directory);
    return true;
  } on FormatException {
    return false;
  }
}

void writePrivateShewallSync(
  File dest,
  Uint8List sealed, {
  ShewallAclIo io = const ShewallAclIo(),
  String? applicationSupport,
}) {
  if (sealed.isNotEmpty && sealed[0] == 0x7b) {
    throw const FormatException('json_refused');
  }
  final parent = p.normalize(p.absolute(dest.parent.path));
  final name = p.basename(dest.path);
  _rejectLeafName(name);
  _ensureParent(parent, io);
  final full = p.join(parent, name);
  if (FileSystemEntity.typeSync(full, followLinks: false) ==
      FileSystemEntityType.link) {
    throw const FormatException(shewallAclSymlink);
  }
  final hardenDirectory = shewallParentIsAppOwned(
    parent,
    applicationSupport: applicationSupport,
  );
  if (io.isWindows) {
    _windowsReplace(full, parent, sealed, io, hardenDirectory: hardenDirectory);
    return;
  }
  _posixReplace(
    full,
    name,
    parent,
    sealed,
    io,
    hardenDirectory: hardenDirectory,
  );
}

Map<String, String> _writeShewallOffUi(
  String path,
  Uint8List sealed,
  String? applicationSupport,
) {
  writePrivateShewallSync(
    File(path),
    sealed,
    applicationSupport: applicationSupport,
  );
  return {'stamp': identityHashCode(Isolate.current).toString()};
}

/// Runs [writePrivateShewallSync] on a worker isolate.
Future<void> writeShewallOffUi(
  String path,
  Uint8List sealed, {
  String? applicationSupport,
}) async {
  final out = await Isolate.run(
    () => _writeShewallOffUi(path, sealed, applicationSupport),
  );
  debugShewallWriteStamp = out['stamp'] ?? '';
}

void _rejectLeafName(String name) {
  if (name.isEmpty ||
      name == '.' ||
      name == '..' ||
      name.contains('/') ||
      name.contains(r'\')) {
    throw const FormatException(shewallAclDir);
  }
}

void _ensureParent(String parent, ShewallAclIo io) {
  _rejectUnsafeParent(parent);
  final parts = p.split(parent);
  if (parts.length < 2) throw const FormatException(shewallAclDir);
  var current = parts.first;
  for (var i = 1; i < parts.length; i++) {
    current = p.join(current, parts[i]);
    final type = FileSystemEntity.typeSync(current, followLinks: false);
    if (type == FileSystemEntityType.link) {
      throw const FormatException(shewallAclSymlink);
    }
    if (type == FileSystemEntityType.notFound) {
      Directory(current).createSync(recursive: false);
      final created = FileSystemEntity.typeSync(current, followLinks: false);
      if (created != FileSystemEntityType.directory) {
        throw const FormatException(shewallAclSymlink);
      }
    } else if (type != FileSystemEntityType.directory) {
      throw const FormatException(shewallAclDir);
    }
  }
}

void _rejectUnsafeParent(String parent) {
  final norm = p.normalize(p.absolute(parent));
  final root = p.rootPrefix(norm);
  if (root.isNotEmpty && p.equals(norm, root)) {
    throw const FormatException(shewallAclDir);
  }
  if (norm == '/' || norm == r'\') throw const FormatException(shewallAclDir);
  final tmp = p.normalize(p.absolute(Directory.systemTemp.path));
  if (p.equals(norm, tmp)) throw const FormatException(shewallAclDir);
}

void _posixReplace(
  String full,
  String name,
  String parent,
  Uint8List sealed,
  ShewallAclIo io, {
  required bool hardenDirectory,
}) {
  final posix = _posixFiles();
  final dirfd = posix.openDirectory(parent);
  var filefd = -1;
  var tmp = '';
  var renamed = false;
  try {
    if (hardenDirectory) {
      _chmodFd(posix, io, dirfd, parent, shewallDirMode);
    }
    tmp = '.shewall.$pid.${Random.secure().nextInt(0x7fffffff)}.tmp';
    filefd = posix.openExclusive(dirfd, tmp);
    posix.writeAll(filefd, sealed);
    _chmodFd(posix, io, filefd, p.join(parent, tmp), shewallFileMode);
    if (posix.fsync(filefd) != 0) throw const FormatException(shewallAclFsync);
    if (FileSystemEntity.typeSync(full, followLinks: false) ==
        FileSystemEntityType.link) {
      throw const FormatException(shewallAclSymlink);
    }
    if (posix.renameAt(dirfd, tmp, name) != 0) {
      throw const FormatException(shewallAclIoError);
    }
    renamed = true;
    // Directory fsync failure is not fatal. book_snap.js treats it the same
    // way: the file fsync already finished, and some filesystems reject it.
    posix.fsync(dirfd);
    final mode = posix.fstatMode(filefd);
    if (mode != null) {
      if ((mode & 0xF000) == 0xA000) {
        throw const FormatException(shewallAclSymlink);
      }
      if ((mode & _modeMask) != shewallFileMode) {
        throw const FormatException(shewallAclChmod);
      }
    }
    if (FileSystemEntity.typeSync(full, followLinks: false) !=
        FileSystemEntityType.file) {
      throw const FormatException(shewallAclSymlink);
    }
    if ((FileStat.statSync(full).mode & _modeMask) != shewallFileMode) {
      throw const FormatException(shewallAclChmod);
    }
  } catch (_) {
    if (!renamed && tmp.isNotEmpty) posix.unlinkAt(dirfd, tmp);
    rethrow;
  } finally {
    if (filefd >= 0) posix.close(filefd);
    if (dirfd >= 0) posix.close(dirfd);
  }
}

void _chmodFd(
  _PosixFiles posix,
  ShewallAclIo io,
  int fd,
  String path,
  int mode,
) {
  if (io.chmod != null) {
    io.chmod!(path, mode);
  } else if (posix.fchmod(fd, mode) != 0) {
    throw const FormatException(shewallAclChmod);
  }
  if (FileSystemEntity.typeSync(path, followLinks: false) ==
      FileSystemEntityType.link) {
    throw const FormatException(shewallAclSymlink);
  }
  final viaFd = posix.fstatMode(fd);
  if (viaFd != null && (viaFd & _modeMask) != mode) {
    throw const FormatException(shewallAclChmod);
  }
  final viaPath = FileStat.statSync(path).mode & _modeMask;
  if (viaPath != mode) {
    throw const FormatException(shewallAclChmod);
  }
}

void _windowsReplace(
  String full,
  String parent,
  Uint8List sealed,
  ShewallAclIo io, {
  required bool hardenDirectory,
}) {
  final system32 = _resolvedSystem32(io);
  final childEnv = _fixedChildEnv(system32, io);
  final sid = _readUserSid(io);
  if (hardenDirectory) {
    _applyDacl(
      io,
      parent,
      directory: true,
      sid: sid,
      system32: system32,
      childEnv: childEnv,
    );
  }
  final tmpName = '.shewall.$pid.${Random.secure().nextInt(0x7fffffff)}.tmp';
  final tmpPath = p.join(parent, tmpName);
  if (FileSystemEntity.typeSync(tmpPath, followLinks: false) ==
      FileSystemEntityType.link) {
    throw const FormatException(shewallAclSymlink);
  }
  final tmp = File(tmpPath);
  var renamed = false;
  try {
    final descriptor = ownerOnlyFileSddl(sid);
    if (io.createOwnerOnly != null) {
      io.createOwnerOnly!(tmpPath, sealed, descriptor);
    } else {
      _createOwnerOnlyWin32(tmpPath, sealed, descriptor);
    }
    _applyDacl(
      io,
      tmpPath,
      directory: false,
      sid: sid,
      system32: system32,
      childEnv: childEnv,
    );
    if (FileSystemEntity.typeSync(full, followLinks: false) ==
        FileSystemEntityType.link) {
      throw const FormatException(shewallAclSymlink);
    }
    tmp.renameSync(full);
    renamed = true;
    _expectReadBack(
      io,
      full,
      directory: false,
      sid: sid,
      system32: system32,
      childEnv: childEnv,
    );
  } catch (_) {
    if (!renamed && tmp.existsSync()) {
      final type = FileSystemEntity.typeSync(tmpPath, followLinks: false);
      if (type == FileSystemEntityType.file) {
        try {
          tmp.deleteSync();
        } catch (_) {}
      }
    }
    rethrow;
  }
}

String _resolvedSystem32(ShewallAclIo io) {
  final api = io.systemDirectory != null
      ? io.systemDirectory!()
      : _liveSystemDirectory();
  final reg = io.registrySystemRoot != null
      ? io.registrySystemRoot!()
      : _liveRegistrySystemRoot();
  return resolveWindowsSystem32(systemDirectory: api, registrySystemRoot: reg);
}

String _liveSystemDirectory() {
  if (!Platform.isWindows) throw const FormatException(shewallAclSystem32);
  return _getSystemDirectoryW();
}

String _liveRegistrySystemRoot() {
  if (!Platform.isWindows) throw const FormatException(shewallAclSystem32);
  return _registrySystemRoot();
}

Map<String, String> _fixedChildEnv(String system32, ShewallAclIo io) {
  final dir = _normalizeWin(system32);
  const suffix = r'\system32';
  if (!dir.toLowerCase().endsWith(suffix)) {
    throw const FormatException(shewallAclSystem32);
  }
  final root = dir.substring(0, dir.length - suffix.length);
  if (root.length < 2) throw const FormatException(shewallAclSystem32);
  final child = <String, String>{
    'SystemRoot': root,
    'WINDIR': root,
    'SystemDrive': root.substring(0, 2),
  };
  for (final key in child.keys) {
    if (key.toLowerCase() == 'psmodulepath') {
      throw const FormatException(shewallAclSystem32);
    }
  }
  for (final entry in io.env.entries) {
    final key = entry.key.toLowerCase();
    if (key == 'psmodulepath' &&
        (child.containsKey(entry.key) || child.values.contains(entry.value))) {
      throw const FormatException(shewallAclSystem32);
    }
    if ((key == 'systemroot' || key == 'windir') &&
        _normalizeWin(entry.value).toLowerCase() != root.toLowerCase() &&
        child.values.any(
          (value) =>
              _normalizeWin(value).toLowerCase() ==
              _normalizeWin(entry.value).toLowerCase(),
        )) {
      throw const FormatException(shewallAclSystem32);
    }
  }
  return child;
}

String _readUserSid(ShewallAclIo io) {
  late final String sid;
  try {
    sid = io.readUserSid != null ? io.readUserSid!() : _tokenUserSid();
  } on FormatException {
    rethrow;
  } catch (_) {
    throw const FormatException(shewallAclToken);
  }
  if (!RegExp(r'^S-1-\d+(?:-\d+)+$', caseSensitive: false).hasMatch(sid)) {
    throw const FormatException(shewallAclToken);
  }
  return sid;
}

void _applyDacl(
  ShewallAclIo io,
  String path, {
  required bool directory,
  required String sid,
  required String system32,
  required Map<String, String> childEnv,
}) {
  final icacls = system32Exe('icacls.exe', system32);
  String ace(String trustee) =>
      directory ? '*$trustee:(OI)(CI)F' : '*$trustee:F';
  // No /T. The node walks its private datadir. This file may sit in a
  // directory the user shares with other documents. /L does not follow a link.
  _runChecked(
    io,
    icacls,
    [
      path,
      '/inheritance:r',
      '/grant:r',
      ace(sid),
      ace(systemSid),
      ace(administratorsSid),
      '/L',
    ],
    shewallAclIcacls,
    system32,
    childEnv,
  );
  _runChecked(
    io,
    icacls,
    [path, '/setowner', '*$sid', '/L'],
    shewallAclIcacls,
    system32,
    childEnv,
  );
  _expectReadBack(
    io,
    path,
    directory: directory,
    sid: sid,
    system32: system32,
    childEnv: childEnv,
  );
}

void _expectReadBack(
  ShewallAclIo io,
  String path, {
  required bool directory,
  required String sid,
  required String system32,
  required Map<String, String> childEnv,
}) {
  final icacls = system32Exe('icacls.exe', system32);
  final save = p.join(
    p.dirname(path),
    '.shewall-acl.$pid.${Random.secure().nextInt(0x7fffffff)}.txt',
  );
  try {
    _runChecked(
      io,
      icacls,
      [path, '/save', save, '/L'],
      shewallAclDacl,
      system32,
      childEnv,
    );
    final file = File(save);
    if (!file.existsSync()) throw const FormatException(shewallAclDacl);
    final owner = io.readOwner != null
        ? io.readOwner!(path)
        : _ownerSidWin32(path);
    final sddl = _composeSddl(_decodeIcacls(file.readAsBytesSync()), owner);
    _expectDacl(sddl, ownerSid: sid, directory: directory);
  } finally {
    final file = File(save);
    if (file.existsSync()) {
      try {
        file.deleteSync();
      } catch (_) {}
    }
  }
}

String _composeSddl(String text, String owner) {
  if (!RegExp(r'^S-1-\d+(?:-\d+)+$').hasMatch(owner)) {
    throw const FormatException(shewallAclDacl);
  }
  final start = text.indexOf('D:');
  if (start < 0) throw const FormatException(shewallAclDacl);
  var dacl = text.substring(start);
  final lineEnd = dacl.indexOf(RegExp(r'[\r\n]'));
  if (lineEnd >= 0) dacl = dacl.substring(0, lineEnd);
  return 'O:$owner${dacl.trim()}';
}

String _decodeIcacls(List<int> bytes) {
  if (bytes.length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE) {
    return _utf16le(bytes.sublist(2));
  }
  if (bytes.length >= 4 && bytes[1] == 0 && bytes[3] == 0) {
    return _utf16le(bytes);
  }
  return utf8.decode(bytes);
}

String _utf16le(List<int> bytes) {
  final units = <int>[];
  for (var i = 0; i + 1 < bytes.length; i += 2) {
    final unit = bytes[i] | (bytes[i + 1] << 8);
    if (unit == 0) break;
    units.add(unit);
  }
  return String.fromCharCodes(units);
}

String _runChecked(
  ShewallAclIo io,
  String executable,
  List<String> args,
  String code,
  String system32,
  Map<String, String> environment,
) {
  _assertSystem32(executable, system32, io);
  try {
    final runner = io.run ?? _defaultRun;
    return runner(
      executable,
      args,
      environment: environment,
      includeParentEnvironment: false,
    );
  } on FormatException {
    rethrow;
  } catch (_) {
    throw FormatException(code);
  }
}

String _defaultRun(
  String executable,
  List<String> args, {
  Map<String, String>? environment,
  bool includeParentEnvironment = true,
}) {
  if (environment == null || includeParentEnvironment) {
    throw const FormatException(shewallAclSystem32);
  }
  final result = Process.runSync(
    executable,
    args,
    environment: environment,
    includeParentEnvironment: false,
    stdoutEncoding: utf8,
    stderrEncoding: utf8,
  );
  if (result.exitCode != 0) {
    throw ProcessException(
      executable,
      args,
      '${result.stderr}',
      result.exitCode,
    );
  }
  return '${result.stdout}';
}

void _assertSystem32(String executable, String system32, ShewallAclIo io) {
  final exe = _normalizeWin(executable);
  final dir = _normalizeWin(system32);
  final name = exe.split(r'\').last.toLowerCase();
  if (name != 'icacls.exe') {
    throw const FormatException(shewallAclSystem32);
  }
  if (exe.toLowerCase() != '${dir.toLowerCase()}\\$name') {
    throw const FormatException(shewallAclSystem32);
  }
  final ok = io.system32Verified ?? _system32FileIsReal;
  if (!ok(exe)) throw const FormatException(shewallAclSystem32);
}

bool _system32FileIsReal(String path) {
  return FileSystemEntity.typeSync(path, followLinks: false) ==
      FileSystemEntityType.file;
}

String _normalizeWin(String value) {
  var text = value.trim().replaceAll('/', r'\');
  if (text.startsWith(r'\\?\')) text = text.substring(4);
  while (text.endsWith(r'\')) {
    text = text.substring(0, text.length - 1);
  }
  return text;
}

bool _absoluteWin(String value) {
  return RegExp(r'^[A-Za-z]:\\').hasMatch(value);
}

bool _hasDotDot(String value) {
  return value.split(r'\').any((part) => part == '..');
}

void _expectDacl(
  String raw, {
  required String ownerSid,
  required bool directory,
}) {
  final text = raw.replaceAll('\uFEFF', '').trim();
  final start = text.indexOf('O:');
  if (start < 0) throw const FormatException(shewallAclDacl);
  final sddl = text.substring(start).replaceAll(RegExp(r'\s+'), '');
  final header = RegExp(
    r'^O:(S-1-\d+(?:-\d+)+)(?:G:S-1-\d+(?:-\d+)+)?D:([A-Z]*)',
  ).firstMatch(sddl);
  if (header == null) throw const FormatException(shewallAclDacl);
  if (header.group(1) != ownerSid) throw const FormatException(shewallAclDacl);
  if (!header.group(2)!.contains('P')) {
    throw const FormatException(shewallAclDacl);
  }
  var body = sddl.substring(header.end);
  final sacl = RegExp(r'S:').firstMatch(body);
  if (sacl != null) body = body.substring(0, sacl.start);
  final aces = RegExp(
    r'\(([AD]);([^;]*);([^;]*);([^;]*);([^;]*);([^)]*)\)',
  ).allMatches(body).toList();
  if (body.replaceAll(RegExp(r'\([^)]*\)'), '').isNotEmpty) {
    throw const FormatException(shewallAclDacl);
  }
  if (aces.length != 3) throw const FormatException(shewallAclDacl);
  final want = <String>{ownerSid, systemSid, administratorsSid};
  final got = <String>{};
  for (final ace in aces) {
    final type = ace.group(1)!;
    final flags = ace.group(2)!.toUpperCase();
    final rights = ace.group(3)!.toUpperCase();
    final sid = _canonicalSid(ace.group(6)!);
    if (type != 'A') throw const FormatException(shewallAclDacl);
    if (rights != 'FA' && rights != '0X1F01FF') {
      throw const FormatException(shewallAclDacl);
    }
    if (flags.contains('ID')) throw const FormatException(shewallAclDacl);
    if (directory) {
      if (!flags.contains('OI') || !flags.contains('CI')) {
        throw const FormatException(shewallAclDacl);
      }
    } else if (flags.isNotEmpty) {
      throw const FormatException(shewallAclDacl);
    }
    if (!want.contains(sid) || !got.add(sid)) {
      throw const FormatException(shewallAclDacl);
    }
  }
  if (got.length != 3) throw const FormatException(shewallAclDacl);
}

String _canonicalSid(String raw) {
  switch (raw.toUpperCase()) {
    case 'SY':
      return systemSid;
    case 'BA':
      return administratorsSid;
    case 'WD':
      return 'S-1-1-0';
    case 'AU':
      return 'S-1-5-11';
    case 'BU':
      return 'S-1-5-32-545';
    default:
      return raw;
  }
}

_PosixFiles? _posix;

_PosixFiles _posixFiles() => _posix ??= _PosixFiles();

/// POSIX replace anchored on a directory fd so a swapped parent symlink is
/// not followed. `openat` is variadic; the mode word is passed as a fixed
/// fourth argument, which is the register the SysV and AAPCS64 ABIs use.
final class _PosixFiles {
  _PosixFiles() : _lib = _openLibc() {
    _openat = _lib
        .lookupFunction<
          Int32 Function(Int32, Pointer<Utf8>, Int32, Uint32),
          int Function(int, Pointer<Utf8>, int, int)
        >('openat');
    _write = _lib
        .lookupFunction<
          IntPtr Function(Int32, Pointer<Uint8>, IntPtr),
          int Function(int, Pointer<Uint8>, int)
        >('write');
    _fsync = _lib.lookupFunction<Int32 Function(Int32), int Function(int)>(
      'fsync',
    );
    _close = _lib.lookupFunction<Int32 Function(Int32), int Function(int)>(
      'close',
    );
    _fchmod = _lib
        .lookupFunction<Int32 Function(Int32, Uint32), int Function(int, int)>(
          'fchmod',
        );
    _fstat = _bindFstat(_lib);
    _renameat = _lib
        .lookupFunction<
          Int32 Function(Int32, Pointer<Utf8>, Int32, Pointer<Utf8>),
          int Function(int, Pointer<Utf8>, int, Pointer<Utf8>)
        >('renameat');
    _unlinkat = _lib
        .lookupFunction<
          Int32 Function(Int32, Pointer<Utf8>, Int32),
          int Function(int, Pointer<Utf8>, int)
        >('unlinkat');
    if (Platform.isMacOS || Platform.isIOS) {
      final err = _lib
          .lookupFunction<Pointer<Int32> Function(), Pointer<Int32> Function()>(
            '__error',
          );
      _errno = () => err().value;
    } else {
      final err = _lib
          .lookupFunction<Pointer<Int32> Function(), Pointer<Int32> Function()>(
            '__errno_location',
          );
      _errno = () => err().value;
    }
  }

  final DynamicLibrary _lib;
  late final int Function(int, Pointer<Utf8>, int, int) _openat;
  late final int Function(int, Pointer<Uint8>, int) _write;
  late final int Function(int) _fsync;
  late final int Function(int) _close;
  late final int Function(int, int) _fchmod;
  late final int Function(int, Pointer<Utf8>, int, Pointer<Utf8>) _renameat;
  late final int Function(int, Pointer<Utf8>, int) _unlinkat;
  late final int Function() _errno;
  int Function(int, Pointer<Uint8>)? _fstat;

  static const _eintr = 4;
  static const _eexist = 17;
  static const _enotdir = 20;
  static const _eloopLinux = 40;
  static const _eloopApple = 62;

  bool get _apple => Platform.isMacOS || Platform.isIOS;

  int get _oRdonly => 0;
  int get _oWronly => 1;
  int get _oCreat => _apple ? 0x200 : 0x40;
  int get _oExcl => _apple ? 0x800 : 0x80;
  int get _oNofollow => _apple ? 0x100 : linuxOpenFlags(Abi.current()).nofollow;
  int get _oCloexec => _apple ? 0x1000000 : 0x80000;
  int get _oDirectory =>
      _apple ? 0x100000 : linuxOpenFlags(Abi.current()).directory;
  int get _atFdcwd => _apple ? -2 : -100;

  int get errno => _errno();

  int openDirectory(String path) {
    final fd = _withPath(path, (raw) {
      return _openat(
        atFdcwd,
        raw,
        _oRdonly | _oDirectory | _oNofollow | _oCloexec,
        0,
      );
    });
    if (fd < 0) {
      final err = errno;
      if (err == _enotdir || err == _eloopLinux || err == _eloopApple) {
        throw const FormatException(shewallAclSymlink);
      }
      throw const FormatException(shewallAclIoError);
    }
    return fd;
  }

  int openExclusive(int dirfd, String name) {
    final fd = _withPath(name, (raw) {
      final flags = _oWronly | _oCreat | _oExcl | _oNofollow | _oCloexec;
      return _openat(dirfd, raw, flags, shewallFileMode);
    });
    if (fd < 0) {
      final err = errno;
      if (err == _eloopLinux || err == _eloopApple || err == _enotdir) {
        throw const FormatException(shewallAclSymlink);
      }
      if (err == _eexist) throw const FormatException(shewallAclIoError);
      throw const FormatException(shewallAclIoError);
    }
    return fd;
  }

  void writeAll(int fd, Uint8List bytes) {
    const chunk = 65536;
    final buf = malloc<Uint8>(chunk);
    try {
      var off = 0;
      while (off < bytes.length) {
        final take = bytes.length - off < chunk ? bytes.length - off : chunk;
        buf.asTypedList(take).setRange(0, take, bytes, off);
        var wrote = 0;
        while (wrote < take) {
          final n = _write(
            fd,
            Pointer<Uint8>.fromAddress(buf.address + wrote),
            take - wrote,
          );
          if (n < 0) {
            if (errno == _eintr) continue;
            throw const FormatException(shewallAclIoError);
          }
          if (n == 0) throw const FormatException(shewallAclIoError);
          wrote += n;
        }
        off += take;
      }
    } finally {
      malloc.free(buf);
    }
  }

  int fsync(int fd) {
    while (true) {
      final rc = _fsync(fd);
      if (rc == 0) return 0;
      if (errno == _eintr) continue;
      return rc;
    }
  }

  int fchmod(int fd, int mode) => _fchmod(fd, mode);

  int? fstatMode(int fd) {
    final read = _fstat;
    if (read == null) return null;
    final buf = calloc<Uint8>(256);
    try {
      final rc = read(fd, buf);
      if (rc != 0) throw const FormatException(shewallAclIoError);
      return statModeAt(
        buf.asTypedList(256),
        abi: Abi.current(),
        apple: _apple,
      );
    } finally {
      calloc.free(buf);
    }
  }

  int Function(int, Pointer<Uint8>)? _bindFstat(DynamicLibrary lib) {
    if (_apple) {
      return lib.lookupFunction<
        Int32 Function(Int32, Pointer<Uint8>),
        int Function(int, Pointer<Uint8>)
      >('fstat');
    }
    final symbol = selectLinuxFstatSymbol(lib.providesSymbol);
    if (symbol == null) return null;
    if (symbol == 'fstat') {
      return lib.lookupFunction<
        Int32 Function(Int32, Pointer<Uint8>),
        int Function(int, Pointer<Uint8>)
      >(symbol);
    }
    final fx = lib
        .lookupFunction<
          Int32 Function(Int32, Int32, Pointer<Uint8>),
          int Function(int, int, Pointer<Uint8>)
        >(symbol);
    final version = linuxFstatVersion(Abi.current());
    return (fd, buf) {
      var rc = fx(version, fd, buf);
      if (rc != 0 && errno == 22) {
        rc = fx(version == 0 ? 1 : 0, fd, buf);
      }
      return rc;
    };
  }

  int renameAt(int dirfd, String from, String to) {
    final fromRaw = from.toNativeUtf8();
    final toRaw = to.toNativeUtf8();
    try {
      return _renameat(dirfd, fromRaw, dirfd, toRaw);
    } finally {
      malloc.free(fromRaw);
      malloc.free(toRaw);
    }
  }

  void unlinkAt(int dirfd, String name) {
    _withPath(name, (raw) {
      _unlinkat(dirfd, raw, 0);
      return 0;
    });
  }

  void close(int fd) {
    if (fd < 0) return;
    _close(fd);
  }

  int _withPath(String value, int Function(Pointer<Utf8>) body) {
    final raw = value.toNativeUtf8();
    try {
      return body(raw);
    } finally {
      malloc.free(raw);
    }
  }

  int get atFdcwd => _atFdcwd;
}

DynamicLibrary _openLibc() {
  if (Platform.isMacOS || Platform.isIOS) {
    return DynamicLibrary.open('/usr/lib/libSystem.B.dylib');
  }
  for (final name in const ['libc.so.6', 'libc.so']) {
    try {
      return DynamicLibrary.open(name);
    } catch (_) {}
  }
  return DynamicLibrary.process();
}

String _getSystemDirectoryW() {
  final kernel = DynamicLibrary.open('kernel32.dll');
  final get = kernel
      .lookupFunction<
        Uint32 Function(Pointer<Utf16>, Uint32),
        int Function(Pointer<Utf16>, int)
      >('GetSystemDirectoryW');
  const cap = 260;
  final buf = calloc<Uint16>(cap);
  try {
    final written = get(buf.cast<Utf16>(), cap);
    if (written == 0 || written >= cap) {
      throw const FormatException(shewallAclSystem32);
    }
    return String.fromCharCodes(buf.asTypedList(written));
  } finally {
    calloc.free(buf);
  }
}

String _registrySystemRoot() {
  final adv = DynamicLibrary.open('advapi32.dll');
  final open = adv
      .lookupFunction<
        Int32 Function(IntPtr, Pointer<Utf16>, Uint32, Uint32, Pointer<IntPtr>),
        int Function(int, Pointer<Utf16>, int, int, Pointer<IntPtr>)
      >('RegOpenKeyExW');
  final query = adv
      .lookupFunction<
        Int32 Function(
          IntPtr,
          Pointer<Utf16>,
          Pointer<Uint32>,
          Pointer<Uint32>,
          Pointer<Uint8>,
          Pointer<Uint32>,
        ),
        int Function(
          int,
          Pointer<Utf16>,
          Pointer<Uint32>,
          Pointer<Uint32>,
          Pointer<Uint8>,
          Pointer<Uint32>,
        )
      >('RegQueryValueExW');
  final close = adv.lookupFunction<Int32 Function(IntPtr), int Function(int)>(
    'RegCloseKey',
  );
  // HKLM is sign-extended. A zero-extended 0x80000002 is the wrong handle.
  final hklm = 0x80000002.toSigned(32);
  const sam = 0x20019 | 0x0100;
  final sub = r'SOFTWARE\Microsoft\Windows NT\CurrentVersion'.toNativeUtf16();
  final value = 'SystemRoot'.toNativeUtf16();
  final phk = calloc<IntPtr>();
  try {
    if (open(hklm, sub, 0, sam, phk) != 0) {
      throw const FormatException(shewallAclSystem32);
    }
    final type = calloc<Uint32>();
    final size = calloc<Uint32>();
    try {
      final first = query(
        phk.value,
        value,
        Pointer<Uint32>.fromAddress(0),
        type,
        Pointer<Uint8>.fromAddress(0),
        size,
      );
      if ((first != 0 && first != 234) ||
          type.value != 1 ||
          size.value < 4 ||
          size.value > 1024) {
        throw const FormatException(shewallAclSystem32);
      }
      final data = calloc<Uint8>(size.value);
      try {
        final second = query(
          phk.value,
          value,
          Pointer<Uint32>.fromAddress(0),
          type,
          data,
          size,
        );
        if (second != 0 || type.value != 1) {
          throw const FormatException(shewallAclSystem32);
        }
        return _utf16le(data.asTypedList(size.value));
      } finally {
        calloc.free(data);
      }
    } finally {
      calloc.free(type);
      calloc.free(size);
      close(phk.value);
    }
  } finally {
    calloc.free(phk);
    malloc.free(sub);
    malloc.free(value);
  }
}

String _ownerSidWin32(String path) {
  if (!Platform.isWindows) throw const FormatException(shewallAclDacl);
  final adv = DynamicLibrary.open('advapi32.dll');
  final kernel = DynamicLibrary.open('kernel32.dll');
  final getNamed = adv
      .lookupFunction<
        Uint32 Function(
          Pointer<Utf16>,
          Uint32,
          Uint32,
          Pointer<Pointer<Void>>,
          Pointer<Pointer<Void>>,
          Pointer<Pointer<Void>>,
          Pointer<Pointer<Void>>,
          Pointer<Pointer<Void>>,
        ),
        int Function(
          Pointer<Utf16>,
          int,
          int,
          Pointer<Pointer<Void>>,
          Pointer<Pointer<Void>>,
          Pointer<Pointer<Void>>,
          Pointer<Pointer<Void>>,
          Pointer<Pointer<Void>>,
        )
      >('GetNamedSecurityInfoW');
  final convert = adv
      .lookupFunction<
        Int32 Function(Pointer<Void>, Pointer<Pointer<Utf16>>),
        int Function(Pointer<Void>, Pointer<Pointer<Utf16>>)
      >('ConvertSidToStringSidW');
  final localFree = kernel
      .lookupFunction<
        Pointer<Void> Function(Pointer<Void>),
        Pointer<Void> Function(Pointer<Void>)
      >('LocalFree');
  final name = path.toNativeUtf16();
  final ownerOut = calloc<Pointer<Void>>();
  final sdOut = calloc<Pointer<Void>>();
  final sidText = calloc<Pointer<Utf16>>();
  try {
    final rc = getNamed(
      name,
      1,
      0x1,
      ownerOut,
      Pointer<Pointer<Void>>.fromAddress(0),
      Pointer<Pointer<Void>>.fromAddress(0),
      Pointer<Pointer<Void>>.fromAddress(0),
      sdOut,
    );
    if (rc != 0 || ownerOut.value == nullptr) {
      throw const FormatException(shewallAclDacl);
    }
    if (convert(ownerOut.value, sidText) == 0 || sidText.value == nullptr) {
      throw const FormatException(shewallAclDacl);
    }
    return sidText.value.toDartString();
  } finally {
    if (sidText.value != nullptr) localFree(sidText.value.cast<Void>());
    if (sdOut.value != nullptr) localFree(sdOut.value);
    calloc.free(ownerOut);
    calloc.free(sdOut);
    calloc.free(sidText);
    malloc.free(name);
  }
}

final class _SecurityAttributes extends Struct {
  @Uint32()
  external int nLength;

  external Pointer<Void> lpSecurityDescriptor;

  @Int32()
  external int bInheritHandle;
}

String _tokenUserSid() {
  if (!Platform.isWindows) throw const FormatException(shewallAclToken);
  final kernel = DynamicLibrary.open('kernel32.dll');
  final adv = DynamicLibrary.open('advapi32.dll');
  final current = kernel.lookupFunction<IntPtr Function(), int Function()>(
    'GetCurrentProcess',
  );
  final openToken = adv
      .lookupFunction<
        Int32 Function(IntPtr, Uint32, Pointer<IntPtr>),
        int Function(int, int, Pointer<IntPtr>)
      >('OpenProcessToken');
  final info = adv
      .lookupFunction<
        Int32 Function(IntPtr, Int32, Pointer<Uint8>, Uint32, Pointer<Uint32>),
        int Function(int, int, Pointer<Uint8>, int, Pointer<Uint32>)
      >('GetTokenInformation');
  final convert = adv
      .lookupFunction<
        Int32 Function(Pointer<Void>, Pointer<Pointer<Utf16>>),
        int Function(Pointer<Void>, Pointer<Pointer<Utf16>>)
      >('ConvertSidToStringSidW');
  final close = kernel
      .lookupFunction<Int32 Function(IntPtr), int Function(int)>('CloseHandle');
  final localFree = kernel
      .lookupFunction<
        Pointer<Void> Function(Pointer<Void>),
        Pointer<Void> Function(Pointer<Void>)
      >('LocalFree');
  final tokenOut = calloc<IntPtr>();
  try {
    if (openToken(current(), 0x0008, tokenOut) == 0 || tokenOut.value == 0) {
      throw const FormatException(shewallAclToken);
    }
    final token = tokenOut.value;
    try {
      final needed = calloc<Uint32>();
      try {
        info(token, 1, Pointer<Uint8>.fromAddress(0), 0, needed);
        final size = needed.value;
        if (size < 8 || size > 4096) {
          throw const FormatException(shewallAclToken);
        }
        final buf = calloc<Uint8>(size);
        try {
          final got = calloc<Uint32>();
          try {
            if (info(token, 1, buf, size, got) == 0) {
              throw const FormatException(shewallAclToken);
            }
          } finally {
            calloc.free(got);
          }
          final sid = buf.cast<Pointer<Void>>().value;
          if (sid == nullptr) throw const FormatException(shewallAclToken);
          final text = calloc<Pointer<Utf16>>();
          try {
            if (convert(sid, text) == 0 || text.value == nullptr) {
              throw const FormatException(shewallAclToken);
            }
            final sidText = text.value.toDartString();
            localFree(text.value.cast<Void>());
            text.value = nullptr;
            return sidText;
          } finally {
            if (text.value != nullptr) localFree(text.value.cast<Void>());
            calloc.free(text);
          }
        } finally {
          calloc.free(buf);
        }
      } finally {
        calloc.free(needed);
      }
    } finally {
      close(token);
    }
  } finally {
    calloc.free(tokenOut);
  }
}

void _createOwnerOnlyWin32(String path, Uint8List bytes, String sddl) {
  if (!Platform.isWindows) throw const FormatException(shewallAclIoError);
  final kernel = DynamicLibrary.open('kernel32.dll');
  final adv = DynamicLibrary.open('advapi32.dll');
  final convert = adv
      .lookupFunction<
        Int32 Function(
          Pointer<Utf16>,
          Uint32,
          Pointer<Pointer<Void>>,
          Pointer<Uint32>,
        ),
        int Function(
          Pointer<Utf16>,
          int,
          Pointer<Pointer<Void>>,
          Pointer<Uint32>,
        )
      >('ConvertStringSecurityDescriptorToSecurityDescriptorW');
  final createFile = kernel
      .lookupFunction<
        IntPtr Function(
          Pointer<Utf16>,
          Uint32,
          Uint32,
          Pointer<_SecurityAttributes>,
          Uint32,
          Uint32,
          IntPtr,
        ),
        int Function(
          Pointer<Utf16>,
          int,
          int,
          Pointer<_SecurityAttributes>,
          int,
          int,
          int,
        )
      >('CreateFileW');
  final write = kernel
      .lookupFunction<
        Int32 Function(
          IntPtr,
          Pointer<Uint8>,
          Uint32,
          Pointer<Uint32>,
          Pointer<Void>,
        ),
        int Function(int, Pointer<Uint8>, int, Pointer<Uint32>, Pointer<Void>)
      >('WriteFile');
  final flush = kernel
      .lookupFunction<Int32 Function(IntPtr), int Function(int)>(
        'FlushFileBuffers',
      );
  final close = kernel
      .lookupFunction<Int32 Function(IntPtr), int Function(int)>('CloseHandle');
  final localFree = kernel
      .lookupFunction<
        Pointer<Void> Function(Pointer<Void>),
        Pointer<Void> Function(Pointer<Void>)
      >('LocalFree');
  final sddlPtr = sddl.toNativeUtf16();
  final sdOut = calloc<Pointer<Void>>();
  final sa = calloc<_SecurityAttributes>();
  final name = path.toNativeUtf16();
  try {
    if (convert(sddlPtr, 1, sdOut, Pointer<Uint32>.fromAddress(0)) == 0 ||
        sdOut.value == nullptr) {
      throw const FormatException(shewallAclDacl);
    }
    sa.ref.nLength = sizeOf<_SecurityAttributes>();
    sa.ref.lpSecurityDescriptor = sdOut.value;
    sa.ref.bInheritHandle = 0;
    final handle = createFile(name, 0x40000000, 0, sa, 1, 0x80, 0);
    if (handle == 0 || handle == -1) {
      throw const FormatException(shewallAclIoError);
    }
    try {
      _writeHandle(write, handle, bytes);
      if (flush(handle) == 0) throw const FormatException(shewallAclFsync);
    } finally {
      close(handle);
    }
  } finally {
    if (sdOut.value != nullptr) localFree(sdOut.value);
    calloc.free(sdOut);
    calloc.free(sa);
    malloc.free(sddlPtr);
    malloc.free(name);
  }
}

void _writeHandle(
  int Function(int, Pointer<Uint8>, int, Pointer<Uint32>, Pointer<Void>) write,
  int handle,
  Uint8List bytes,
) {
  if (bytes.isEmpty) return;
  const chunk = 65536;
  final buf = malloc<Uint8>(chunk);
  final written = calloc<Uint32>();
  try {
    var off = 0;
    while (off < bytes.length) {
      final take = bytes.length - off < chunk ? bytes.length - off : chunk;
      buf.asTypedList(take).setRange(0, take, bytes, off);
      var done = 0;
      while (done < take) {
        written.value = 0;
        final ok = write(
          handle,
          Pointer<Uint8>.fromAddress(buf.address + done),
          take - done,
          written,
          nullptr,
        );
        if (ok == 0 || written.value == 0) {
          throw const FormatException(shewallAclIoError);
        }
        done += written.value;
      }
      off += take;
    }
  } finally {
    malloc.free(buf);
    calloc.free(written);
  }
}
