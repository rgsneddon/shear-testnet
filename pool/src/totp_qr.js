/**
 * Byte-mode QR (versions 1–10, ECC-M). Enough for otpauth TOTP URIs.
 * Generated locally so the TOTP secret never hits a third-party image host.
 */
const TOTAL_CW = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const EC_PER_BLOCK = [0, 10, 16, 26, 36, 24, 16, 18, 22, 22, 26];
const N_BLOCKS = [0, 1, 1, 1, 1, 2, 4, 4, 4, 5, 5];
const ALIGN = [
  [], [], [18], [22], [26], [30], [34], [22, 38], [24, 42], [26, 46], [28, 50],
];
const VERSION_BITS = {
  7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3,
};

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  if (!a || !b) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(ec) {
  let poly = [1];
  for (let i = 0; i < ec; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= gfMul(poly[j], GF_EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ec) {
  const gen = rsGenerator(ec);
  const out = data.concat(new Array(ec).fill(0));
  for (let i = 0; i < data.length; i += 1) {
    const coef = out[i];
    if (!coef) continue;
    for (let j = 0; j < gen.length; j += 1) out[i + j] ^= gfMul(gen[j], coef);
  }
  return out.slice(data.length);
}

function bitBuf() {
  const bits = [];
  return {
    push(val, n) {
      for (let i = n - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1);
    },
    bytes() {
      const out = [];
      for (let i = 0; i < bits.length; i += 8) {
        let v = 0;
        for (let j = 0; j < 8; j += 1) v = (v << 1) | (bits[i + j] || 0);
        out.push(v);
      }
      return out;
    },
    get length() { return bits.length; },
  };
}

function dataCodewords(text, ver) {
  const dataCw = TOTAL_CW[ver] - N_BLOCKS[ver] * EC_PER_BLOCK[ver];
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const lenBits = ver <= 9 ? 8 : 16;
  const buf = bitBuf();
  buf.push(0b0100, 4);
  buf.push(bytes.length, lenBits);
  for (const b of bytes) buf.push(b, 8);
  const capBits = dataCw * 8;
  const term = Math.min(4, capBits - buf.length);
  if (term > 0) buf.push(0, term);
  while (buf.length % 8) buf.push(0, 1);
  const out = buf.bytes();
  const pads = [0xec, 0x11];
  let p = 0;
  while (out.length < dataCw) {
    out.push(pads[p % 2]);
    p += 1;
  }
  return out.slice(0, dataCw);
}

function interleave(data, ver) {
  const nBlocks = N_BLOCKS[ver];
  const ec = EC_PER_BLOCK[ver];
  const total = TOTAL_CW[ver];
  const shortBlocks = nBlocks - (total % nBlocks);
  const shortLen = Math.floor(total / nBlocks);
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < nBlocks; i += 1) {
    const blockTotal = shortLen + (i >= shortBlocks ? 1 : 0);
    const dataLen = blockTotal - ec;
    const d = data.slice(offset, offset + dataLen);
    offset += dataLen;
    blocks.push({ data: d, ec: rsEncode(d, ec) });
  }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxD; i += 1) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ec; i += 1) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

function sizeOf(ver) {
  return 21 + 4 * (ver - 1);
}

function isFunction(fn, x, y, ver) {
  const n = fn.length;
  if (x < 9 && y < 9) return true;
  if (x >= n - 8 && y < 9) return true;
  if (x < 9 && y >= n - 8) return true;
  if (y === 6 || x === 6) return true;
  if (ver >= 7) {
    if (x < 6 && y >= n - 11 && y < n - 8) return true;
    if (y < 6 && x >= n - 11 && x < n - 8) return true;
  }
  const pos = ALIGN[ver] || [];
  for (const ay of pos) {
    for (const ax of pos) {
      if ((ax === 6 && ay === 6)
        || (ax === 6 && ay === n - 7)
        || (ax === n - 7 && ay === 6)) continue;
      if (Math.abs(x - ax) <= 2 && Math.abs(y - ay) <= 2) return true;
    }
  }
  return false;
}

function placeFinder(grid, x, y) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const xx = x + dx;
      const yy = y + dy;
      if (yy < 0 || xx < 0 || yy >= grid.length || xx >= grid.length) continue;
      const on = dx === -1 || dx === 7 || dy === -1 || dy === 7
        ? false
        : (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      grid[yy][xx] = on ? 1 : 0;
    }
  }
}

function placeAlignment(grid, cx, cy) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const on = dx === -2 || dx === 2 || dy === -2 || dy === 2 || (dx === 0 && dy === 0);
      grid[cy + dy][cx + dx] = on ? 1 : 0;
    }
  }
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return ((x + y) & 1) === 0;
    case 1: return (y & 1) === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (((y >> 1) + Math.floor(x / 3)) & 1) === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return ((((x * y) % 2) + ((x * y) % 3)) & 1) === 0;
    case 7: return ((((x + y) % 2) + ((x * y) % 3)) & 1) === 0;
    default: return false;
  }
}

function formatBits(mask) {
  const data = mask & 7;
  let d = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((d >>> (i + 10)) & 1) d ^= 0x537 << i;
  }
  return (data << 10 | (d & 0x3ff)) ^ 0x5412;
}

function placeFormat(grid, mask) {
  const bits = formatBits(mask);
  const n = grid.length;
  for (let i = 0; i < 15; i += 1) {
    const bit = (bits >> (14 - i)) & 1;
    if (i < 6) grid[i][8] = bit;
    else if (i === 6) grid[7][8] = bit;
    else if (i === 7) grid[8][8] = bit;
    else grid[n - 15 + i][8] = bit;
    if (i < 8) grid[8][n - 1 - i] = bit;
    else if (i === 8) grid[8][7] = bit;
    else grid[8][14 - i] = bit;
  }
  grid[n - 8][8] = 1;
}

