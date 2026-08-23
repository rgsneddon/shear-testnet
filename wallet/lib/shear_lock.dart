import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// Password-encrypted JSON envelope for shewall.json / session.
class ShearLock {
  static const kind = 'shear-shewall-v1-enc';
  static final _kdf = Pbkdf2(
    macAlgorithm: Hmac.sha256(),
    iterations: 100000,
    bits: 256,
  );
  static final _aes = AesGcm.with256bits();

  static Future<Map<String, dynamic>> seal(
    Map<String, dynamic> plain,
    String password,
  ) async {
    final salt = _rand(16);
    final nonce = _rand(12);
    final key = await _kdf.deriveKeyFromPassword(password: password, nonce: salt);
    final box = await _aes.encrypt(
      utf8.encode(jsonEncode(plain)),
      secretKey: key,
      nonce: nonce,
    );
    return {
      'kind': kind,
      'kdf': 'pbkdf2-sha256-100000',
      'cipher': 'aes-256-gcm',
      'salt': base64Encode(salt),
      'nonce': base64Encode(nonce),
      'mac': base64Encode(box.mac.bytes),
      'ct': base64Encode(box.cipherText),
    };
  }

  static Future<Map<String, dynamic>> open(
    Map<String, dynamic> env,
    String password,
  ) async {
    if (env['kind'] != kind) {
      throw const FormatException('not an encrypted shewall');
    }
    final salt = base64Decode(env['salt'] as String);
    final nonce = base64Decode(env['nonce'] as String);
    final mac = Mac(base64Decode(env['mac'] as String));
    final ct = base64Decode(env['ct'] as String);
    final key = await _kdf.deriveKeyFromPassword(password: password, nonce: salt);
    final clear = await _aes.decrypt(
      SecretBox(ct, nonce: nonce, mac: mac),
      secretKey: key,
    );
    return jsonDecode(utf8.decode(clear)) as Map<String, dynamic>;
  }

  static Uint8List _rand(int n) {
    final r = Random.secure();
    return Uint8List.fromList(List<int>.generate(n, (_) => r.nextInt(256)));
  }
}
