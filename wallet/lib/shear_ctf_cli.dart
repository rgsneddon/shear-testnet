import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'shear_ctf.dart';
import 'shear_identity.dart';
import 'shear_ledger.dart';

/// Resistance CLI palettes: mainframe green-on-black / dark-blue-on-grey.
const kCliDarkBg = Color(0xFF000000);
const kCliDarkFg = Color(0xFF00FF41);
const kCliLightBg = Color(0xFFD6D6D6);
const kCliLightFg = Color(0xFF003399);

String _hex(Uint8List b) =>
    b.map((e) => e.toRadixString(16).padLeft(2, '0')).join();

/// CTF conclusion + receive-path for one ledger tx. Uses [destForLogin] /
/// [closureCommit] / spendable credit — not a second story.
String ctfTranscript({
  required ShearIdentity identity,
  required ShearTx tx,
  required double spendableAfter,
  Uint8List? continuityRoot,
}) {
  final view = identity.viewKey;
  final height = tx.height ?? 1;
  final root = continuityRoot ?? ctfEmptyRoot();
  final G = closureCommit(view);
  final destAtHeight = destForLogin(
    identity.address,
    continuityRoot: root,
    height: height,
    viewKey: view,
  );
  final destAtOne = destForLogin(
    identity.address,
    continuityRoot: root,
    height: 1,
    viewKey: view,
  );
  final chainDest = isDestAddress(tx.to) ? tx.to : destAtHeight;
  final matched = chainDest != null &&
      (chainDest == destAtHeight || chainDest == destAtOne || chainDest == tx.to);
  final receive = tx.kind != 'send' || isDestAddress(tx.to);
  final buf = StringBuffer();
  buf.writeln('======== SHEAR CTF  tx=${tx.id}  ========');
  buf.writeln('kind        ${tx.kind}');
  buf.writeln('amount      ${formatShe(tx.amount)} SHE');
  buf.writeln('height      $height');
  buf.writeln('from        ${tx.from}');
  buf.writeln('to          ${tx.to}');
  buf.writeln('-- identity --');
  buf.writeln('shear1      ${identity.address}');
  buf.writeln('            rest-frame; never a dest; never share; never on chain');
  buf.writeln('she1        ${identity.paymentCode}');
  buf.writeln('            public receive ID (mining / exchanges / alice2bob)');
  buf.writeln('-- closure G_{μν} --');
  buf.writeln('personal    $ctfClosurePersonal');
  buf.writeln('G           ${_hex(G)}');
  buf.writeln('-- flow J^μ receive-path --');
  buf.writeln('personal    $ctfFlowPersonal');
  buf.writeln('continuity  ${_hex(root)}');
  buf.writeln('destForLogin(h=$height)  ${destAtHeight ?? '(none)'}');
  if (destAtOne != null && destAtOne != destAtHeight) {
    buf.writeln('destForLogin(h=1)       $destAtOne');
  }
  buf.writeln('shp1 dest   ${chainDest ?? tx.to}');
  buf.writeln('match       ${matched ? 'YES' : 'NO'}  destForLogin opens tx.to');
  buf.writeln('-- spendable credit --');
  if (receive && tx.kind != 'send') {
    buf.writeln('credited    ${formatShe(tx.amount)} SHE onto shp1 dest');
  } else {
    buf.writeln('debited     ${formatShe(tx.amount)} SHE from shp1 ${tx.from}');
  }
  buf.writeln('spendable   ${formatShe(spendableAfter)} SHE  (Continuum)');
  buf.writeln(
    'conclusion  CTF opened shp1 with view-key closure C; '
    'coins land spendable after confirm. shear1 stays off-chain.',
  );
  buf.writeln('========');
  return buf.toString();
}
