import 'package:flutter/scheduler.dart';

/// True when this isolate has a Flutter binding. A worker isolate does not.
bool hasFlutterBinding() {
  try {
    SchedulerBinding.instance;
    return true;
  } catch (_) {
    return false;
  }
}
