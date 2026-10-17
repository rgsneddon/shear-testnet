import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

/// Local vote plan. The pool never sees locked leaves, this file, or a plan
/// directory. The file is mode 0600 inside a 0700 app-private folder. It is
/// not a Documents path, not a sync root, and not logged or posted.
const votePlanName = 'vote-plan.json';
const votePlanDirName = 'vote';
const voteEdgeBlocks = 10;
const voteMinSeparation = 30;
const voteFileMode = 0x180;
const voteDirMode = 0x1c0;

String votePlanPath(String dir) => '$dir${Platform.pathSeparator}$votePlanName';

/// Application-support child. Callers pass the no-backup directory on
/// Android and Application Support on Apple. This is not Documents and it
/// is not a cloud-sync folder. [excludeVotePlanFromBackup] sets the Apple
/// backup-exclusion attribute.
String votePlanFolder(String appPrivateRoot) {
  final sep = Platform.pathSeparator;
  if (appPrivateRoot.endsWith(sep)) return '$appPrivateRoot$votePlanDirName';
  return '$appPrivateRoot$sep$votePlanDirName';
}

String? _commitHex(dynamic raw) {
  if (raw is String) {
    final hex = raw.replaceFirst(RegExp(r'^0x'), '').toLowerCase();
    if (RegExp(r'^[0-9a-f]{64}$').hasMatch(hex)) return hex;
    return null;
  }
  List<int>? bytes;
  if (raw is Uint8List) {
    bytes = raw;
  } else if (raw is List<int>) {
    bytes = raw;
  }
  if (bytes == null || bytes.length != 32) return null;
  final out = StringBuffer();
  for (final b in bytes) {
    out.write(b.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}

class _FeeNote {
  _FeeNote(this.commit, this.parent);
  final String commit;
  final String parent;
}

/// Spendable notes. Lock notes, spent notes, locked notes, and another
/// vote's change are not fee inputs.
List<_FeeNote> _feeNotes(List<dynamic> notes) {
  final out = <_FeeNote>[];
  final seen = <String>{};
  for (final row in notes) {
    if (row is! Map) continue;
    if (row['spent'] == true || row['locked'] == true) continue;
    if ((row['kind'] ?? '').toString() == 'lock') continue;
    if (row['voteChange'] == true || (row['changeOf'] ?? '').toString() == 'vote') continue;
    final hex = _commitHex(row['commit']);
    if (hex == null || !seen.add(hex)) continue;
    final parent = row['parentTx'] == null ? '' : row['parentTx'].toString();
    out.add(_FeeNote(hex, parent));
  }
  return out;
}

/// One note per parent transaction, then a uniform subset. Notes with no
/// parent are each eligible.
List<String>? pickVoteFeeNotes(List<dynamic> notes, int count, Random random) {
  if (count < 1) return const [];
  final rows = _feeNotes(notes);
  final groups = <String, List<_FeeNote>>{};
  final eligible = <_FeeNote>[];
  for (final row in rows) {
    if (row.parent.isEmpty) {
      eligible.add(row);
      continue;
    }
    groups.putIfAbsent(row.parent, () => <_FeeNote>[]).add(row);
  }
  for (final group in groups.values) {
    eligible.add(group[random.nextInt(group.length)]);
  }
  final picks = _combination(eligible.length, count, random);
  if (picks == null) return null;
  return [for (final i in picks) eligible[i].commit];
}

/// Spendable note commits, in wallet order. The planner's random pick is
/// [pickVoteFeeNotes].
List<String> ownedFeeInputs(List<dynamic> notes) {
  return [for (final row in _feeNotes(notes)) row.commit];
}

/// Every k-subset of n is equally likely. A subset is returned whenever n >= k.
List<int>? _combination(int n, int k, Random random) {
  if (k < 0 || n < k) return null;
  final chosen = <int>[];
  var left = k;
  for (var i = 0; i < n && left > 0; i++) {
    if (random.nextInt(n - i) < left) {
      chosen.add(i);
      left -= 1;
    }
  }
  return left == 0 ? chosen : null;
}

/// Heights in [lo, hi] with a gap of at least [voteMinSeparation].
/// y_i = h_i - i*(sep-1) is a uniform combination, so a valid plan is
/// returned whenever the window can hold one.
List<int>? _planHeights(int count, int lo, int hi, Random random) {
  if (hi < lo) return null;
  final span = hi - lo + 1;
  final need = count <= 1 ? 1 : (count - 1) * voteMinSeparation + 1;
  if (span < need) return null;
  final gap = voteMinSeparation - 1;
  final reduced = hi - (count - 1) * gap - lo + 1;
  final picks = _combination(reduced, count, random);
  if (picks == null) return null;
  return [for (var i = 0; i < picks.length; i++) lo + picks[i] + i * gap];
}

/// One send per locked leaf. Each fee input is a distinct spendable note
/// the wallet already holds. The planner does not invent bytes.
Map<String, Object?>? castWalletVotePlan({
  required int leaves,
  required List<dynamic> notes,
  required int openHeight,
  required int closeHeight,
  Random? random,
}) {
  final count = leaves < 0 ? 0 : leaves;
  final open = openHeight < 0 ? 0 : openHeight;
  final label = 'Cast your $count votes';
  if (count == 0) {
    return {
      'label': label,
      'openHeight': open,
      'closeHeight': closeHeight,
      'txs': <Map<String, Object?>>[],
    };
  }
  final rng = random ?? Random.secure();
  final owned = pickVoteFeeNotes(notes, count, rng);
  if (owned == null) return null;
  final lo = open + voteEdgeBlocks;
  final hi = closeHeight - voteEdgeBlocks;
  final heights = _planHeights(count, lo, hi, rng);
  if (heights == null) return null;
  return {
    'label': label,
    'openHeight': open,
    'closeHeight': closeHeight,
    'txs': [
      for (var i = 0; i < count; i++)
        {'leaf': i, 'height': heights[i], 'feeInput': owned[i]},
    ],
  };
}

Map<String, Object?>? loadWalletVotePlan(String dir) {
  final dest = File(votePlanPath(dir));
  final kind = FileSystemEntity.typeSync(dest.path, followLinks: false);
  if (kind == FileSystemEntityType.notFound) return null;
  if (kind != FileSystemEntityType.file) return null;
  try {
    final plan = jsonDecode(dest.readAsStringSync());
    if (plan is! Map || plan['txs'] is! List) return null;
    return plan.map((key, value) => MapEntry(key.toString(), value));
  } catch (_) {
    return null;
  }
}

/// Load the plan, or build and save one. A restart reads the same file.
Map<String, Object?>? plannedLeafVotes({
  required String dir,
  required int leaves,
  required List<dynamic> notes,
  required int openHeight,
  required int closeHeight,
  Random? random,
}) {
  final loaded = loadWalletVotePlan(dir);
  if (loaded != null) return loaded;
  final plan = castWalletVotePlan(
    leaves: leaves,
    notes: notes,
    openHeight: openHeight,
    closeHeight: closeHeight,
    random: random,
  );
  if (plan == null) return null;
  saveWalletVotePlan(dir, plan);
  return plan;
}

/// Write vote-plan.json at mode 0600 inside a 0700 folder. The temp file is
/// created with that mode (no chmod). An existing file or a symlink is refused.
void saveWalletVotePlan(String dir, Map<String, Object?> plan) {
  if (Platform.isWindows) {
    throw StateError('vote_plan_mode');
  }
  final parent = Directory(dir);
  if (!parent.existsSync()) {
    _mkdirParents(parent.path);
  } else if (FileSystemEntity.typeSync(parent.path, followLinks: false) !=
      FileSystemEntityType.directory) {
    throw StateError('vote_plan_mode');
  }
  final dest = votePlanPath(dir);
  final kind = FileSystemEntity.typeSync(dest, followLinks: false);
  if (kind != FileSystemEntityType.notFound) {
    throw StateError('vote_plan_exists');
  }
  final bytes = Uint8List.fromList(utf8.encode(jsonEncode(plan)));
  final tmpName = '.$votePlanName.${Random.secure().nextInt(1 << 30)}.tmp';
  final posix = _VotePosix();
  final dirfd = posix.openDirectory(parent.path);
  var fd = -1;
  var renamed = false;
  try {
    fd = posix.openExclusive(dirfd, tmpName, voteFileMode);
    posix.writeAll(fd, bytes);
    if (posix.fsync(fd) != 0) throw StateError('vote_plan_fsync');
    if (posix.renameAt(dirfd, tmpName, votePlanName) != 0) {
      throw StateError('vote_plan_mode');
    }
    renamed = true;
    posix.fsync(dirfd);
    final mode = File(dest).statSync().mode & 0x1ff;
    if (mode != voteFileMode) throw StateError('vote_plan_mode');
  } catch (_) {
    if (!renamed) posix.unlinkAt(dirfd, tmpName);
    rethrow;
  } finally {
    if (fd >= 0) posix.close(fd);
    if (dirfd >= 0) posix.close(dirfd);
  }
  excludeVotePlanFromBackup(dir);
}

/// Apple backup exclusion. On Linux this is a no-op: the folder is already
/// outside any sync root the wallet uses.
void excludeVotePlanFromBackup(String dir) {
  if (!Platform.isMacOS && !Platform.isIOS) return;
  final posix = _VotePosix();
  posix.setExclude(dir);
}

void _mkdirParents(String path) {
  final parent = Directory(path).parent.path;
  if (parent != path && !Directory(parent).existsSync()) _mkdirParents(parent);
  if (!Directory(path).existsSync()) _mkdirMode(path, voteDirMode);
}

void _mkdirMode(String path, int mode) {
  final posix = _VotePosix();
  if (posix.mkdir(path, mode) != 0) throw StateError('vote_plan_mode');
  final kind = FileSystemEntity.typeSync(path, followLinks: false);
  if (kind != FileSystemEntityType.directory) throw StateError('vote_plan_mode');
}

class _VotePosix {
  _VotePosix() {
    final lib = _libc();
    _openat = lib.lookupFunction<Int32 Function(Int32, Pointer<Utf8>, Int32, Uint32),
        int Function(int, Pointer<Utf8>, int, int)>('openat');
    _close = lib.lookupFunction<Int32 Function(Int32), int Function(int)>('close');
    _write = lib.lookupFunction<IntPtr Function(Int32, Pointer<Uint8>, IntPtr),
        int Function(int, Pointer<Uint8>, int)>('write');
    _fsync = lib.lookupFunction<Int32 Function(Int32), int Function(int)>('fsync');
    _unlinkat = lib.lookupFunction<Int32 Function(Int32, Pointer<Utf8>, Int32),
        int Function(int, Pointer<Utf8>, int)>('unlinkat');
    _renameat = lib.lookupFunction<Int32 Function(Int32, Pointer<Utf8>, Int32, Pointer<Utf8>),
        int Function(int, Pointer<Utf8>, int, Pointer<Utf8>)>('renameat');
    _mkdir = lib.lookupFunction<Int32 Function(Pointer<Utf8>, Uint32), int Function(Pointer<Utf8>, int)>('mkdir');
    _errno = lib.lookupFunction<Pointer<Int32> Function(), Pointer<Int32> Function()>(
      Platform.isMacOS || Platform.isIOS ? '__error' : '__errno_location',
    );
    try {
      _setxattr = lib.lookupFunction<
          Int32 Function(Pointer<Utf8>, Pointer<Utf8>, Pointer<Uint8>, IntPtr, Int32, Int32),
          int Function(Pointer<Utf8>, Pointer<Utf8>, Pointer<Uint8>, int, int, int)>('setxattr');
    } catch (_) {
      _setxattr = null;
    }
  }

  late final int Function(int, Pointer<Utf8>, int, int) _openat;
  late final int Function(int) _close;
  late final int Function(int, Pointer<Uint8>, int) _write;
  late final int Function(int) _fsync;
  late final int Function(int, Pointer<Utf8>, int) _unlinkat;
  late final int Function(int, Pointer<Utf8>, int, Pointer<Utf8>) _renameat;
  late final int Function(Pointer<Utf8>, int) _mkdir;
  late final Pointer<Int32> Function() _errno;
  int Function(Pointer<Utf8>, Pointer<Utf8>, Pointer<Uint8>, int, int, int)? _setxattr;

  bool get _apple => Platform.isMacOS || Platform.isIOS;
  int get _atFdcwd => _apple ? -2 : -100;
  int get _oWronly => 1;
  int get _oRdonly => 0;
  int get _oCreat => _apple ? 0x200 : 0x40;
  int get _oExcl => _apple ? 0x800 : 0x80;
  int get _oCloexec => _apple ? 0x1000000 : 0x80000;
  int get _oDirectory => _apple ? 0x100000 : 0x10000;
  int get _oNofollow => _apple ? 0x100 : 0x20000;

  DynamicLibrary _libc() {
    if (_apple) return DynamicLibrary.open('/usr/lib/libSystem.B.dylib');
    return DynamicLibrary.open('libc.so.6');
  }

  int mkdir(String path, int mode) {
    final raw = path.toNativeUtf8();
    try {
      return _mkdir(raw, mode);
    } finally {
      malloc.free(raw);
    }
  }

  int openDirectory(String path) {
    final raw = path.toNativeUtf8();
    try {
      final fd = _openat(_atFdcwd, raw, _oRdonly | _oDirectory | _oNofollow | _oCloexec, 0);
      if (fd < 0) throw StateError('vote_plan_mode');
      return fd;
    } finally {
      malloc.free(raw);
    }
  }

  int openExclusive(int dirfd, String name, int mode) {
    final raw = name.toNativeUtf8();
    try {
      final fd = _openat(dirfd, raw, _oWronly | _oCreat | _oExcl | _oNofollow | _oCloexec, mode);
      if (fd < 0) throw StateError('vote_plan_exists');
      return fd;
    } finally {
      malloc.free(raw);
    }
  }

  void writeAll(int fd, Uint8List bytes) {
    final buf = malloc<Uint8>(bytes.length);
    try {
      buf.asTypedList(bytes.length).setAll(0, bytes);
      var off = 0;
      while (off < bytes.length) {
        final n = _write(fd, Pointer<Uint8>.fromAddress(buf.address + off), bytes.length - off);
        if (n < 0) {
          if (_errno().value == 4) continue;
          throw StateError('vote_plan_fsync');
        }
        if (n == 0) throw StateError('vote_plan_fsync');
        off += n;
      }
    } finally {
      malloc.free(buf);
    }
  }

  int fsync(int fd) {
    while (true) {
      final rc = _fsync(fd);
      if (rc == 0) return 0;
      if (_errno().value == 4) continue;
      return rc;
    }
  }

  int renameAt(int dirfd, String from, String to) {
    final a = from.toNativeUtf8();
    final b = to.toNativeUtf8();
    try {
      return _renameat(dirfd, a, dirfd, b);
    } finally {
      malloc.free(a);
      malloc.free(b);
    }
  }

  void unlinkAt(int dirfd, String name) {
    final raw = name.toNativeUtf8();
    try {
      _unlinkat(dirfd, raw, 0);
    } finally {
      malloc.free(raw);
    }
  }

  void close(int fd) => _close(fd);

  void setExclude(String path) {
    final set = _setxattr;
    if (set == null) return;
    final raw = path.toNativeUtf8();
    final key = 'com.apple.metadata:com_apple_backup_excludeItem'.toNativeUtf8();
    final value = malloc<Uint8>(1);
    try {
      value[0] = 1;
      set(raw, key, value, 1, 0, 0);
    } finally {
      malloc.free(raw);
      malloc.free(key);
      malloc.free(value);
    }
  }
}
