import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

/// Owns the node [Process] on a background isolate. The UI isolate only
/// receives log lines and sends kill.
class NodeProcHandle {
  NodeProcHandle(this._cmd, this._lines);

  final SendPort _cmd;
  final ReceivePort _lines;
  StreamSubscription<dynamic>? _sub;

  void listen(void Function(String line) onLine) {
    _sub = _lines.listen((event) {
      if (event is String && event.isNotEmpty) onLine(event);
    });
  }

  /// [Process.kill] runs in the owner isolate. [wait] completes when that
  /// isolate has killed the process, or after a short ack timeout.
  Future<void> kill({bool wait = true}) async {
    await _sub?.cancel();
    _sub = null;
    if (!wait) {
      _cmd.send('kill');
      return;
    }
    final ack = ReceivePort();
    _cmd.send(<String, Object>{'op': 'kill', 'ack': ack.sendPort});
    try {
      await ack.first.timeout(const Duration(seconds: 3));
    } catch (_) {}
    ack.close();
  }
}

Future<NodeProcHandle> startNodeProcessOffUi({
  required String binary,
  required List<String> args,
  required Map<String, String> environment,
  String? workingDirectory,
}) async {
  final lines = ReceivePort();
  final ready = ReceivePort();
  try {
    await Isolate.spawn(
      _nodeProcMain,
      <String, Object?>{
        'binary': binary,
        'args': args,
        'env': environment,
        'cwd': workingDirectory,
        'lines': lines.sendPort,
        'ready': ready.sendPort,
      },
      debugName: 'shear-node-proc',
    );
    final readyMsg = await ready.first;
    if (readyMsg is! SendPort) {
      throw StateError('node_start:${readyMsg ?? 'failed'}');
    }
    return NodeProcHandle(readyMsg, lines);
  } catch (_) {
    lines.close();
    rethrow;
  } finally {
    ready.close();
  }
}

Future<void> _nodeProcMain(Map<String, Object?> msg) async {
  final lines = msg['lines']! as SendPort;
  final ready = msg['ready']! as SendPort;
  final commands = ReceivePort();
  final Process proc;
  try {
    proc = await Process.start(
      msg['binary']! as String,
      (msg['args']! as List).cast<String>(),
      workingDirectory: msg['cwd'] as String?,
      environment: Map<String, String>.from(msg['env']! as Map),
      mode: ProcessStartMode.normal,
    );
  } catch (e) {
    ready.send('$e');
    commands.close();
    return;
  }
  ready.send(commands.sendPort);
  final outSub = proc.stdout
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .listen(lines.send);
  final errSub = proc.stderr
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .listen(lines.send);
  await for (final raw in commands) {
    final kill = raw == 'kill' || (raw is Map && raw['op'] == 'kill');
    if (!kill) continue;
    proc.kill();
    await outSub.cancel();
    await errSub.cancel();
    final ack = raw is Map ? raw['ack'] : null;
    if (ack is SendPort) ack.send(true);
    break;
  }
  commands.close();
}
