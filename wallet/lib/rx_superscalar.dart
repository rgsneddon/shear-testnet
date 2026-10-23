part of 'shear_hash_v3.dart';

// Superscalar program generator and light-dataset item. Ports
// crypto/randomx/src/superscalar.cpp and dataset.cpp.

const int _ssIsub = 0;
const int _ssIxor = 1;
const int _ssIaddRs = 2;
const int _ssImul = 3;
const int _ssIror = 4;
const int _ssIaddC7 = 5;
const int _ssIxorC7 = 6;
const int _ssIaddC8 = 7;
const int _ssIxorC8 = 8;
const int _ssIaddC9 = 9;
const int _ssIxorC9 = 10;
const int _ssImulh = 11;
const int _ssIsmulh = 12;
const int _ssImulRcp = 13;
const int _ssInvalid = -1;

const int _p0 = 1;
const int _p1 = 2;
const int _p5 = 4;
const int _p01 = _p0 | _p1;
const int _p05 = _p0 | _p5;
const int _p015 = _p0 | _p1 | _p5;

const int _ssLatency = 170;
const int _cycleMap = _ssLatency + 4;
const int _lookForward = 4;
const int _maxThrow = 256;
const int _ssMaxSize = 3 * _ssLatency + 2;

const int _mul0 = 0x5851f42d4c957f2d;
const int _add1 = 0x810a978a59f5a1fc;
const int _add2 = 0xa77099df38c2d846;
const int _add3 = 0x8126b91cbf22495c;
const int _add4 = 0x494d2597179f8a62;
const int _add5 = 0x9237efb9ceaaec0c;
const int _add6 = 0x2f2a56746ce62d78;
const int _add7 = 0x84853bf7b62ce54e;

const int _cacheLineMask = (kRxCacheBytes ~/ 64) - 1;

class _Mop {
  final int size;
  final int latency;
  final int uop1;
  final int uop2;
  final bool dependent;
  const _Mop(this.size, this.latency, this.uop1, this.uop2, {this.dependent = false});
  bool get simple => uop2 == 0;
  bool get eliminated => uop1 == 0;
}

const _mopSub = _Mop(3, 1, _p015, 0);
const _mopXor = _Mop(3, 1, _p015, 0);
const _mopImulR = _Mop(3, 4, _p1, _p5);
const _mopMulR = _Mop(3, 4, _p1, _p5);
const _mopMov = _Mop(3, 0, 0, 0);
const _mopLea = _Mop(4, 1, _p01, 0);
const _mopImulRr = _Mop(4, 3, _p1, 0);
const _mopImulRrDep = _Mop(4, 3, _p1, 0, dependent: true);
const _mopRor = _Mop(4, 1, _p05, 0);
const _mopAddI = _Mop(7, 1, _p015, 0);
const _mopXorI = _Mop(7, 1, _p015, 0);
const _mopMovI = _Mop(10, 1, _p015, 0);

class _Info {
  final int type;
  final List<_Mop> ops;
  final int resultOp;
  final int dstOp;
  final int srcOp;
  const _Info(this.type, this.ops, this.srcOp, {this.resultOp = 0, this.dstOp = 0});
  int get size => ops.length;
}

const _infoIsub = _Info(_ssIsub, [_mopSub], 0);
const _infoIxor = _Info(_ssIxor, [_mopXor], 0);
const _infoIaddRs = _Info(_ssIaddRs, [_mopLea], 0);
const _infoImul = _Info(_ssImul, [_mopImulRr], 0);
const _infoIror = _Info(_ssIror, [_mopRor], -1);
const _infoIaddC7 = _Info(_ssIaddC7, [_mopAddI], -1);
const _infoIxorC7 = _Info(_ssIxorC7, [_mopXorI], -1);
const _infoIaddC8 = _Info(_ssIaddC8, [_mopAddI], -1);
const _infoIxorC8 = _Info(_ssIxorC8, [_mopXorI], -1);
const _infoIaddC9 = _Info(_ssIaddC9, [_mopAddI], -1);
const _infoIxorC9 = _Info(_ssIxorC9, [_mopXorI], -1);
const _infoImulh = _Info(_ssImulh, [_mopMov, _mopMulR, _mopMov], 1, resultOp: 1, dstOp: 0);
const _infoIsmulh = _Info(_ssIsmulh, [_mopMov, _mopImulR, _mopMov], 1, resultOp: 1, dstOp: 0);
const _infoImulRcp = _Info(_ssImulRcp, [_mopMovI, _mopImulRrDep], -1, resultOp: 1, dstOp: 1);
const _infoNop = _Info(_ssInvalid, [], -1);

