/// SHA-256 of the bundled libshearhash.
///
/// Desktop and the single-library hosts pass
/// `--dart-define=SHEAR_HASH_SHA256=<hex>` before `flutter build`.
/// Android ships four ABIs, so one pin cannot load every library. The
/// release build passes
/// `--dart-define=SHEAR_HASH_SHA256_ANDROID=armeabi-v7a=<hex>,arm64-v8a=<hex>,x86=<hex>,x86_64=<hex>`.
/// Empty refuses the load. The stamp script does not edit this file.
/// Android hashes the extracted library beside `libflutter.so` before
/// dlopen. macOS is the Desktop handoff, not CI.
const String kShearHashSha256 = String.fromEnvironment('SHEAR_HASH_SHA256');

/// Comma-separated `abi=sha256` for every ABI packaged in the APK.
const String kShearHashSha256Android =
    String.fromEnvironment('SHEAR_HASH_SHA256_ANDROID');

/// ABIs the wallet APK ships. The pin map must name each of these.
const List<String> kShearHashAndroidAbis = <String>[
  'armeabi-v7a',
  'arm64-v8a',
  'x86',
  'x86_64',
];

/// Parse [raw] (`abi=hex` pairs, or a full `--dart-define=` line).
/// A short or unknown entry is dropped. The caller fails closed on a gap.
Map<String, String> parseShearHashAndroidPins(String raw) {
  var text = raw.trim();
  const flag = 'SHEAR_HASH_SHA256_ANDROID=';
  final at = text.indexOf(flag);
  if (at >= 0) text = text.substring(at + flag.length);
  final out = <String, String>{};
  if (text.isEmpty) return out;
  for (final part in text.split(',')) {
    final piece = part.trim();
    final i = piece.indexOf('=');
    if (i <= 0) continue;
    final abi = piece.substring(0, i).trim();
    final hex = piece.substring(i + 1).trim().toLowerCase();
    if (!kShearHashAndroidAbis.contains(abi)) continue;
    if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(hex)) continue;
    out[abi] = hex;
  }
  return out;
}

/// Shipped ABI for an extracted library path. Android's install layout uses
/// `arm64` and `arm` as well as the APK names `arm64-v8a` and `armeabi-v7a`.
String? androidAbiFromLibraryPath(String path) {
  final parts = path.replaceAll('\\', '/').split('/');
  for (var i = parts.length - 1; i >= 0; i--) {
    switch (parts[i]) {
      case 'arm64-v8a':
      case 'arm64':
      case 'aarch64':
        return 'arm64-v8a';
      case 'armeabi-v7a':
      case 'armeabi':
      case 'arm':
        return 'armeabi-v7a';
      case 'x86_64':
      case 'x64':
        return 'x86_64';
      case 'x86':
        return 'x86';
    }
  }
  return null;
}
