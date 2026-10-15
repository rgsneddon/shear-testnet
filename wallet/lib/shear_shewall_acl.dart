import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
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
/// Outside Windows the directory is mode 0700 and the file is mode 0600.
/// A symlink at the destination, or on any path component, is refused.
/// `chmod` of `/` or of the shared system temp directory is refused.
///
/// On Windows the DACL is replaced, by SID, with the current user, SYSTEM
/// (`S-1-5-18`), and Administrators (`S-1-5-32-544`). The user is the owner.
/// `whoami.exe` and `icacls.exe` come from `GetSystemDirectoryW`, and that
/// directory must equal the HKLM `SystemRoot` value plus `\System32`. A
/// mismatch, including a planted `C:\Windows\System32` when Windows lives on
/// another drive, refuses the write. The process environment is not consulted.
/// The DACL is read back with `icacls /save`, not PowerShell, so a planted
/// `PSModulePath` cannot fake `Get-Acl`. A mismatch throws before the rename.
///
/// This follows `node/src/datadir_acl.js` (PR 96) for the trustees and the
/// icacls grant shape. `/T` is not used: this writer is pointed at whatever
/// directory holds one `shewall.bin`, and a walk would rewrite every sibling
/// in Downloads or Documents.
const shewallFileMode = 0x180; // 0600
const shewallDirMode = 0x1c0; // 0700
const _modeMask = 0x1ff;

const systemSid = 'S-1-5-18';
const administratorsSid = 'S-1-5-32-544';

const shewallAclSymlink = 'shewall_acl:symlink';
const shewallAclChmod = 'shewall_acl:chmod';
const shewallAclDacl = 'shewall_acl:dacl';
const shewallAclWhoami = 'shewall_acl:whoami';
const shewallAclIcacls = 'shewall_acl:icacls';
const shewallAclSystem32 = 'shewall_acl:system32';
const shewallAclFsync = 'shewall_acl:fsync';
const shewallAclIoError = 'shewall_acl:io';
const shewallAclDir = 'shewall_acl:dir';

typedef ShewallProc =
    String Function(
      String executable,
      List<String> args, {
      Map<String, String>? environment,
    });

typedef ShewallChmod = void Function(String path, int mode);

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

  /// Caller environment. It is never copied into a child process. A test
  /// plants `SystemRoot` and `PSModulePath` here.
  final Map<String, String> env;

  bool get isWindows => windows ?? Platform.isWindows;
}

/// Join [name] onto a system directory that [resolveWindowsSystem32] accepted.
String system32Exe(String name, String systemDirectory) {
  if (name != 'whoami.exe' && name != 'icacls.exe') {
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
  if (io.isWindows) {
    _windowsReplace(full, parent, sealed, io);
    return;
  }
  _posixReplace(full, name, parent, sealed, io);
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
  ShewallAclIo io,
) {
  final posix = _posixFiles();
  final dirfd = posix.openDirectory(parent);
  var filefd = -1;
  var tmp = '';
  var renamed = false;
  try {
    _chmodFd(posix, io, dirfd, parent, shewallDirMode);
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
    if ((mode & 0xF000) == 0xA000) {
      throw const FormatException(shewallAclSymlink);
    }
    if ((mode & _modeMask) != shewallFileMode) {
      throw const FormatException(shewallAclChmod);
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
  final viaFd = posix.fstatMode(fd) & _modeMask;
  if (FileSystemEntity.typeSync(path, followLinks: false) ==
      FileSystemEntityType.link) {
    throw const FormatException(shewallAclSymlink);
  }
  final viaPath = FileStat.statSync(path).mode & _modeMask;
  if (viaFd != mode || viaPath != mode) {
    throw const FormatException(shewallAclChmod);
  }
}

void _windowsReplace(
  String full,
  String parent,
  Uint8List sealed,
  ShewallAclIo io,
) {
  final system32 = _resolvedSystem32(io);
  final childEnv = _fixedChildEnv(system32, io);
  final sid = _readUserSid(io, system32, childEnv);
  _applyDacl(
    io,
    parent,
    directory: true,
    sid: sid,
    system32: system32,
    childEnv: childEnv,
  );
  final tmpName = '.shewall.$pid.${Random.secure().nextInt(0x7fffffff)}.tmp';
  final tmpPath = p.join(parent, tmpName);
  if (FileSystemEntity.typeSync(tmpPath, followLinks: false) ==
      FileSystemEntityType.link) {
    throw const FormatException(shewallAclSymlink);
  }
  final tmp = File(tmpPath);
  var renamed = false;
  try {
    final raf = tmp.openSync(mode: FileMode.writeOnly);
    try {
      raf.writeFromSync(sealed);
      raf.flushSync();
    } finally {
      raf.closeSync();
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

String _readUserSid(
  ShewallAclIo io,
  String system32,
  Map<String, String> childEnv,
) {
  final out = _runChecked(
    io,
    system32Exe('whoami.exe', system32),
    ['/user', '/fo', 'csv', '/nh'],
    shewallAclWhoami,
    system32,
    childEnv,
  );
  final match = RegExp(r'S-1-\d+(?:-\d+)+').firstMatch(out);
  if (match == null) throw const FormatException(shewallAclWhoami);
  return match.group(0)!;
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
    return runner(executable, args, environment: environment);
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
}) {
  if (environment == null) throw const FormatException(shewallAclSystem32);
  final result = Process.runSync(
    executable,
    args,
    environment: environment,
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
  if (name != 'whoami.exe' && name != 'icacls.exe') {
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
    _fstat = _lib
        .lookupFunction<
          Int32 Function(Int32, Pointer<Uint8>),
          int Function(int, Pointer<Uint8>)
        >('fstat');
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
  late final int Function(int, Pointer<Uint8>) _fstat;
  late final int Function(int, Pointer<Utf8>, int, Pointer<Utf8>) _renameat;
  late final int Function(int, Pointer<Utf8>, int) _unlinkat;
  late final int Function() _errno;

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
  int get _oNofollow => _apple ? 0x100 : 0x20000;
  int get _oCloexec => _apple ? 0x1000000 : 0x80000;
  int get _oDirectory => _apple ? 0x100000 : 0x10000;
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

  int fstatMode(int fd) {
    final buf = calloc<Uint8>(256);
    try {
      final rc = _fstat(fd, buf);
      if (rc != 0) throw const FormatException(shewallAclIoError);
      final data = ByteData.sublistView(buf.asTypedList(256));
      if (_apple) return data.getUint16(4, Endian.host);
      return data.getUint32(24, Endian.host);
    } finally {
      calloc.free(buf);
    }
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
