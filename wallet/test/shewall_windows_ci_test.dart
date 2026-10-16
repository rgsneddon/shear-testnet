import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:shear_wallet/shear_session.dart';
import 'package:shear_wallet/shear_shewall.dart';
import 'package:shear_wallet/shear_shewall_acl.dart';

void main() {
  test('Windows SDDL space converts and shewall.bin round-trips', () async {
    if (!Platform.isWindows) {
      markTestSkipped('Windows security descriptor check');
      return;
    }
    final sid = _tokenSid();
    final sddl = ownerOnlyFileSddl(sid);
    // The production string puts one space between the owner and the DACL.
    expect(
      sddl,
      'O:$sid D:P(A;;FA;;;$sid)(A;;FA;;;$systemSid)(A;;FA;;;$administratorsSid)',
    );
    expect(sddl.contains(' '), isTrue);

    final dir = Directory.systemTemp.createTempSync('shear-win-sddl-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final probe = File(p.join(dir.path, 'descriptor.bin'));
    final readback = _createAndReadSddl(
      probe.path,
      sddl,
      Uint8List.fromList([9, 8, 7]),
    );
    // ignore: avoid_print
    print('sddl-in: $sddl');
    // ignore: avoid_print
    print('sddl-out: $readback');
    expect(probe.readAsBytesSync(), [9, 8, 7]);
    expect(
      shewallDaclIsOwnerOnly(readback, ownerSid: sid, directory: false),
      isTrue,
      reason: 'readback was $readback',
    );

    const password = 'correct-horse';
    final packed = Uint8List.fromList(List<int>.generate(32, (i) => i + 1));
    final sealed = await sealShewallBin(packed, password);
    final dest = File(p.join(dir.path, shewallName));
    final written = await writeShewallFile(dest, sealed);
    expect(written.path, dest.path);
    final loaded = await openShewallBin(readShewallFile(dest), password);
    expect(loaded, packed);
  });
}

final class _SecurityAttributes extends Struct {
  @Uint32()
  external int nLength;

  external Pointer<Void> lpSecurityDescriptor;

  @Int32()
  external int bInheritHandle;
}

String _tokenSid() {
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
      fail('OpenProcessToken ${_lastError(kernel)}');
    }
    final token = tokenOut.value;
    try {
      final needed = calloc<Uint32>();
      try {
        info(token, 1, Pointer<Uint8>.fromAddress(0), 0, needed);
        final size = needed.value;
        if (size < 8 || size > 4096) fail('GetTokenInformation size $size');
        final buf = calloc<Uint8>(size);
        try {
          final got = calloc<Uint32>();
          try {
            if (info(token, 1, buf, size, got) == 0) {
              fail('GetTokenInformation ${_lastError(kernel)}');
            }
          } finally {
            calloc.free(got);
          }
          final sid = buf.cast<Pointer<Void>>().value;
          if (sid == nullptr) fail('TokenUser SID missing');
          final text = calloc<Pointer<Utf16>>();
          try {
            if (convert(sid, text) == 0 || text.value == nullptr) {
              fail('ConvertSidToStringSidW ${_lastError(kernel)}');
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

String _createAndReadSddl(String path, String sddl, Uint8List bytes) {
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
      fail(
        'ConvertStringSecurityDescriptorToSecurityDescriptorW '
        '${_lastError(kernel)} for [$sddl]',
      );
    }
    sa.ref.nLength = sizeOf<_SecurityAttributes>();
    sa.ref.lpSecurityDescriptor = sdOut.value;
    sa.ref.bInheritHandle = 0;
    final handle = createFile(name, 0x40000000, 0, sa, 1, 0x80, 0);
    if (handle == 0 || handle == -1) {
      fail('CreateFileW ${_lastError(kernel)} for [$sddl]');
    }
    try {
      final data = malloc<Uint8>(bytes.length);
      final written = calloc<Uint32>();
      try {
        data.asTypedList(bytes.length).setAll(0, bytes);
        if (write(handle, data, bytes.length, written, nullptr) == 0 ||
            written.value != bytes.length) {
          fail('WriteFile ${_lastError(kernel)}');
        }
      } finally {
        malloc.free(data);
        calloc.free(written);
      }
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
  return _readSddl(path);
}

String _readSddl(String path) {
  final kernel = DynamicLibrary.open('kernel32.dll');
  final adv = DynamicLibrary.open('advapi32.dll');
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
  final toString = adv
      .lookupFunction<
        Int32 Function(
          Pointer<Void>,
          Uint32,
          Uint32,
          Pointer<Pointer<Utf16>>,
          Pointer<Uint32>,
        ),
        int Function(
          Pointer<Void>,
          int,
          int,
          Pointer<Pointer<Utf16>>,
          Pointer<Uint32>,
        )
      >('ConvertSecurityDescriptorToStringSecurityDescriptorW');
  final localFree = kernel
      .lookupFunction<
        Pointer<Void> Function(Pointer<Void>),
        Pointer<Void> Function(Pointer<Void>)
      >('LocalFree');
  final name = path.toNativeUtf16();
  final sdOut = calloc<Pointer<Void>>();
  final text = calloc<Pointer<Utf16>>();
  try {
    final rc = getNamed(
      name,
      1,
      0x5,
      Pointer<Pointer<Void>>.fromAddress(0),
      Pointer<Pointer<Void>>.fromAddress(0),
      Pointer<Pointer<Void>>.fromAddress(0),
      Pointer<Pointer<Void>>.fromAddress(0),
      sdOut,
    );
    if (rc != 0 || sdOut.value == nullptr) {
      fail('GetNamedSecurityInfoW $rc');
    }
    if (toString(sdOut.value, 1, 0x5, text, Pointer<Uint32>.fromAddress(0)) ==
            0 ||
        text.value == nullptr) {
      fail(
        'ConvertSecurityDescriptorToStringSecurityDescriptorW ${_lastError(kernel)}',
      );
    }
    final sddl = text.value.toDartString();
    localFree(text.value.cast<Void>());
    text.value = nullptr;
    return sddl;
  } finally {
    if (text.value != nullptr) localFree(text.value.cast<Void>());
    if (sdOut.value != nullptr) localFree(sdOut.value);
    calloc.free(text);
    calloc.free(sdOut);
    malloc.free(name);
  }
}

int _lastError(DynamicLibrary kernel) {
  return kernel.lookupFunction<Uint32 Function(), int Function()>(
    'GetLastError',
  )();
}