const List<_Info> _slot3 = [_infoIsub, _infoIxor];
const List<_Info> _slot3L = [_infoIsub, _infoIxor, _infoImulh, _infoIsmulh];
const List<_Info> _slot4 = [_infoIror, _infoIaddRs];
const List<_Info> _slot7 = [_infoIxorC7, _infoIaddC7];
const List<_Info> _slot8 = [_infoIxorC8, _infoIaddC8];
const List<_Info> _slot9 = [_infoIxorC9, _infoIaddC9];

const List<List<int>> _decodeBufs = [
  [4, 8, 4],
  [7, 3, 3, 3],
  [3, 7, 3, 3],
  [4, 9, 3],
  [4, 4, 4, 4],
  [3, 3, 10],
];

class _SsOp {
  int opcode = 0;
  int dst = 0;
  int src = 0;
  int mod = 0;
  int imm = 0;
}

class _SsProg {
  final List<_SsOp> ops = List.generate(_ssMaxSize, (_) => _SsOp());
  int size = 0;
  int addr = 0;
}

class _Gen {
  final Uint8List data = Uint8List(64);
  int index = 64;
  _Gen(Uint8List seed) {
    final n = seed.length > 60 ? 60 : seed.length;
    data.setRange(0, n, seed);
  }
  void _need(int n) {
    if (index + n > 64) {
      data.setRange(0, 64, blake2bBytes(Uint8List.fromList(data), 64));
      index = 0;
    }
  }
  int byte() {
    _need(1);
    return data[index++];
  }
  int u32() {
    _need(4);
    final v = data[index] |
        (data[index + 1] << 8) |
        (data[index + 2] << 16) |
        (data[index + 3] << 24);
    index += 4;
    return v;
  }
}

class _RegInfo {
  int latency = 0;
  int lastOp = _ssInvalid;
  int lastPar = -1;
}

class _Cur {
  _Info info = _infoNop;
  int src = -1;
  int dst = -1;
  int mod = 0;
  int imm = 0;
  int opGroup = _ssInvalid;
  int opGroupPar = -1;
  bool canReuse = false;
  bool groupParIsSource = false;

  void create(_Info next, _Gen gen) {
    info = next;
    src = dst = -1;
    canReuse = false;
    groupParIsSource = false;
    switch (next.type) {
      case _ssIsub:
        mod = 0;
        imm = 0;
        opGroup = _ssIaddRs;
        groupParIsSource = true;
      case _ssIxor:
        mod = 0;
        imm = 0;
        opGroup = _ssIxor;
        groupParIsSource = true;
      case _ssIaddRs:
        mod = gen.byte();
        imm = 0;
        opGroup = _ssIaddRs;
        groupParIsSource = true;
      case _ssImul:
        mod = 0;
        imm = 0;
        opGroup = _ssImul;
        groupParIsSource = true;
      case _ssIror:
        mod = 0;
        do {
          imm = gen.byte() & 63;
        } while (imm == 0);
        opGroup = _ssIror;
        opGroupPar = -1;
      case _ssIaddC7:
      case _ssIaddC8:
      case _ssIaddC9:
        mod = 0;
        imm = gen.u32();
        opGroup = _ssIaddC7;
        opGroupPar = -1;
      case _ssIxorC7:
      case _ssIxorC8:
      case _ssIxorC9:
        mod = 0;
        imm = gen.u32();
        opGroup = _ssIxorC7;
        opGroupPar = -1;
      case _ssImulh:
        canReuse = true;
        mod = 0;
        imm = 0;
        opGroup = _ssImulh;
        opGroupPar = gen.u32();
      case _ssIsmulh:
        canReuse = true;
        mod = 0;
        imm = 0;
        opGroup = _ssIsmulh;
        opGroupPar = gen.u32();
      case _ssImulRcp:
        mod = 0;
        do {
          imm = gen.u32();
        } while (_pow2(imm));
        opGroup = _ssImulRcp;
        opGroupPar = -1;
      default:
        break;
    }
  }

