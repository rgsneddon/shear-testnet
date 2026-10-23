import 'shear_chain_params.dart';

export 'shear_chain_params.dart' show kDevFingerprintSha;

/// Dev book. Compile-time pin. No dart-define.
const String kBookMagic = 'shear-dev';

/// Node spawn env for the dev book. Release closureSpawnEnv is unchanged.
/// P2P and stratum stay unset here, so the process uses the dev defaults
/// 31303 and 11211. A deployment unit sets SHEAR_P2P_PORT=30303 and
/// SHEAR_STRATUM=1111. The sidecar dial is the pool port, not the node ipc.
Map<String, String> devNodeEnv({required String dataDir, String rpcToken = ''}) {
  final row = kChainParams[kBookMagic]!;
  return <String, String>{
    'SHEAR_NETWORK': kBookMagic,
    'SHEAR_DATA': dataDir,
    'SHEAR_RPC_BIND': '127.0.0.1',
    'SHEAR_RPC_PORT': '${row.rpcPort}',
    'SHEAR_P2P_BIND': '127.0.0.1',
    'SHEAR_STRATUM_BIND': '127.0.0.1',
    'SHEAR_P2P_IPC': '127.0.0.1:31314',
    'SHEAR_SEEDS': '',
    'SHEAR_RPC_TOKEN': rpcToken,
  };
}
