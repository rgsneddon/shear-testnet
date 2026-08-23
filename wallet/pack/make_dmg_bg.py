#!/usr/bin/env python3
"""Exact-size DMG background. Finder does not scale; oversized PNGs overflow."""
import struct
import zlib
from pathlib import Path

W, H = 540, 360
BG = (0xEE, 0xF3, 0xF8)
INK = (0x0D, 0x21, 0x37)
CYAN = (0x00, 0x88, 0xA8)


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(
        ">I", zlib.crc32(tag + data) & 0xFFFFFFFF
    )


def write_png(path: Path, pixels: list[list[tuple[int, int, int]]]) -> None:
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for r, g, b in row:
            raw.extend((r, g, b))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def in_chevron(x: int, y: int, left: int, top: int, wide: int, tall: int) -> bool:
    # Right-pointing chevron: two bars, fully inside [left, left+wide] x [top, top+tall].
    cx = left + wide * 0.35
    cy = top + tall / 2
    relx = x - cx
    rely = abs(y - cy)
    if relx < 0 or relx > wide * 0.55:
        return False
    # thickness ~ tall/5, opening toward the right
    return rely < (tall / 2) - relx * (tall / 2) / (wide * 0.7) and rely > (
        tall / 2 - 10
    ) - relx * (tall / 2) / (wide * 0.7)


def main() -> None:
    pix = [[BG for _ in range(W)] for _ in range(H)]
    # Small double chevron in the gap between the two 112px icons (centers 130 and 410).
    for y in range(150, 230):
        for x in range(230, 310):
            if in_chevron(x, y, 230, 150, 44, 80) or in_chevron(x, y, 262, 150, 44, 80):
                pix[y][x] = CYAN
    out = Path(__file__).with_name("dmg-bg.png")
    write_png(out, pix)
    print(f"wrote {out} {W}x{H}")


if __name__ == "__main__":
    main()
