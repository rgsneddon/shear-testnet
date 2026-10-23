import 'shear_chain_params.dart';

export 'shear_chain_params.dart' show kDevFingerprintSha;

/// Dev book. Compile-time pin. No dart-define.
const String kBookMagic = 'shear-dev';

/// Node spawn env for the dev book. Release closureSpawnEnv is unchanged.
/// P2P and stratum ports stay unset. The node then uses :30303 and :1111,
/// overridable with SHEAR_P2P_PORT and SHEAR_STRATUM, the same flags as v12.
Map<String, String> devNodeEnv({required String dataDir, String rpcToken = ''}) {
  final row = kChainParams[kBookMagic]!;
  return <String, String>{
    'SHEAR_NETWORK': kBookMagic,
    'SHEAR_DATA': dataDir,
    'SHEAR_RPC_BIND': '127.0.0.1',
    'SHEAR_RPC_PORT': '${row.rpcPort}',
    'SHEAR_P2P_BIND': '127.0.0.1',
    'SHEAR_STRATUM_BIND': '127.0.0.1',
    'SHEAR_P2P_IPC': '127.0.0.1:${row.ipcPort}',
    'SHEAR_SEEDS': '',
    'SHEAR_RPC_TOKEN': rpcToken,
  };
}
