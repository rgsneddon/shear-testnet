import 'dart:typed_data';

import 'package:image/image.dart' as img;
import 'package:qr/qr.dart';
import 'package:zxing2/qrcode.dart';

import 'shear_identity.dart';

/// Continuum receive QR encodes she1. Flow scan fills the send To field.
String encodeReceiveQr(String she1) => she1.trim();

String? parseReceiveQr(String raw) {
  var s = raw.trim();
  if (s.startsWith('shear:')) s = s.substring(6).trim();
  if (s.startsWith('shear1:')) s = s.substring(7).trim();
  if (isPaymentFingerprint(s)) return null;
  if (isUnpayableSsa1(s)) return null;
  if (isFullPaymentCode(s) || isPayableDest(s) || isShearAddress(s)) return s;
  return null;
}

/// Failed parse leaves [currentTo] alone.
String applyReceiveQrTo(String currentTo, String raw) {
  final got = parseReceiveQr(raw);
  if (got == null) return currentTo;
  return got;
}

String? receiveQrFailCopy(String raw) {
  if (parseReceiveQr(raw) != null) return null;
  var s = raw.trim();
  if (s.startsWith('shear:')) s = s.substring(6).trim();
  if (isUnpayableSsa1(s)) return kErrShortSsa1;
  if (isPaymentFingerprint(s)) return 'Not a payable Shear receive code (fingerprint only)';
  return 'Not a Shear receive QR.';
}

/// PNG of a receive QR. Windows Scan QR decodes this via [decodeReceiveQrImage]
/// (no mobile_scanner on Windows).
Uint8List encodeReceiveQrPng(String payload, {int module = 4}) {
  final data = payload.trim();
  final qr = QrCode.fromData(data: data, errorCorrectLevel: QrErrorCorrectLevel.M);
  final modules = QrImage(qr);
  final n = modules.moduleCount;
  final quiet = 4;
  final side = (n + quiet * 2) * module;
  final image = img.Image(width: side, height: side);
  img.fill(image, color: img.ColorRgb8(255, 255, 255));
  final black = img.ColorRgb8(0, 0, 0);
  for (var y = 0; y < n; y++) {
    for (var x = 0; x < n; x++) {
      if (!modules.isDark(y, x)) continue;
      final x0 = (x + quiet) * module;
      final y0 = (y + quiet) * module;
      img.fillRect(
        image,
        x1: x0,
        y1: y0,
        x2: x0 + module - 1,
        y2: y0 + module - 1,
        color: black,
      );
    }
  }
  return Uint8List.fromList(img.encodePng(image));
}

/// Decode a camera photo / picked PNG/JPEG of a Continuum receive QR.
/// This is the Windows/Linux path — mobile_scanner has no Windows plugin.
String? decodeReceiveQrImage(Uint8List bytes) {
  if (bytes.isEmpty) return null;
  try {
    final decoded = img.decodeImage(bytes);
    if (decoded == null || decoded.width < 8 || decoded.height < 8) return null;
    final argb = Int32List(decoded.width * decoded.height);
    var i = 0;
    for (final p in decoded) {
      argb[i++] = (p.a.toInt() << 24) | (p.r.toInt() << 16) | (p.g.toInt() << 8) | p.b.toInt();
    }
    final source = RGBLuminanceSource(decoded.width, decoded.height, argb);
    final reader = QRCodeReader();
    // A PNG the wallet made, or a crisp screenshot of one, is a pure symbol:
    // read its module grid directly. zxing's finder-pattern detector picks
    // the wrong finder centres on some pixel-perfect symbols (the data region
    // holds 1:1:3:1:1 runs with the same module estimate as the real
    // finders), so for some identities the detector path throws
    // NotFoundException (receive_qr_roundtrip_test.dart). The pure read has
    // no detector, so it reads every symbol the wallet encodes.
    final pure = DecodeHints()..put(DecodeHintType.pureBarcode);
    try {
      return parseReceiveQr(reader.decode(BinaryBitmap(HybridBinarizer(source)), hints: pure).text);
    } catch (_) {
      // Not a pure symbol (a photo, a padded screenshot): the detector path.
    }
    final hard = DecodeHints()..put(DecodeHintType.tryHarder);
    for (final bitmap in [
      BinaryBitmap(HybridBinarizer(source)),
      BinaryBitmap(GlobalHistogramBinarizer(source)),
    ]) {
      try {
        return parseReceiveQr(reader.decode(bitmap, hints: hard).text);
      } catch (_) {
        // the next binarizer
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}
