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
/// `whoami.exe`, `icacls.exe`, and PowerShell are the absolute System32
/// binaries. `SystemRoot` is never used to build that path. The DACL is read
/// back and a mismatch throws before the rename, so the previous file stays.
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

const kSystem32Whoami = r'C:\Windows\System32\whoami.exe';
const kSystem32Icacls = r'C:\Windows\System32\icacls.exe';
const kSystem32PowerShell =
    r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';

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
    this.env = const {},
  });

  final bool? windows;
  final ShewallProc? run;
  final bool Function(String absoluteExe)? system32Verified;
  final ShewallChmod? chmod;

  /// Passed through so a test can hand in a poisoned `SystemRoot`.
  /// The System32 path is not built from this map.
  final Map<String, String> env;

  bool get isWindows => windows ?? Platform.isWindows;
}

String system32Exe(String name) {
  switch (name) {
    case 'whoami.exe':
      return kSystem32Whoami;
    case 'icacls.exe':
      return kSystem32Icacls;
    case 'powershell.exe':
      return kSystem32PowerShell;
    default:
      throw const FormatException(shewallAclSystem32);
  }
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
  final sid = _readUserSid(io);
  _applyDacl(io, parent, directory: true, sid: sid);
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
    _applyDacl(io, tmpPath, directory: false, sid: sid);
    if (FileSystemEntity.typeSync(full, followLinks: false) ==
        FileSystemEntityType.link) {
      throw const FormatException(shewallAclSymlink);
    }
    tmp.renameSync(full);
    renamed = true;
    _expectReadBack(io, full, directory: false, sid: sid);
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

String _readUserSid(ShewallAclIo io) {
  final out = _runChecked(io, system32Exe('whoami.exe'), [
    '/user',
    '/fo',
    'csv',
    '/nh',
  ], shewallAclWhoami);
  final match = RegExp(r'S-1-\d+(?:-\d+)+').firstMatch(out);
  if (match == null) throw const FormatException(shewallAclWhoami);
  return match.group(0)!;
}

void _applyDacl(
  ShewallAclIo io,
  String path, {
  required bool directory,
  required String sid,
}) {
  final icacls = system32Exe('icacls.exe');
  String ace(String trustee) =>
      directory ? '*$trustee:(OI)(CI)F' : '*$trustee:F';
  // No /T. The node walks its private datadir. This file may sit in a
  // directory the user shares with other documents.
  _runChecked(io, icacls, [
    path,
    '/inheritance:r',
    '/grant:r',
    ace(sid),
    ace(systemSid),
    ace(administratorsSid),
  ], shewallAclIcacls);
  _runChecked(io, icacls, [path, '/setowner', '*$sid'], shewallAclIcacls);
  _expectReadBack(io, path, directory: directory, sid: sid);
}

void _expectReadBack(
  ShewallAclIo io,
  String path, {
  required bool directory,
  required String sid,
}) {
  const command =
      r'$ErrorActionPreference = "Stop"'
      r'; $p = $env:SHEWALL_ACL_PATH'
      r'; if ([string]::IsNullOrEmpty($p)) { throw "path" }'
      r'; $acl = Get-Acl -LiteralPath $p'
      r'; $sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access'
      r'; [Console]::Out.Write($acl.GetSecurityDescriptorSddlForm($sections))';
  final env = Map<String, String>.from(Platform.environment);
  env['SHEWALL_ACL_PATH'] = path;
  final out = _runChecked(
    io,
    system32Exe('powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', command],
    shewallAclDacl,
    environment: env,
  );
  _expectDacl(out, ownerSid: sid, directory: directory);
}

String _runChecked(
  ShewallAclIo io,
  String executable,
  List<String> args,
  String code, {
  Map<String, String>? environment,
}) {
  _assertSystem32(executable, io);
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

void _assertSystem32(String executable, ShewallAclIo io) {
  if (executable != kSystem32Whoami &&
      executable != kSystem32Icacls &&
      executable != kSystem32PowerShell) {
    throw const FormatException(shewallAclSystem32);
  }
  _rejectForeignRoot(executable, io.env);
  _rejectForeignRoot(executable, Platform.environment);
  final ok = io.system32Verified ?? _system32FileIsReal;
  if (!ok(executable)) throw const FormatException(shewallAclSystem32);
}

void _rejectForeignRoot(String executable, Map<String, String> env) {
  for (final key in const ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir']) {
    final root = env[key];
    if (root == null || root.isEmpty) continue;
    var norm = root.replaceAll('/', r'\');
    while (norm.endsWith(r'\')) {
      norm = norm.substring(0, norm.length - 1);
    }
    if (norm.toLowerCase() == r'c:\windows') continue;
    final lower = executable.toLowerCase();
    final foreign = norm.toLowerCase();
    if (lower == foreign || lower.startsWith('$foreign\\')) {
      throw const FormatException(shewallAclSystem32);
    }
  }
}

bool _system32FileIsReal(String path) {
  if (path != kSystem32Whoami &&
      path != kSystem32Icacls &&
      path != kSystem32PowerShell) {
    return false;
  }
  return FileSystemEntity.typeSync(path, followLinks: false) ==
      FileSystemEntityType.file;
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
