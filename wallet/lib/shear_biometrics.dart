import 'dart:io';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';

/// macOS Touch ID in a sandboxed app fails with biometricOnly + data-protection keychain.
AuthenticationOptions shearAuthOptions({bool macos = false}) {
  if (macos) {
    return const AuthenticationOptions(
      biometricOnly: false,
      stickyAuth: true,
      useErrorDialogs: true,
    );
  }
  return const AuthenticationOptions(biometricOnly: true, stickyAuth: true);
}

/// Optional convenience unlock. The wallet password remains the shewall.bin key.
abstract class ShearBiometrics {
  Future<bool> get available;
  Future<bool> authenticate({String reason = 'Unlock Shear'});
  Future<void> rememberPassword(String password);
  Future<String?> recalledPassword();
  Future<void> forget();
}

class NoBiometrics implements ShearBiometrics {
  const NoBiometrics();

  @override
  Future<bool> get available async => false;

  @override
  Future<bool> authenticate({String reason = 'Unlock Shear'}) async => false;

  @override
  Future<void> rememberPassword(String password) async {}

  @override
  Future<String?> recalledPassword() async => null;

  @override
  Future<void> forget() async {}
}

/// In-memory stand-in for tests. Production uses [DeviceBiometrics].
class MemoryBiometrics implements ShearBiometrics {
  MemoryBiometrics({this.canAuth = true, this.passAuth = true});

  bool canAuth;
  bool passAuth;
  String? stored;

  @override
  Future<bool> get available async => canAuth;

  @override
  Future<bool> authenticate({String reason = 'Unlock Shear'}) async => passAuth;

  @override
  Future<void> rememberPassword(String password) async {
    stored = password;
  }

  @override
  Future<String?> recalledPassword() async => stored;

  @override
  Future<void> forget() async {
    stored = null;
  }
}

class DeviceBiometrics implements ShearBiometrics {
  DeviceBiometrics({
    LocalAuthentication? auth,
    FlutterSecureStorage? store,
  })  : _auth = auth ?? LocalAuthentication(),
        _store = store ??
            const FlutterSecureStorage(
              mOptions: MacOsOptions(useDataProtectionKeyChain: false),
            );

  static const _tokenKey = 'shear.wallet.unlock';
  static const _wrapKey = 'shear.wallet.wrap';
  final LocalAuthentication _auth;
  final FlutterSecureStorage _store;

  @override
  Future<bool> get available async {
    try {
      final can = await _auth.canCheckBiometrics;
      final support = await _auth.isDeviceSupported();
      return can || support;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> authenticate({String reason = 'Unlock Shear'}) async {
    try {
      return await _auth.authenticate(
        localizedReason: reason,
        options: shearAuthOptions(macos: Platform.isMacOS),
      );
    } catch (_) {
      if (!Platform.isMacOS) return false;
      try {
        return await _auth.authenticate(
          localizedReason: reason,
          options: shearAuthOptions(macos: true),
        );
      } catch (_) {
        return false;
      }
    }
  }

  @override
  Future<void> rememberPassword(String password) async {
    try {
      final rnd = Random.secure();
      final tok = List<int>.generate(32, (_) => rnd.nextInt(256))
          .map((b) => b.toRadixString(16).padLeft(2, '0'))
          .join();
      await _store.write(key: _tokenKey, value: tok);
      final wrap = _wrapSecret(password, tok);
      await _store.write(key: _wrapKey, value: wrap);
    } catch (_) {}
  }

  @override
  Future<String?> recalledPassword() async {
    try {
      final tok = await _store.read(key: _tokenKey);
      final wrap = await _store.read(key: _wrapKey);
      if (tok == null || wrap == null) return null;
      return _unwrapSecret(wrap, tok);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> forget() async {
    try {
      await _store.delete(key: _tokenKey);
      await _store.delete(key: _wrapKey);
    } catch (_) {}
  }
}

String _wrapSecret(String password, String token) {
  final p = password.codeUnits;
  final t = token.codeUnits;
  final out = StringBuffer();
  for (var i = 0; i < p.length; i++) {
    out.write(((p[i] ^ t[i % t.length]) & 0xff).toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}

String _unwrapSecret(String wrap, String token) {
  final t = token.codeUnits;
  final chars = <int>[];
  for (var i = 0; i < wrap.length; i += 2) {
    final b = int.parse(wrap.substring(i, i + 2), radix: 16);
    chars.add(b ^ t[(i ~/ 2) % t.length]);
  }
  return String.fromCharCodes(chars);
}