function placeVersion(grid, ver) {
  if (ver < 7) return;
  const bits = VERSION_BITS[ver];
  const n = grid.length;
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >> i) & 1;
    const a = i % 3;
    const b = Math.floor(i / 3);
    grid[n - 11 + a][b] = bit;
    grid[b][n - 11 + a] = bit;
  }
}

function penalty(grid) {
  const n = grid.length;
  let score = 0;
  for (let y = 0; y < n; y += 1) {
    let run = 1;
    for (let x = 1; x < n; x += 1) {
      if (grid[y][x] === grid[y][x - 1]) run += 1;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }
  for (let x = 0; x < n; x += 1) {
    let run = 1;
    for (let y = 1; y < n; y += 1) {
      if (grid[y][x] === grid[y - 1][x]) run += 1;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }
  for (let y = 0; y < n - 1; y += 1) {
    for (let x = 0; x < n - 1; x += 1) {
      const v = grid[y][x];
      if (v === grid[y][x + 1] && v === grid[y + 1][x] && v === grid[y + 1][x + 1]) score += 3;
    }
  }
  const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (row, start, p) => {
    for (let i = 0; i < p.length; i += 1) if (row[start + i] !== p[i]) return false;
    return true;
  };
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x <= n - 11; x += 1) {
      if (match(grid[y], x, pat) || match(grid[y], x, pat2)) score += 40;
    }
  }
  for (let x = 0; x < n; x += 1) {
    const col = grid.map((row) => row[x]);
    for (let y = 0; y <= n - 11; y += 1) {
      if (match(col, y, pat) || match(col, y, pat2)) score += 40;
    }
  }
  let dark = 0;
  for (const row of grid) for (const v of row) dark += v;
  const k = Math.abs(Math.floor((dark * 100) / (n * n) / 5) - 10);
  score += k * 10;
  return score;
}

function buildGrid(text, ver, mask) {
  const n = sizeOf(ver);
  const grid = Array.from({ length: n }, () => new Array(n).fill(0));
  const fn = Array.from({ length: n }, () => new Array(n).fill(false));
  placeFinder(grid, 0, 0);
  placeFinder(grid, n - 7, 0);
  placeFinder(grid, 0, n - 7);
  for (let i = 0; i < 8; i += 1) {
    for (let j = 0; j < 8; j += 1) {
      fn[j][i] = true;
      fn[j][n - 8 + i] = true;
      fn[n - 8 + j][i] = true;
    }
  }
  for (let i = 0; i < n; i += 1) {
    grid[6][i] = i % 2 === 0 ? 1 : 0;
    grid[i][6] = i % 2 === 0 ? 1 : 0;
    fn[6][i] = true;
    fn[i][6] = true;
  }
  const pos = ALIGN[ver] || [];
  for (const ay of [6, ...pos]) {
    for (const ax of [6, ...pos]) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === n - 7) || (ax === n - 7 && ay === 6)) continue;
      if (ax < 2 || ay < 2) continue;
      placeAlignment(grid, ax, ay);
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) fn[ay + dy][ax + dx] = true;
      }
    }
  }
  if (ver >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        fn[n - 11 + j][i] = true;
        fn[i][n - 11 + j] = true;
      }
    }
  }
  for (let i = 0; i < 9; i += 1) {
    fn[8][i] = true;
    fn[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    fn[8][n - 1 - i] = true;
    fn[n - 1 - i][8] = true;
  }
  fn[n - 8][8] = true;
  placeVersion(grid, ver);
  const data = interleave(dataCodewords(text, ver), ver);
  const bits = [];
  for (const b of data) {
    for (let i = 7; i >= 0; i -= 1) bits.push((b >> i) & 1);
  }
  let bi = 0;
  let up = true;
  for (let x = n - 1; x > 0; x -= 2) {
    if (x === 6) x -= 1;
    for (let i = 0; i < n; i += 1) {
      const y = up ? n - 1 - i : i;
      for (const dx of [0, -1]) {
        const xx = x + dx;
        if (fn[y][xx]) continue;
        const bit = bits[bi] || 0;
        bi += 1;
        grid[y][xx] = bit ^ (maskBit(mask, xx, y) ? 1 : 0);
      }
    }
    up = !up;
  }
  placeFormat(grid, mask);
  return grid;
}

function pickVersion(text) {
  const n = Buffer.byteLength(String(text), 'utf8');
  for (let v = 1; v <= 10; v += 1) {
    const dataCw = TOTAL_CW[v] - N_BLOCKS[v] * EC_PER_BLOCK[v];
    const lenBits = v <= 9 ? 8 : 16;
    const need = Math.ceil((4 + lenBits + n * 8 + 4) / 8);
    if (need <= dataCw) return v;
  }
  throw new Error('qr_too_long');
}

export function qrModules(text) {
  const ver = pickVersion(text);
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const grid = buildGrid(text, ver, mask);
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = grid;
    }
  }
  return best;
}

export function qrSvg(text, { moduleSize = 4, margin = 4 } = {}) {
  const m = qrModules(text);
  const n = m.length;
  const dim = (n + margin * 2) * moduleSize;
  let rects = '';
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (m[y][x]) {
        rects += `<rect x="${(x + margin) * moduleSize}" y="${(y + margin) * moduleSize}" width="${moduleSize}" height="${moduleSize}"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/>${rects}</svg>`;
}

void isFunction;