  void forSlot(_Gen gen, int slot, int fetchType, bool isLast) {
    switch (slot) {
      case 3:
        create(isLast ? _slot3L[gen.byte() & 3] : _slot3[gen.byte() & 1], gen);
      case 4:
        if (fetchType == 4 && !isLast) {
          create(_infoImul, gen);
        } else {
          create(_slot4[gen.byte() & 1], gen);
        }
      case 7:
        create(_slot7[gen.byte() & 1], gen);
      case 8:
        create(_slot8[gen.byte() & 1], gen);
      case 9:
        create(_slot9[gen.byte() & 1], gen);
      case 10:
        create(_infoImulRcp, gen);
      default:
        break;
    }
  }

  bool selectDest(int cycle, bool allowChain, List<_RegInfo> regs, _Gen gen) {
    final avail = <int>[];
    for (var i = 0; i < 8; i++) {
      if (regs[i].latency <= cycle &&
          (canReuse || i != src) &&
          (allowChain || opGroup != _ssImul || regs[i].lastOp != _ssImul) &&
          (regs[i].lastOp != opGroup || regs[i].lastPar != opGroupPar) &&
          (info.type != _ssIaddRs || i != 5)) {
        avail.add(i);
      }
    }
    return _pick(avail, gen, true);
  }

  bool selectSrc(int cycle, List<_RegInfo> regs, _Gen gen) {
    final avail = <int>[];
    for (var i = 0; i < 8; i++) {
      if (regs[i].latency <= cycle) avail.add(i);
    }
    if (avail.length == 2 && info.type == _ssIaddRs) {
      if (avail[0] == 5 || avail[1] == 5) {
        opGroupPar = src = 5;
        return true;
      }
    }
    if (_pick(avail, gen, false)) {
      if (groupParIsSource) opGroupPar = src;
      return true;
    }
    return false;
  }

  bool _pick(List<int> avail, _Gen gen, bool dest) {
    if (avail.isEmpty) return false;
    final index = avail.length > 1 ? gen.u32() % avail.length : 0;
    if (dest) {
      dst = avail[index];
    } else {
      src = avail[index];
    }
    return true;
  }
}

int _schedUop(int uop, List<List<int>> busy, int cycle, bool commit) {
  for (; cycle < _cycleMap; cycle++) {
    if ((uop & _p5) != 0 && busy[cycle][2] == 0) {
      if (commit) busy[cycle][2] = uop;
      return cycle;
    }
    if ((uop & _p0) != 0 && busy[cycle][0] == 0) {
      if (commit) busy[cycle][0] = uop;
      return cycle;
    }
    if ((uop & _p1) != 0 && busy[cycle][1] == 0) {
      if (commit) busy[cycle][1] = uop;
      return cycle;
    }
  }
  return -1;
}

int _schedMop(_Mop mop, List<List<int>> busy, int cycle, int depCycle, bool commit) {
  if (mop.dependent && depCycle > cycle) cycle = depCycle;
  if (mop.eliminated) return cycle;
  if (mop.simple) return _schedUop(mop.uop1, busy, cycle, commit);
  for (; cycle < _cycleMap; cycle++) {
    final c1 = _schedUop(mop.uop1, busy, cycle, false);
    final c2 = _schedUop(mop.uop2, busy, cycle, false);
    if (c1 >= 0 && c1 == c2) {
      if (commit) {
        _schedUop(mop.uop1, busy, c1, true);
        _schedUop(mop.uop2, busy, c2, true);
      }
      return c1;
    }
  }
  return -1;
}

int _fetchNext(int curType, int decodeCycle, int mulCount, _Gen gen) {
  if (curType == _ssImulh || curType == _ssIsmulh) return 5;
  if (mulCount < decodeCycle + 1) return 4;
  if (curType == _ssImulRcp) return (gen.byte() & 1) != 0 ? 0 : 3;
  return gen.byte() & 3;
}

bool _isMul(int t) => t == _ssImul || t == _ssImulh || t == _ssIsmulh || t == _ssImulRcp;

