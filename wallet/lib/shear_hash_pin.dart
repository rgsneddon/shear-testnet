/// SHA-256 of the bundled libshearhash. Pack and release jobs pass
/// `--dart-define=SHEAR_HASH_SHA256=<hex>` before `flutter build`.
/// Empty refuses a desktop load. The stamp script does not edit this file.
/// Android checks the `.sha256` sidecar in the jniLibs test; the loader
/// opens the packaged soname. macOS is the Desktop handoff, not CI.
const String kShearHashSha256 = String.fromEnvironment('SHEAR_HASH_SHA256');
