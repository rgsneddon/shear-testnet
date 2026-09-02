import 'shear_identity.dart';

/// Continuum receive QR encodes she1. Flow scan fills the send To field.
String encodeReceiveQr(String she1) => she1.trim();

String? parseReceiveQr(String raw) {
  var s = raw.trim();
  if (s.startsWith('shear:')) s = s.substring(6).trim();
  if (s.startsWith('shear1:')) s = s.substring(7).trim();
  if (isPaymentCode(s) || isDestAddress(s)) return s;
  return null;
}