bool _pow2(int x) {
  x &= _m32;
  return (x & (x - 1)) == 0;
}

int reciprocal32(int divisor) {
  divisor &= _m32;
  final div = BigInt.from(divisor);
  final p = BigInt.one << 63;
  final q = p ~/ div;
  final r = p % div;
  var shift = 0;
  var t = divisor;
  while (t != 0) {
    shift++;
    t >>= 1;
  }
  final result = (q << shift) + ((r << shift) ~/ div);
  return _bigI64(result);
}

int _bigI64(BigInt x) {
  final m = (BigInt.one << 64) - BigInt.one;
  final u = x & m;
  final signed = u >= (BigInt.one << 63) ? u - (BigInt.one << 64) : u;
  return signed.toInt();
}

_SsProg generateSuperscalar(_Gen gen) {
  final busy = List.generate(_cycleMap, (_) => List<int>.filled(3, 0));
  final regs = List.generate(8, (_) => _RegInfo());
  var decode = -1;
  final cur = _Cur();
  var macroOpIndex = 0;
  var codeSize = 0;
  var macroOpCount = 0;
  var cycle = 0;
  var depCycle = 0;
  var retireCycle = 0;
  var saturated = false;
  var programSize = 0;
  var mulCount = 0;
  var throwAway = 0;
  final prog = _SsProg();
  for (var decodeCycle = 0; decodeCycle < _ssLatency && !saturated && programSize < _ssMaxSize; decodeCycle++) {
    decode = _fetchNext(cur.info.type, decodeCycle, mulCount, gen);
    final counts = _decodeBufs[decode];
    var bufferIndex = 0;
    while (bufferIndex < counts.length) {
      final topCycle = cycle;
      if (macroOpIndex >= cur.info.size) {
        if (saturated || programSize >= _ssMaxSize) break;
        cur.forSlot(gen, counts[bufferIndex], decode, counts.length == bufferIndex + 1);
        macroOpIndex = 0;
      }
      final mop = cur.info.ops[macroOpIndex];
      var scheduleCycle = _schedMop(mop, busy, cycle, depCycle, false);
      if (scheduleCycle < 0) {
        saturated = true;
        break;
      }
      if (macroOpIndex == cur.info.srcOp) {
        var forward = 0;
        while (forward < _lookForward && !cur.selectSrc(scheduleCycle, regs, gen)) {
          forward++;
          scheduleCycle++;
          cycle++;
        }
        if (forward == _lookForward) {
          if (throwAway < _maxThrow) {
            throwAway++;
            macroOpIndex = cur.info.size;
            continue;
          }
          cur.info = _infoNop;
          break;
        }
      }
      if (macroOpIndex == cur.info.dstOp) {
        var forward = 0;
        while (forward < _lookForward && !cur.selectDest(scheduleCycle, throwAway > 0, regs, gen)) {
          forward++;
          scheduleCycle++;
          cycle++;
        }
        if (forward == _lookForward) {
          if (throwAway < _maxThrow) {
            throwAway++;
            macroOpIndex = cur.info.size;
            continue;
          }
          cur.info = _infoNop;
          break;
        }
      }
      throwAway = 0;
      scheduleCycle = _schedMop(mop, busy, scheduleCycle, scheduleCycle, true);
      if (scheduleCycle < 0) {
        saturated = true;
        break;
      }
      depCycle = scheduleCycle + mop.latency;
      if (macroOpIndex == cur.info.resultOp) {
        final ri = regs[cur.dst];
        retireCycle = depCycle;
        ri.latency = retireCycle;
        ri.lastOp = cur.opGroup;
        ri.lastPar = cur.opGroupPar;
      }
      codeSize += mop.size;
      bufferIndex++;
      macroOpIndex++;
      macroOpCount++;
      if (scheduleCycle >= _ssLatency) saturated = true;
      cycle = topCycle;
      if (macroOpIndex >= cur.info.size) {
        final ins = prog.ops[programSize++];
        ins.opcode = cur.info.type;
        ins.dst = cur.dst;
        ins.src = cur.src >= 0 ? cur.src : cur.dst;
        ins.mod = cur.mod;
        ins.imm = cur.imm;
        if (_isMul(cur.info.type)) mulCount++;
      }
    }
    cycle++;
  }
  final asic = List<int>.filled(8, 0);
  for (var i = 0; i < programSize; i++) {
    final ins = prog.ops[i];
    final latDst = asic[ins.dst] + 1;
    final latSrc = ins.dst != ins.src ? asic[ins.src] + 1 : 0;
    asic[ins.dst] = latDst > latSrc ? latDst : latSrc;
  }
  var asicMax = 0;
  var address = 0;
  for (var i = 0; i < 8; i++) {
    if (asic[i] > asicMax) {
      asicMax = asic[i];
      address = i;
    }
  }
  prog.size = programSize;
  prog.addr = address;
  return prog;
}

