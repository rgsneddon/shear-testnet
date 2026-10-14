/// SHA-256 of the bundled Linux or Windows libshear_admit. Pack and release
/// jobs pass `--dart-define=SHEAR_ADMIT_SHA256=<hex>` before `flutter build`.
/// Empty refuses a profile or release load. The stamp script does not edit
/// this file. macOS checks the post-sign sidecar plus [kShearAdmitSignId].
/// Android checks the `.sha256` sidecar in the jniLibs test; the loader opens
/// the packaged soname.
const String kShearAdmitSha256 = String.fromEnvironment('SHEAR_ADMIT_SHA256');

/// macOS code-signature identity for the bundled dylib. Override with
/// `--dart-define=SHEAR_ADMIT_SIGN_ID=...`. An ad-hoc signature fails closed.
const String kShearAdmitSignId = String.fromEnvironment(
  'SHEAR_ADMIT_SIGN_ID',
  defaultValue: 'Developer ID Application: Russell Sneddon (SFCBP95595)',
);

/// Apple Team ID required by `/usr/bin/codesign --verify --strict`.
/// Override with `--dart-define=SHEAR_ADMIT_TEAM_ID=...`.
const String kShearAdmitTeamId = String.fromEnvironment(
  'SHEAR_ADMIT_TEAM_ID',
  defaultValue: 'SFCBP95595',
);
