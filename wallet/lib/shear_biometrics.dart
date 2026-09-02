import 'dart:io';

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

  static const _key = 'shear.wallet.password';
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
      await _store.write(key: _key, value: password);
    } catch (_) {}
  }

  @override
  Future<String?> recalledPassword() async {
    try {
      return await _store.read(key: _key);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> forget() async {
    try {
      await _store.delete(key: _key);
    } catch (_) {}
  }
}