void executeSuperscalar(List<int> r, _SsProg prog, List<int> rcps) {
  for (var j = 0; j < prog.size; j++) {
    final ins = prog.ops[j];
    final d = ins.dst;
    final s = ins.src;
    switch (ins.opcode) {
      case _ssIsub:
        r[d] -= r[s];
      case _ssIxor:
        r[d] ^= r[s];
      case _ssIaddRs:
        r[d] += r[s] << ((ins.mod >> 2) & 3);
      case _ssImul:
        r[d] *= r[s];
      case _ssIror:
        r[d] = _rotr(r[d], ins.imm);
      case _ssIaddC7:
      case _ssIaddC8:
      case _ssIaddC9:
        r[d] += _sign32(ins.imm);
      case _ssIxorC7:
      case _ssIxorC8:
      case _ssIxorC9:
        r[d] ^= _sign32(ins.imm);
      case _ssImulh:
        r[d] = _mulh(r[d], r[s]);
      case _ssIsmulh:
        r[d] = _smulh(r[d], r[s]);
      case _ssImulRcp:
        r[d] *= rcps[ins.imm];
      default:
        break;
    }
  }
}

class RxLight {
  RxLight(this.memory);
  final Uint8List memory;
  final List<_SsProg> programs = [];
  final List<int> rcps = [];

  void initPrograms(Uint8List key) {
    final gen = _Gen(key);
    programs.clear();
    rcps.clear();
    for (var i = 0; i < 8; i++) {
      final prog = generateSuperscalar(gen);
      for (var j = 0; j < prog.size; j++) {
        final ins = prog.ops[j];
        if (ins.opcode == _ssImulRcp) {
          final rcp = reciprocal32(ins.imm);
          ins.imm = rcps.length;
          rcps.add(rcp);
        }
      }
      programs.add(prog);
    }
  }

  void xorItem(List<int> dst, int itemNumber) {
    final got = datasetItem(itemNumber);
    for (var q = 0; q < 8; q++) {
      dst[q] ^= _load64(got, 8 * q);
    }
  }

  Uint8List datasetItem(int itemNumber) {
    final r = List<int>.filled(8, 0);
    final rl0 = (itemNumber + 1) * _mul0;
    r[0] = rl0;
    r[1] = rl0 ^ _add1;
    r[2] = rl0 ^ _add2;
    r[3] = rl0 ^ _add3;
    r[4] = rl0 ^ _add4;
    r[5] = rl0 ^ _add5;
    r[6] = rl0 ^ _add6;
    r[7] = rl0 ^ _add7;
    var registerValue = itemNumber;
    for (var i = 0; i < 8; i++) {
      final off = (registerValue & _cacheLineMask) * 64;
      executeSuperscalar(r, programs[i], rcps);
      for (var q = 0; q < 8; q++) {
        r[q] ^= _load64(memory, off + 8 * q);
      }
      registerValue = r[programs[i].addr];
    }
    final out = Uint8List(64);
    for (var q = 0; q < 8; q++) {
      _store64(out, 8 * q, r[q]);
    }
    return out;
  }
}

int _load64(Uint8List m, int off) {
  var w = 0;
  for (var b = 0; b < 8; b++) {
    w |= m[off + b] << (8 * b);
  }
  return w;
}

void _store64(Uint8List m, int off, int w) {
  for (var b = 0; b < 8; b++) {
    m[off + b] = (w >> (8 * b)) & 0xff;
  }
}
