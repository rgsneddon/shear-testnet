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
  if (isFullPaymentCode(s) || isDestAddress(s)) return s;
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
    final bitmap = BinaryBitmap(HybridBinarizer(source));
    final result = QRCodeReader().decode(bitmap);
    return parseReceiveQr(result.text);
  } catch (_) {
    return null;
  }
}
