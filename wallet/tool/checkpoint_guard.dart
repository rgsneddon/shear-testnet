import 'dart:io';

import 'package:shear_wallet/shear_checkpoint.dart';

/// Fails the process when an empty or malformed pin would ship.
/// The v12 placeholder is rejected by [requireReleaseCheckpoint] and the
/// process exits 0 only because that rejection happened. A real pin must pass.
void main() {
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
