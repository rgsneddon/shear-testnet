import 'dart:io';

// Flutter only where Flutter is: the plain-Dart graph (the CLI and the T18
// production-hop check) must not import package:flutter, which needs dart:ui.
import 'shear_ui_binding.dart' if (dart.library.ui) 'shear_ui_binding_flutter.dart';

/// flutter/foundation kReleaseMode and kProfileMode, the same definitions.
const bool _kReleaseMode = bool.fromEnvironment('dart.vm.product');
const bool _kProfileMode = bool.fromEnvironment('dart.vm.profile');

/// True when this isolate has a Flutter binding. A worker isolate does not.
bool rangeOnUiIsolate() => hasFlutterBinding();

/// Profile and release throw when the range call is on the UI isolate.
/// Debug asserts, and flutter_tester may stay on the caller.
void requireRangeOffUi({bool? enforce}) {
  if (!rangeOnUiIsolate()) return;
  final releaseProfile = enforce ?? (_kReleaseMode || _kProfileMode);
  if (releaseProfile) throw StateError('range_on_ui_isolate');
  assert(
    debugFlowCryptoOnCaller || Platform.environment['FLUTTER_TEST'] == 'true',
    'range proof ran on the UI isolate',
  );
}

/// Set by tests that seal on the caller. flutter_tester deadlocks around
/// [Isolate.spawn] and the native prover.
bool debugFlowCryptoOnCaller = false;
