import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';

/// True when this isolate has a Flutter binding. A worker isolate does not.
bool rangeOnUiIsolate() {
  try {
    SchedulerBinding.instance;
    return true;
  } catch (_) {
    return false;
  }
}

/// Profile and release throw when the range call is on the UI isolate.
/// Debug asserts, and flutter_tester may stay on the caller.
void requireRangeOffUi({bool? enforce}) {
  if (!rangeOnUiIsolate()) return;
  final releaseProfile = enforce ?? (kReleaseMode || kProfileMode);
  if (releaseProfile) throw StateError('range_on_ui_isolate');
  assert(
    debugFlowCryptoOnCaller || Platform.environment['FLUTTER_TEST'] == 'true',
    'range proof ran on the UI isolate',
  );
}

/// Set by tests that seal on the caller. flutter_tester deadlocks around
/// [Isolate.spawn] and the native prover.
bool debugFlowCryptoOnCaller = false;
