/// SHA-256 of the bundled libshearhash. Pack and release jobs pass
/// `--dart-define=SHEAR_HASH_SHA256=<hex>` before `flutter build`.
/// Empty refuses the load. The stamp script does not edit this file.
/// Android hashes the extracted library beside `libflutter.so` before
/// dlopen. macOS is the Desktop handoff, not CI.
const String kShearHashSha256 = String.fromEnvironment('SHEAR_HASH_SHA256');
