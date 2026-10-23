import 'dart:io';

import 'package:shear_wallet/shear_checkpoint.dart';

/// Without `--release`, this is the pull-request self-test: a placeholder must
/// be rejected by [requireReleaseCheckpoint], and a real pin must pass.
/// `--release` is the release job. A placeholder or empty pin exits 1.
void main(List<String> args) {
  if (args.contains('--release')) {
    try {
      requireReleaseCheckpoint();
    } on StateError catch (e) {
      stderr.writeln('checkpoint pin guard: $e');
      exit(1);
    }
    return;
  }
  final placeholder =
      kCheckpointIsPlaceholder || !checkpointPinWellFormed(kReleaseCheckpoint);
  if (!placeholder) {
    requireReleaseCheckpoint();
    return;
  }
  try {
    requireReleaseCheckpoint();
  } on StateError {
    return;
  }
  stderr.writeln('checkpoint pin guard accepted an empty pin');
  exit(1);
}
