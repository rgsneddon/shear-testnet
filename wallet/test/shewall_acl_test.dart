import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:shear_wallet/shear_export.dart';
import 'package:shear_wallet/shear_session.dart';
import 'package:shear_wallet/shear_shewall_acl.dart';

const _userSid = 'S-1-5-21-1-2-3-1001';
const _localName = r'DESKTOP-ODTSQ56\rgsne';
const _modeMask = 0x1ff;
const _dIcacls = r'D:\Windows\System32\icacls.exe';

void main() {
  test('atomic replace keeps the new bytes and leaves no temp file', () {
    final dir = _tempDir();
    final dest = File(p.join(dir.path, shewallName));
    writePrivateShewallSync(dest, Uint8List.fromList([1, 2, 3]));
    writePrivateShewallSync(dest, Uint8List.fromList([4, 5, 6, 7]));
    expect(dest.readAsBytesSync(), [4, 5, 6, 7]);
    final names = dir.listSync().map((entity) => p.basename(entity.path));
    expect(names, contains(shewallName));
    expect(
      names.where(
        (name) => name.startsWith('.shewall.') || name.endsWith('.tmp'),
      ),
      isEmpty,
    );
  });

  test('file is 0600 and a picked directory keeps its mode', () {
    if (Platform.isWindows) {
      markTestSkipped('POSIX file modes');
      return;
    }
    final dir = _tempDir();
    final widened = Process.runSync('chmod', ['755', dir.path]);
    expect(widened.exitCode, 0);
    expect(FileStat.statSync(dir.path).mode & _modeMask, 0x1ed);
    final umask = DynamicLibrary.open(
      'libc.so.6',
    ).lookupFunction<Uint32 Function(Uint32), int Function(int)>('umask');
    final previous = umask(0x3f);
    try {
      final dest = File(p.join(dir.path, shewallName));
      writePrivateShewallSync(dest, Uint8List.fromList([8, 8]));
      expect(FileStat.statSync(dest.path).mode & _modeMask, shewallFileMode);
      expect(FileStat.statSync(dir.path).mode & _modeMask, 0x1ed);
    } finally {
      umask(previous);
    }
  });

  test('app-owned shear directory is mode 0700 and the file is 0600', () {
    if (Platform.isWindows) {
      markTestSkipped('POSIX file modes');
      return;
    }
    final support = _tempDir();
    final app = Directory(shewallAppDirectory(support.path))..createSync();
    final widened = Process.runSync('chmod', ['755', app.path]);
    expect(widened.exitCode, 0);
    final elsewhere = Directory(p.join(_tempDir().path, shewallAppFolder))
      ..createSync();
    Process.runSync('chmod', ['755', elsewhere.path]);
    final umask = DynamicLibrary.open(
      'libc.so.6',
    ).lookupFunction<Uint32 Function(Uint32), int Function(int)>('umask');
    final previous = umask(0x3f);
    try {
      final dest = File(p.join(app.path, shewallName));
      writePrivateShewallSync(
        dest,
        Uint8List.fromList([8, 8]),
        applicationSupport: support.path,
      );
      expect(FileStat.statSync(dest.path).mode & _modeMask, shewallFileMode);
      expect(FileStat.statSync(app.path).mode & _modeMask, shewallDirMode);
      final other = File(p.join(elsewhere.path, shewallName));
      writePrivateShewallSync(
        other,
        Uint8List.fromList([1]),
        applicationSupport: support.path,
      );
      expect(FileStat.statSync(elsewhere.path).mode & _modeMask, 0x1ed);
      expect(FileStat.statSync(other.path).mode & _modeMask, shewallFileMode);
    } finally {
      umask(previous);
    }
  });

  test('a chmod failure before rename keeps the previous shewall.bin', () {
    if (Platform.isWindows) {
      markTestSkipped('POSIX chmod');
      return;
    }
    final dir = _tempDir();
    final dest = File(p.join(dir.path, shewallName));
    writePrivateShewallSync(dest, Uint8List.fromList([1, 2, 3, 4]));
    expect(
      () => writePrivateShewallSync(
        dest,
        Uint8List.fromList([9, 9, 9]),
        io: ShewallAclIo(
          chmod: (path, mode) {
            if (mode == shewallFileMode) {
              throw const FormatException(shewallAclChmod);
            }
            final result = Process.runSync('chmod', [
              mode.toRadixString(8),
              path,
            ]);
            if (result.exitCode != 0) {
              throw const FormatException(shewallAclChmod);
            }
          },
        ),
      ),
      throwsA(_message(shewallAclChmod)),
    );
    expect(dest.readAsBytesSync(), [1, 2, 3, 4]);
    expect(_temps(dir), isEmpty);
  });

  test(
    'a symlink named shewall.bin is refused and its target is unchanged',
    () {
      final dir = _tempDir();
      final real = File(p.join(dir.path, 'real'))..writeAsBytesSync([7, 7, 7]);
      final linkPath = p.join(dir.path, shewallName);
      Link(linkPath).createSync(real.path);
      expect(
        () => writePrivateShewallSync(File(linkPath), Uint8List.fromList([1])),
        throwsA(_message(shewallAclSymlink)),
      );
      expect(real.readAsBytesSync(), [7, 7, 7]);
      expect(
        FileSystemEntity.typeSync(linkPath, followLinks: false),
        FileSystemEntityType.link,
      );
      expect(_temps(dir), isEmpty);
    },
  );

  test('a symlink directory is refused and the real directory stays empty', () {
    final root = _tempDir();
    final real = Directory(p.join(root.path, 'real'))..createSync();
    Link(p.join(root.path, 'link')).createSync(real.path);
    expect(
      () => writePrivateShewallSync(
        File(p.join(root.path, 'link', shewallName)),
        Uint8List.fromList([1, 2]),
      ),
      throwsA(_message(shewallAclSymlink)),
    );
    expect(real.listSync(), isEmpty);
  });

  test('JSON is refused before a file or temp is created', () {
    final dir = _tempDir();
    final dest = File(p.join(dir.path, shewallName));
    expect(
      () => writePrivateShewallSync(dest, Uint8List.fromList([0x7b, 0x7d])),
      throwsA(_message('json_refused')),
    );
    expect(dest.existsSync(), isFalse);
    expect(_temps(dir), isEmpty);
  });

  test('the shared system temp directory is not locked down', () {
    final tmp = Directory.systemTemp;
    final before = FileStat.statSync(tmp.path).mode & _modeMask;
    final dest = File(p.join(tmp.path, shewallName));
    final existed = dest.existsSync();
    expect(
      () => writePrivateShewallSync(dest, Uint8List.fromList([1])),
      throwsA(_message(shewallAclDir)),
    );
    expect(FileStat.statSync(tmp.path).mode & _modeMask, before);
    expect(dest.existsSync(), existed);
  });

  test(
    'saveShewallBytes and writeShewallFile use the private replace',
    () async {
      final caller = identityHashCode(Isolate.current).toString();
      final dir = _tempDir();
      final bytes = Uint8List.fromList([1, 2, 3, 4]);
      final exported = File(p.join(dir.path, 'Documents', shewallName));
      exported.parent.createSync(recursive: true);
      if (!Platform.isWindows) {
        Process.runSync('chmod', ['755', exported.parent.path]);
      }
      final path = await saveShewallBytes(bytes, dest: exported);
      expect(path, exported.path);
      expect(exported.readAsBytesSync(), bytes);
      if (!Platform.isWindows) {
        expect(
          FileStat.statSync(exported.path).mode & _modeMask,
          shewallFileMode,
        );
        expect(FileStat.statSync(exported.parent.path).mode & _modeMask, 0x1ed);
      }
      expect(debugShewallWriteStamp, isNotEmpty);
      expect(debugShewallWriteStamp, isNot(caller));

      final viaSession = File(p.join(dir.path, 'via-session', shewallName));
      viaSession.parent.createSync(recursive: true);
      if (!Platform.isWindows) {
        Process.runSync('chmod', ['755', viaSession.parent.path]);
      }
      final written = await writeShewallFile(viaSession, bytes);
      expect(written.path, viaSession.path);
      expect(viaSession.readAsBytesSync(), bytes);
      if (!Platform.isWindows) {
        expect(
          FileStat.statSync(viaSession.path).mode & _modeMask,
          shewallFileMode,
        );
        expect(
          FileStat.statSync(viaSession.parent.path).mode & _modeMask,
          0x1ed,
        );
      }
      expect(debugShewallWriteStamp, isNot(caller));
    },
  );

  test('Windows on D: ignores a planted C: System32 and PSModulePath', () {
    final dir = _tempDir();
    final dest = File(p.join(dir.path, shewallName));
    final probe = _WinProbe();
    writePrivateShewallSync(
      dest,
      Uint8List.fromList([1, 2, 3, 4]),
      io: probe.io(
        env: const {
          'SystemRoot': r'C:\Windows',
          'SYSTEMROOT': r'C:\Windows',
          'WINDIR': r'C:\Windows',
          'PSModulePath': r'C:\Evil\Modules',
          'PATH': r'C:\Evil',
        },
      ),
    );
    expect(dest.readAsBytesSync(), [1, 2, 3, 4]);
    expect(_temps(dir), isEmpty);
    expect(probe.calls, isNotEmpty);
    expect(
      probe.calls.every((call) => call.exe.startsWith(r'D:\Windows\System32\')),
      isTrue,
    );
    expect(
      probe.calls.any((call) => call.exe.toLowerCase().contains('powershell')),
      isFalse,
    );
    expect(
      probe.calls.any(
        (call) => call.exe.toLowerCase().startsWith(r'c:\windows\system32\'),
      ),
      isFalse,
    );
    expect(
      probe.calls.any((call) => call.exe.toLowerCase().contains('whoami')),
      isFalse,
    );
    expect(
      probe.calls.every((call) => call.includeParentEnvironment == false),
      isTrue,
    );
    expect(probe.descriptors, hasLength(1));
    expect(probe.descriptors.single, ownerOnlyFileSddl(_userSid));
    expect(
      shewallDaclIsOwnerOnly(
        probe.descriptors.single,
        ownerSid: _userSid,
        directory: false,
      ),
      isTrue,
    );

    final grants = probe.calls
        .where((call) => call.args.contains('/grant:r'))
        .toList();
    expect(grants.length, 1);
    expect(grants.any((call) => call.args.first == dir.path), isFalse);
    final fileGrant = grants.single;
    expect(fileGrant.exe, _dIcacls);
    expect(p.basename(fileGrant.args.first).startsWith('.shewall.'), isTrue);
    expect(fileGrant.args.sublist(1), [
      '/inheritance:r',
      '/grant:r',
      '*$_userSid:F',
      '*$systemSid:F',
      '*$administratorsSid:F',
      '/L',
    ]);
    expect(probe.calls.where((call) => call.args.contains('/save')).length, 2);

    final owners = probe.calls
        .where((call) => call.args.contains('/setowner'))
        .toList();
    expect(owners.length, 1);
    for (final call in owners) {
      expect(call.exe, _dIcacls);
      expect(call.args, contains('*$_userSid'));
      expect(call.args.contains('/T'), isFalse);
      expect(call.args, contains('/L'));
    }
    expect(probe.calls.any((call) => call.args.contains('/T')), isFalse);
    for (final call in probe.calls) {
      expect(call.env['SystemRoot'], r'D:\Windows');
      expect(call.env['WINDIR'], r'D:\Windows');
      expect(call.env['SystemDrive'], r'D:');
      expect(
        call.env.keys.map((key) => key.toLowerCase()),
        isNot(contains('psmodulepath')),
      );
      expect(call.env.values.contains(r'C:\Evil\Modules'), isFalse);
      expect(call.env.values.contains(r'C:\Windows'), isFalse);
      expect(call.env.containsKey('PATH'), isFalse);
      expect(call.includeParentEnvironment, isFalse);
    }
    final flat = probe.calls
        .map((call) => [call.exe, ...call.args].join('\n'))
        .join('\n');
    expect(flat.contains(_localName), isFalse);
    expect(flat.contains(r'C:\Windows\System32'), isFalse);
  });

  test('GetSystemDirectoryW must match the HKLM SystemRoot', () {
    final dir = _tempDir();
    final dest = File(p.join(dir.path, shewallName))..writeAsBytesSync([1, 2]);
    var calls = 0;
    expect(
      () => writePrivateShewallSync(
        dest,
        Uint8List.fromList([9]),
        io: ShewallAclIo(
          windows: true,
          env: const {
            'SystemRoot': r'C:\Windows',
            'PSModulePath': r'C:\Evil\Modules',
          },
          systemDirectory: () => r'C:\Windows\System32',
          registrySystemRoot: () => r'D:\Windows',
          system32Verified: (path) =>
              path.toLowerCase().startsWith(r'c:\windows\system32\'),
          run:
              (
                executable,
                args, {
                environment,
                includeParentEnvironment = true,
              }) {
                calls += 1;
                return executable + args.join();
              },
        ),
      ),
      throwsA(_message(shewallAclSystem32)),
    );
    expect(calls, 0);
    expect(dest.readAsBytesSync(), [1, 2]);
    expect(_temps(dir), isEmpty);
  });

  test('a bad app-directory DACL does not replace shewall.bin', () {
    final support = _tempDir();
    final app = Directory(shewallAppDirectory(support.path))..createSync();
    final dest = File(p.join(app.path, shewallName))
      ..writeAsBytesSync([1, 2, 3]);
    final probe = _WinProbe(
      dirSddl:
          'O:$_userSid D:P(A;OICI;FA;;;WD)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)',
    );
    expect(
      () => writePrivateShewallSync(
        dest,
        Uint8List.fromList([9]),
        io: probe.io(),
        applicationSupport: support.path,
      ),
      throwsA(_message(shewallAclDacl)),
    );
    expect(dest.readAsBytesSync(), [1, 2, 3]);
    expect(_temps(app), isEmpty);
    expect(
      probe.calls.any(
        (call) =>
            call.args.contains('/grant:r') &&
            p.basename(call.args.first).startsWith('.shewall.'),
      ),
      isFalse,
    );
    final picked = _tempDir();
    final pickedDest = File(p.join(picked.path, shewallName))
      ..writeAsBytesSync([1, 2, 3]);
    final pickedProbe = _WinProbe(dirSddl: probe.dirSddl);
    writePrivateShewallSync(
      pickedDest,
      Uint8List.fromList([9]),
      io: pickedProbe.io(),
      applicationSupport: support.path,
    );
    expect(pickedDest.readAsBytesSync(), [9]);
    expect(
      pickedProbe.calls.any((call) => call.args.first == picked.path),
      isFalse,
    );
  });

  test('a wrong owner SID leaves the previous shewall.bin', () {
    final dir = _tempDir();
    final dest = File(p.join(dir.path, shewallName))..writeAsBytesSync([4, 4]);
    final probe = _WinProbe(owner: 'S-1-5-21-9-9-9-9');
    expect(
      () => writePrivateShewallSync(
        dest,
        Uint8List.fromList([1]),
        io: probe.io(),
      ),
      throwsA(_message(shewallAclDacl)),
    );
    expect(dest.readAsBytesSync(), [4, 4]);
    expect(_temps(dir), isEmpty);
    expect(
      probe.calls.any((call) => call.exe.toLowerCase().contains('powershell')),
      isFalse,
    );
  });

  test('a Windows DACL mismatch leaves the previous shewall.bin', () {
    final dir = _tempDir();
    final dest = File(p.join(dir.path, shewallName))
      ..writeAsBytesSync([1, 2, 3]);
    final probe = _WinProbe(
      fileSddl: 'O:$_userSid D:P(A;;FA;;;$_userSid)(A;;FA;;;WD)(A;;FA;;;SY)',
    );
    expect(
      () => writePrivateShewallSync(
        dest,
        Uint8List.fromList([9, 9]),
        io: probe.io(),
      ),
      throwsA(_message(shewallAclDacl)),
    );
    expect(dest.readAsBytesSync(), [1, 2, 3]);
    expect(_temps(dir), isEmpty);
    expect(
      probe.calls.any((call) => call.exe == 'icacls' || call.exe == 'whoami'),
      isFalse,
    );
  });

  test('an unverified System32 binary is not executed', () {
    final dir = _tempDir();
    final dest = File(p.join(dir.path, shewallName))..writeAsBytesSync([4, 5]);
    var calls = 0;
    expect(
      () => writePrivateShewallSync(
        dest,
        Uint8List.fromList([1]),
        io: ShewallAclIo(
          windows: true,
          env: const {
            'SystemRoot': r'C:\Windows',
            'PSModulePath': r'C:\Evil\Modules',
          },
          systemDirectory: () => r'D:\Windows\System32',
          registrySystemRoot: () => r'D:\Windows',
          readUserSid: () => _userSid,
          createOwnerOnly: (path, bytes, sddl) {
            File(path).writeAsBytesSync(bytes);
          },
          system32Verified: (_) => false,
          run:
              (
                executable,
                args, {
                environment,
                includeParentEnvironment = true,
              }) {
                calls += 1;
                return executable + args.join();
              },
        ),
      ),
      throwsA(_message(shewallAclSystem32)),
    );
    expect(calls, 0);
    expect(dest.readAsBytesSync(), [4, 5]);
    expect(_temps(dir), isEmpty);
  });

  test('a token value that is not a SID does not grant', () {
    final dir = _tempDir();
    final dest = File(p.join(dir.path, shewallName))..writeAsBytesSync([6]);
    final probe = _WinProbe(sid: 'not a sid');
    expect(
      () => writePrivateShewallSync(
        dest,
        Uint8List.fromList([1]),
        io: probe.io(),
      ),
      throwsA(_message(shewallAclToken)),
    );
    expect(probe.calls, isEmpty);
    expect(probe.descriptors, isEmpty);
    expect(dest.readAsBytesSync(), [6]);
    expect(_temps(dir), isEmpty);
  });

  test('Windows hardens the app directory and not a picked folder', () {
    final support = _tempDir();
    final app = Directory(shewallAppDirectory(support.path))..createSync();
    final probe = _WinProbe();
    writePrivateShewallSync(
      File(p.join(app.path, shewallName)),
      Uint8List.fromList([1, 2]),
      io: probe.io(),
      applicationSupport: support.path,
    );
    final dirGrants = probe.calls
        .where(
          (call) =>
              call.args.contains('/grant:r') && call.args.first == app.path,
        )
        .toList();
    expect(dirGrants, hasLength(1));
    expect(dirGrants.single.args, [
      app.path,
      '/inheritance:r',
      '/grant:r',
      '*$_userSid:(OI)(CI)F',
      '*$systemSid:(OI)(CI)F',
      '*$administratorsSid:(OI)(CI)F',
      '/L',
    ]);
    expect(dirGrants.single.args.contains('/T'), isFalse);
    expect(dirGrants.single.includeParentEnvironment, isFalse);
    expect(
      probe.calls.every((call) => call.includeParentEnvironment == false),
      isTrue,
    );
  });

  test('owner-only SDDL accepts SID aliases and a group prefix', () {
    expect(
      resolveWindowsSystem32(
        systemDirectory: r'D:\Windows\System32',
        registrySystemRoot: r'D:\Windows',
      ),
      r'D:\Windows\System32',
    );
    expect(
      resolveWindowsSystem32(
        systemDirectory: r'D:\Windows\System32\',
        registrySystemRoot: r'd:\windows',
      ),
      r'D:\Windows\System32',
    );
    expect(
      () => resolveWindowsSystem32(
        systemDirectory: r'C:\Windows\System32',
        registrySystemRoot: r'D:\Windows',
      ),
      throwsA(_message(shewallAclSystem32)),
    );
    expect(
      () => system32Exe('whoami.exe', r'D:\Windows\System32'),
      throwsA(_message(shewallAclSystem32)),
    );
    expect(system32Exe('icacls.exe', r'D:\Windows\System32'), _dIcacls);
    expect(
      () => system32Exe('powershell.exe', r'D:\Windows\System32'),
      throwsA(_message(shewallAclSystem32)),
    );
    expect(
      () => system32Exe(r'..\whoami.exe', r'D:\Windows\System32'),
      throwsA(_message(shewallAclSystem32)),
    );
    expect(
      shewallDaclIsOwnerOnly(
        'O:$_userSid D:P(A;;FA;;;$_userSid)(A;;FA;;;SY)(A;;FA;;;BA)',
        ownerSid: _userSid,
        directory: false,
      ),
      isTrue,
    );
    expect(
      shewallDaclIsOwnerOnly(
        'O:$_userSid G:S-1-5-21-1-2-3-513D:P(A;;FA;;;$_userSid)(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)',
        ownerSid: _userSid,
        directory: false,
      ),
      isTrue,
    );
    expect(
      shewallDaclIsOwnerOnly(
        'O:$_userSid D:PAI(A;OICI;FA;;;$_userSid)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)',
        ownerSid: _userSid,
        directory: true,
      ),
      isTrue,
    );
  });

  test('SDDL readback rejects other trustees and a missing protect bit', () {
    const good = 'O:$_userSid D:P(A;;FA;;;$_userSid)(A;;FA;;;SY)(A;;FA;;;BA)';
    expect(
      shewallDaclIsOwnerOnly(good, ownerSid: _userSid, directory: true),
      isFalse,
    );
    expect(
      shewallDaclIsOwnerOnly(
        'O:$_userSid D:P(A;;FA;;;$_userSid)(A;;FA;;;WD)(A;;FA;;;SY)',
        ownerSid: _userSid,
        directory: false,
      ),
      isFalse,
    );
    expect(
      shewallDaclIsOwnerOnly(
        'O:$_userSid D:P(A;;FA;;;$_userSid)(A;;FA;;;BU)(A;;FA;;;BA)',
        ownerSid: _userSid,
        directory: false,
      ),
      isFalse,
    );
    expect(
      shewallDaclIsOwnerOnly(
        'O:$_userSid D:P(A;;FA;;;$_userSid)(A;;FA;;;AU)(A;;FA;;;SY)',
        ownerSid: _userSid,
        directory: false,
      ),
      isFalse,
    );
    expect(
      shewallDaclIsOwnerOnly(
        'O:$_userSid D:P(A;;FA;;;S-1-1-0)(A;;FA;;;SY)(A;;FA;;;BA)',
        ownerSid: _userSid,
        directory: false,
      ),
      isFalse,
    );
    expect(
      shewallDaclIsOwnerOnly(
        'O:$_userSid D:(A;;FA;;;$_userSid)(A;;FA;;;SY)(A;;FA;;;BA)',
        ownerSid: _userSid,
        directory: false,
      ),
      isFalse,
    );
    expect(
      shewallDaclIsOwnerOnly(
        'O:S-1-5-21-9-9-9-9D:P(A;;FA;;;$_userSid)(A;;FA;;;SY)(A;;FA;;;BA)',
        ownerSid: _userSid,
        directory: false,
      ),
      isFalse,
    );
    expect(
      shewallDaclIsOwnerOnly(
        'O:$_userSid D:P(A;ID;FA;;;$_userSid)(A;;FA;;;SY)(A;;FA;;;BA)',
        ownerSid: _userSid,
        directory: false,
      ),
      isFalse,
    );
  });

  test('arm64 open flags and st_mode differ from x86_64', () {
    expect(linuxOpenFlags(Abi.linuxX64).nofollow, 0x20000);
    expect(linuxOpenFlags(Abi.linuxX64).directory, 0x10000);
    expect(linuxOpenFlags(Abi.linuxIA32).nofollow, 0x20000);
    expect(linuxOpenFlags(Abi.androidX64).directory, 0x10000);
    expect(linuxOpenFlags(Abi.linuxArm64).nofollow, 0x8000);
    expect(linuxOpenFlags(Abi.linuxArm64).directory, 0x4000);
    expect(linuxOpenFlags(Abi.androidArm64).nofollow, 0x8000);
    expect(linuxOpenFlags(Abi.androidArm64).directory, 0x4000);
    expect(linuxOpenFlags(Abi.linuxArm).directory, 0x4000);
    expect(linuxStatModeOffset(Abi.linuxX64), 24);
    expect(linuxStatModeOffset(Abi.androidX64), 24);
    expect(linuxStatModeOffset(Abi.linuxArm64), 16);
    expect(linuxStatModeOffset(Abi.androidArm64), 16);
    expect(linuxFstatVersion(Abi.linuxX64), 1);
    expect(linuxFstatVersion(Abi.linuxArm64), 0);
    expect(linuxFstatVersion(Abi.androidArm64), 0);
    expect(
      () => linuxOpenFlags(Abi.windowsX64),
      throwsA(_message(shewallAclIoError)),
    );
    expect(
      () => linuxStatModeOffset(Abi.macosArm64),
      throwsA(_message(shewallAclIoError)),
    );

    final buf = Uint8List(256);
    final data = ByteData.sublistView(buf);
    data.setUint32(16, 0x8000 | shewallFileMode, Endian.host);
    data.setUint32(24, 0x8000 | 0x1ff, Endian.host);
    expect(statModeAt(buf, abi: Abi.linuxArm64) & _modeMask, shewallFileMode);
    expect(statModeAt(buf, abi: Abi.androidArm64) & _modeMask, shewallFileMode);
    expect(statModeAt(buf, abi: Abi.linuxX64) & _modeMask, 0x1ff);
    expect(statModeAt(buf, abi: Abi.androidX64) & _modeMask, 0x1ff);

    expect(selectLinuxFstatSymbol((name) => name == 'fstat'), 'fstat');
    expect(
      selectLinuxFstatSymbol((name) => name == '__fxstat64'),
      '__fxstat64',
    );
    expect(selectLinuxFstatSymbol((name) => name == '__fxstat'), '__fxstat');
    expect(selectLinuxFstatSymbol((_) => false), isNull);
    if (Platform.isLinux) {
      final libc = DynamicLibrary.open('libc.so.6');
      expect(selectLinuxFstatSymbol(libc.providesSymbol), 'fstat');
      expect(Abi.current(), Abi.linuxX64);
      expect(linuxOpenFlags(Abi.current()).nofollow, 0x20000);
      expect(linuxOpenFlags(Abi.current()).directory, 0x10000);
      expect(linuxStatModeOffset(Abi.current()), 24);
    }
  });
}

Directory _tempDir() {
  final dir = Directory.systemTemp.createTempSync('shear-shewall-acl-');
  addTearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });
  return dir;
}

Iterable<String> _temps(Directory dir) {
  return dir
      .listSync()
      .map((entity) => p.basename(entity.path))
      .where((name) => name.startsWith('.shewall.'));
}

Matcher _message(String code) {
  return isA<FormatException>().having(
    (error) => error.message,
    'message',
    code,
  );
}

final class _Call {
  _Call(this.exe, this.args, this.env, this.includeParentEnvironment);
  final String exe;
  final List<String> args;
  final Map<String, String> env;
  final bool includeParentEnvironment;
}

final class _WinProbe {
  _WinProbe({this.fileSddl, this.dirSddl, this.sid, this.owner});

  final String? fileSddl;
  final String? dirSddl;
  final String? sid;
  final String? owner;
  final calls = <_Call>[];
  final descriptors = <String>[];

  ShewallAclIo io({Map<String, String> env = const {}}) {
    return ShewallAclIo(
      windows: true,
      env: env,
      systemDirectory: () => r'D:\Windows\System32',
      registrySystemRoot: () => r'D:\Windows',
      readUserSid: () => sid ?? _userSid,
      readOwner: (_) => owner ?? _userSid,
      createOwnerOnly: (path, bytes, sddl) {
        descriptors.add(sddl);
        File(path).writeAsBytesSync(bytes);
      },
      system32Verified: (path) {
        final lower = path.toLowerCase();
        // A planted C: copy exists. The writer must not select it.
        if (lower.startsWith(r'c:\windows\system32\')) return true;
        return lower == _dIcacls.toLowerCase();
      },
      run: (executable, args, {environment, includeParentEnvironment = true}) {
        calls.add(
          _Call(
            executable,
            args,
            environment ?? const {},
            includeParentEnvironment,
          ),
        );
        if (args.contains('/save')) {
          final index = args.indexOf('/save');
          final target = args.first;
          final file =
              p.basename(target) == shewallName ||
              p.basename(target).startsWith('.shewall.');
          final sddl = file
              ? (fileSddl ??
                    'O:$_userSid D:P(A;;FA;;;$_userSid)(A;;FA;;;SY)(A;;FA;;;BA)')
              : (dirSddl ??
                    'O:$_userSid D:P(A;OICI;FA;;;$_userSid)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)');
          File(args[index + 1]).writeAsStringSync(sddl);
        }
        return 'Successfully processed 1 files\r\n';
      },
    );
  }
}
