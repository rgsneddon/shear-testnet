/// Network JSON bounds. A body past the cap, or nesting past the cap, is not decoded.
const kJsonMaxDepth = 32;
const kHttpBodyMax = 16 * 1024 * 1024;

bool jsonNestingOk(String text, {int max = kJsonMaxDepth}) {
  if (text.length > kHttpBodyMax) return false;
  var depth = 0;
  var inStr = false;
  var esc = false;
  for (final c in text.codeUnits) {
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c == 0x5c) {
        esc = true;
        continue;
      }
      if (c == 0x22) inStr = false;
      continue;
    }
    if (c == 0x22) {
      inStr = true;
      continue;
    }
    if (c == 0x7b || c == 0x5b) {
      depth += 1;
      if (depth > max) return false;
    } else if (c == 0x7d || c == 0x5d) {
      if (depth == 0) return false;
      depth -= 1;
    }
  }
  return true;
}
