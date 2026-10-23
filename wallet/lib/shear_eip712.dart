import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:pointycastle/export.dart';

import 'shear_chain_params.dart';

const kEip712ChainId = 2701;
const kEip712Name = 'ShearPool';
const kEip712Version = '1';

Uint8List keccak256(Uint8List data) => KeccakDigest(256).process(data);

Uint8List _u8(List<int> b) => Uint8List.fromList(b);

Uint8List _encodeUint(int n) {
  final out = Uint8List(32);
  var x = n;
  for (var i = 31; i >= 0; i--) {
    out[i] = x & 0xff;
    x = x >> 8;
  }
  return out;
}

Uint8List _hashString(String s) => keccak256(_u8(utf8.encode(s)));

Uint8List _leftPad32(Uint8List src) {
  final out = Uint8List(32);
  final n = src.length > 32 ? 32 : src.length;
  out.setRange(32 - n, 32, src.sublist(src.length - n));
  return out;
}

/// Same domain the pool verifies. The book magic is the domain chain id.
/// The numeric evmChainId is not this field: two books can share it.
Uint8List poolWithdrawDigest({
  required String login,
  required String dest,
  required int nanos,
  required String magic,
  int height = 0,
  int nonce = 0,
  int deadline = 0,
}) {
  final row = kChainParams[magic];
  if (row == null) {
    throw StateError('unknown_magic');
  }
  // Touch the row so a book without a chain id cannot sign. The digest
  // binds the magic itself. The shared 2701 id does not separate the books.
  if (row.evmChainId <= 0) {
    throw StateError('unknown_magic');
  }
  final domainType = _hashString(
    'EIP712Domain(string name,string version,string chainId,address verifyingContract)',
  );
  final domainSep = keccak256(Uint8List.fromList([
    ...domainType,
    ..._hashString(kEip712Name),
    ..._hashString(kEip712Version),
    ..._hashString(magic),
    ..._leftPad32(Uint8List(20)),
  ]));
  final msgType = _hashString(
    'PoolWithdraw(string minerShe1,string payoutSsa1,uint256 nanos,uint256 height,uint256 nonce,uint256 deadline)',
  );
  final n = nanos < 0 ? 0 : nanos;
  final structHash = keccak256(Uint8List.fromList([
    ...msgType,
    ..._hashString(login),
    ..._hashString(dest),
    ..._encodeUint(n),
    ..._encodeUint(height < 0 ? 0 : height),
    ..._encodeUint(nonce < 0 ? 0 : nonce),
    ..._encodeUint(deadline < 0 ? 0 : deadline),
  ]));
  return keccak256(Uint8List.fromList([0x19, 0x01, ...domainSep, ...structHash]));
}

Uint8List evmPrivFromSeed(Uint8List seed) {
  return Uint8List.fromList(sha256.convert(utf8.encode('shear-evm-secp-v1') + seed).bytes);
}

String _hex(Uint8List b) => b.map((e) => e.toRadixString(16).padLeft(2, '0')).join();

Uint8List hexToBytes(String hex) {
  final h = hex.startsWith('0x') ? hex.substring(2) : hex;
  final out = Uint8List(h.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(h.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

Uint8List _hexBytes(String hex) => hexToBytes(hex);

ECPrivateKey _privKey(Uint8List priv) {
  final curve = ECCurve_secp256k1();
  var d = BigInt.parse(_hex(priv), radix: 16) % curve.n!;
  if (d == BigInt.zero) d = BigInt.one;
  return ECPrivateKey(d, curve);
}

Uint8List _pad32(BigInt x) {
  final hex = x.toRadixString(16).padLeft(64, '0');
  return _hexBytes(hex);
}

/// 33-byte compressed pub || 64-byte compact || 1-byte v(27/28).
String signPoolWithdraw({
  required Uint8List seed,
  required String login,
  required String dest,
  required int nanos,
  required String magic,
}) {
  final digest = poolWithdrawDigest(login: login, dest: dest, nanos: nanos, magic: magic);
  final privRaw = evmPrivFromSeed(seed);
  final key = _privKey(privRaw);
  final pub = key.parameters!.G * key.d;
  final pubBytes = pub!.getEncoded(true);
  final signer = ECDSASigner(null, HMac(SHA256Digest(), 64));
  signer.init(true, PrivateKeyParameter<ECPrivateKey>(key));
  final ecsig = signer.generateSignature(digest) as ECSignature;
  final compact = Uint8List.fromList([..._pad32(ecsig.r!), ..._pad32(ecsig.s!)]);
  final recBit = _recoveryBit(digest, compact, pubBytes);
  return _hex(Uint8List.fromList([...pubBytes, ...compact, 27 + recBit]));
}

int _recoveryBit(Uint8List digest, Uint8List compact, Uint8List wantPub) {
  for (var rec = 0; rec < 2; rec++) {
    // v is stored for Ethereum wallets; verify uses pub+compact, not recovery.
    if (wantPub.length == 33) return rec;
  }
  return 0;
}

bool verifyPoolWithdrawSig({
  required String login,
  required String dest,
  required int nanos,
  required String sig,
  required String magic,
}) {
  final raw = sig.trim();
  final hex = raw.startsWith('0x') ? raw.substring(2) : raw;
  if (!RegExp(r'^[0-9a-fA-F]{196}$').hasMatch(hex)) return false;
  final buf = _hexBytes(hex);
  if (buf.length != 98) return false;
  final pubBytes = buf.sublist(0, 33);
  final r = BigInt.parse(_hex(buf.sublist(33, 65)), radix: 16);
  final s = BigInt.parse(_hex(buf.sublist(65, 97)), radix: 16);
  final v = buf[97];
  if (v != 27 && v != 28) return false;
  try {
    final digest = poolWithdrawDigest(login: login, dest: dest, nanos: nanos, magic: magic);
    final curve = ECCurve_secp256k1();
    final point = curve.curve.decodePoint(pubBytes);
    if (point == null) return false;
    final pub = ECPublicKey(point, curve);
    final verifier = ECDSASigner(null, HMac(SHA256Digest(), 64));
    verifier.init(false, PublicKeyParameter<ECPublicKey>(pub));
    return verifier.verifySignature(digest, ECSignature(r, s));
  } catch (_) {
    return false;
  }
}
