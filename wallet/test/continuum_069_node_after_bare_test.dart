import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_node_proc.dart';
import 'package:shear_wallet/shear_read_sync.dart';

Future<int> _freePort() async {
  final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = socket.port;
  await socket.close();
  return port;
}

Future<bool> _portFree(int port) async {
  try {
    final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, port);
    await socket.close();
    return true;
  } catch (_) {
    return false;
  }
}

void main() {
  test('flutter build dir still resolves the repo node entry', () {
    final libDir = '${Directory.current.path}${Platform.pathSeparator}lib';
    final packed = resolvePackagedNode(besideDir: libDir);
    expect(packed, isNotNull);
    expect(packed!.script, isNotNull);
    expect(packed.script!, contains('node${Platform.pathSeparator}src${Platform.pathSeparator}node.js'));
    expect(File(packed.script!).existsSync(), isTrue);
    expect(File(packed.binary).existsSync(), isTrue);
    expect(packed.workDir, isNotNull);
    expect(File('${packed.workDir}${Platform.pathSeparator}crypto${Platform.pathSeparator}asert.js').existsSync(), isTrue);
  });

  test('Connect bare apply starts the repo node and the wallet reads a block', () async {
    final previousOverrides = HttpOverrides.current;
    HttpOverrides.global = _RealHttpOverrides();
    addTearDown(() {
      HttpOverrides.global = previousOverrides;
    });
    final packed = resolvePackagedNode(besideDir: '${Directory.current.path}${Platform.pathSeparator}lib');
    expect(packed?.script, isNotNull, reason: 'repo node entry');
    final dir = Directory.systemTemp.createTempSync('c069-node-bare-');
    NodeProcHandle? handle;
    final lines = <String>[];
    addTearDown(() async {
      await handle?.kill();
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final rpcBusy = !await _portFree(18332);
    final p2pBusy = !await _portFree(30303);
    final rpcPort = rpcBusy ? await _freePort() : 18332;
    final p2pPort = p2pBusy ? await _freePort() : 30303;
    final side = ShearNodeSidecar(
      nodeBinary: packed!.binary,
      dataDir: dir.path,
      datadirEmpty: () => closureDatadirEmpty(dir.path),
      startProcess: (binary, env, args) async {
        final merged = Map<String, String>.from(Platform.environment)..addAll(env);
        merged['SHEAR_RPC_PORT'] = '$rpcPort';
        merged['SHEAR_P2P_PORT'] = '$p2pPort';
        final work = packed.workDir;
        if (work != null && work.isNotEmpty) {
          final delim = Platform.isWindows ? ';' : ':';
          final extra =
              '$work${Platform.pathSeparator}runtime$delim$work${Platform.pathSeparator}crypto${Platform.pathSeparator}native';
          merged['PATH'] = '$extra$delim${merged['PATH'] ?? ''}';
        }
        final started = await startNodeProcessOffUi(
          binary: binary,
          args: args,
          environment: merged,
          workingDirectory: work,
        );
        handle = started;
        started.listen(lines.add);
      },
    )
      ..nodeScript = packed.script
      ..workDir = packed.workDir;
    expect(side.committed, ClosureSendMode.connectBare);
    expect(closureDatadirEmpty(dir.path), isTrue);
    side.select(ClosureSendMode.localNode);
    final msg = await side.apply();
    expect(side.running, isTrue, reason: '$msg\n${lines.join('\n')}');
    expect(side.lastArgs, isEmpty);
    expect(side.lastEnv['SHEAR_DATA'], dir.path);
    expect(side.lastEnv.containsKey('SHEAR_BOOTSTRAP'), isFalse);

    final sep = Platform.pathSeparator;
    File chain() {
      final bin = File('${dir.path}${sep}chain.bin');
      if (bin.existsSync() && bin.lengthSync() > 0) return bin;
      return File('${dir.path}${sep}chain.jsonl');
    }
    final deadline = DateTime.now().add(const Duration(seconds: 90));
    while (DateTime.now().isBefore(deadline)) {
      final file = chain();
      if (file.existsSync() && file.lengthSync() > 0) break;
      await Future<void>.delayed(const Duration(seconds: 1));
    }
    final wrote = chain();
    expect(
      wrote.existsSync() && wrote.lengthSync() > 0,
      isTrue,
      reason: 'node wrote no chain file\n$msg\n${lines.join('\n')}',
    );

    final sync = ShearReadSync(
      seeds: ['http://127.0.0.1:$rpcPort'],
      jitter: Duration.zero,
    );
    final id = createIdentity();
    final ledger = ShearLedger(pool: ShearPoolClient(sync: sync))..bindIdentity(id);
    final readDeadline = DateTime.now().add(const Duration(seconds: 45));
    while (DateTime.now().isBefore(readDeadline) && sync.readBlocks.isEmpty) {
      await ledger.syncTip();
    }
    expect(sync.readBlocks, isNotEmpty, reason: lines.join('\n'));
    expect(sync.proofDest, isNotNull);
    expect(sync.proofDest, isNotEmpty);
    expect(ledger.displayHeight, greaterThan(0));
  }, timeout: const Timeout(Duration(minutes: 3)));
}

/// Flutter test binds a client that answers 400. The node is a real process.
class _RealHttpOverrides extends HttpOverrides {}
