VERSION ?= 1.1
CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -std=c11
UNAME_S := $(shell uname -s)
ifeq ($(OS),Windows_NT)
  BIN := Shear-Miner.exe
  LIBS ?= -lws2_32 -pthread
  # Static GCC runtime and winpthreads: no MinGW DLLs ship (docs/licensing-audit.md decision 4).
  WIN_STATIC_RT := -static-libgcc -Wl,-Bstatic,--whole-archive -lwinpthread -Wl,--no-whole-archive,-Bdynamic
else
  BIN := Shear-Miner
  LIBS ?= -pthread -lm
  WIN_STATIC_RT :=
  ifeq ($(UNAME_S),Linux)
    # Static libgcc: no libgcc_s.so.1 ships (docs/licensing-audit.md decision 4).
    LINUX_STATIC_RT := -static-libgcc
    GCC_RT_CHECK := python3 ../scripts/licenses/release_notices.py no-gcc-runtime
  endif
endif

SCALAR_OBJS := src/shear_miner.o src/shear_hash.o src/sha256.o src/sha256_dispatch.o
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),arm64)
  ISA_OBJS := src/sha256_isa_stub.o
else ifeq ($(UNAME_M),aarch64)
  ISA_OBJS := src/sha256_isa_stub.o
else
  ISA_OBJS := src/sha256_ni.o src/sha256_avx2.o
endif
# x86_64 public builds pin the ISA baseline (scripts/randomx_build.sh says
# why). The SHA-NI and AVX2 kernels add their own flags and run only after
# sha256_dispatch.c checks cpuid. scripts/isa_scan.py checks the binary.
ifneq ($(filter x86_64 amd64 AMD64,$(UNAME_M)),)
  X86_BASELINE := -march=x86-64 -mtune=generic
endif

.PHONY: all clean selftest

all: $(BIN)

src/%.o: src/%.c
	$(CC) $(X86_BASELINE) $(CFLAGS) -c -o $@ $<

src/sha256_ni.o: src/sha256_ni.c src/sha256.h
	$(CC) $(X86_BASELINE) $(CFLAGS) -msse4.1 -msha -c -o $@ src/sha256_ni.c

src/sha256_avx2.o: src/sha256_avx2.c src/sha256.h
	$(CC) $(X86_BASELINE) $(CFLAGS) -mavx2 -DSHEAR_ALLOW_AVX2 -c -o $@ src/sha256_avx2.c

$(BIN): $(SCALAR_OBJS) $(ISA_OBJS)
	$(CC) $(X86_BASELINE) $(CFLAGS) -o $@ $(SCALAR_OBJS) $(ISA_OBJS) $(LIBS) $(WIN_STATIC_RT) $(LINUX_STATIC_RT)
ifdef GCC_RT_CHECK
	$(GCC_RT_CHECK) $@
endif

selftest: $(BIN)
	./$(BIN) --selftest

clean:
	rm -f $(BIN) src/*.o
