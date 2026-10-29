VERSION ?= 2.9
CC ?= cc
# GNU Make defaults CXX to g++ even when g++ is absent (WSL clang-only).
ifeq ($(origin CXX),default)
  CXX := c++
endif
CXX ?= c++
# WinLibs make sets CC=cc, which is not on PATH. OpenSSL is the MSYS build.
ifeq ($(OS),Windows_NT)
  ifeq ($(CC),cc)
    override CC := gcc
  endif
  ifeq ($(CXX),c++)
    override CXX := g++
  endif
endif
CFLAGS ?= -O3 -Wall -Wextra -std=c11 -fomit-frame-pointer
ifneq ($(OS),Windows_NT)
  UNAME := $(shell uname -s)
  ifeq ($(UNAME),Linux)
    CFLAGS += -pthread
    # Static libgcc and libstdc++ (RandomX is C++): no pack ships
    # libstdc++.so.6 or libgcc_s.so.1 (docs/licensing-audit.md decision 4).
    # Fedora needs the libstdc++-static package.
    LINUX_STATIC_RT := -static-libgcc -static-libstdc++
    GCC_RT_CHECK := python3 ../scripts/licenses/release_notices.py no-gcc-runtime
  endif
endif
# Public packs pin the x86_64 baseline, not the compiler's default, which can
# be higher (scripts/randomx_build.sh says why; scripts/isa_scan.py checks the
# binary). SHEARK_NATIVE=1 is a local opt-in for this machine only.
ARCH_M := $(shell uname -m 2>/dev/null)
# cmd or PowerShell with mingw32-make has no uname: the CPU is PROCESSOR_ARCHITECTURE.
ifeq ($(strip $(ARCH_M)),)
  ARCH_M := $(PROCESSOR_ARCHITECTURE)
endif
ifneq ($(filter x86_64 amd64 AMD64,$(ARCH_M)),)
  X86_BASELINE := -march=x86-64 -mtune=generic
endif
ifeq ($(SHEARK_NATIVE),1)
  X86_BASELINE :=
  CFLAGS += -march=native
endif
RX := $(abspath ../crypto/randomx)
RXBUILD := $(RX)/build
RXLIB := $(RXBUILD)/librandomx.a
INCLUDES := -Isrc -I$(RX)/src

ifeq ($(OS),Windows_NT)
  BIN := ShearK-Miner.exe
  # Do not -static and do not -L the MSYS lib dir: that steals libmingw32
  # (_gnu_exception_handler) and cannot link MSYS OpenSSL. Link the DLLs
  # by path. sheark-miner/pack/zip_windows.py copies them beside the exe.
  LIBS ?= -lws2_32 -lcrypt32 -pthread -lsodium
  # The GCC runtime and winpthreads are static so their DLLs never ship
  # (docs/licensing-audit.md decision 4). --whole-archive because the driver
  # appends a dynamic -lpthread after these flags.
  WIN_STATIC_RT := -static-libgcc -static-libstdc++ -Wl,-Bstatic,--whole-archive -lwinpthread -Wl,--no-whole-archive,-Bdynamic
  CMAKE_GEN ?= -G "MinGW Makefiles"
  OPENSSL_BIN ?= C:/msys64/mingw64/bin
  OPENSSL_INC ?= C:/msys64/mingw64/include
  CFLAGS += -I$(OPENSSL_INC)
  OPENSSL_DLLS := $(OPENSSL_BIN)/libssl-3-x64.dll $(OPENSSL_BIN)/libcrypto-3-x64.dll
else
  BIN := ShearK-Miner
  # R28 BluNotes: libsodium's ristretto255 for the rig's one-time keys.
  LIBS ?= -pthread -lm -lssl -lcrypto -lsodium
  CMAKE_GEN ?=
  OPENSSL_DLLS :=
  WIN_STATIC_RT :=
endif

# R28: libsodium (ristretto255 share keys) from a prefix, as Homebrew lays it out.
ifneq ($(SODIUM_PREFIX),)
  CFLAGS += -I$(SODIUM_PREFIX)/include
  LIBS += -L$(SODIUM_PREFIX)/lib
endif

# macOS Homebrew OpenSSL is keg-only. Public packs pass OPENSSL_PREFIX.
ifneq ($(OPENSSL_PREFIX),)
  CFLAGS += -I$(OPENSSL_PREFIX)/include
  LIBS += -L$(OPENSSL_PREFIX)/lib
endif

OBJS := src/sheark_miner.o src/shear_hash.o src/sha256.o src/sha512.o src/stratum_tls.o src/blunote.o src/rig.o src/stats.o

.PHONY: all clean selftest randomx

all: $(BIN)

randomx: $(RXLIB)

# R41: librandomx.a depends on the RandomX sources, so an edit under
# crypto/randomx rebuilds it (cmake --build is incremental). Without this an
# existing tree kept linking the old library. randomx_build.sh touches the
# library, so a no-op cmake build still leaves it newer than the sources.
RXSRC := $(wildcard $(RX)/CMakeLists.txt $(RX)/src/*.c $(RX)/src/*.cpp $(RX)/src/*.h $(RX)/src/*.hpp $(RX)/src/*.S $(RX)/src/blake2/*.c $(RX)/src/blake2/*.h)

$(RXLIB): $(RXSRC)
	SHEARK_NATIVE=$(SHEARK_NATIVE) RANDOMX_BUILD_DIR=$(RXBUILD) bash ../scripts/randomx_build.sh $(CMAKE_GEN)

src/%.o: src/%.c src/shear_hash.h src/sha512.h src/stratum_tls.h src/tls_roots.h src/rig.h src/stats.h
	$(CC) $(X86_BASELINE) $(CFLAGS) $(INCLUDES) -c -o $@ $<

$(BIN): $(RXLIB) $(OBJS)
	$(CXX) $(X86_BASELINE) $(CFLAGS) -o $@ $(OBJS) $(RXLIB) $(OPENSSL_DLLS) $(LIBS) $(WIN_STATIC_RT) $(LINUX_STATIC_RT)
ifeq ($(OS),Windows_NT)
	python pack/zip_windows.py --stage
endif
ifdef GCC_RT_CHECK
	$(GCC_RT_CHECK) $@
endif

selftest: $(BIN)
	./$(BIN) --selftest

clean:
	rm -f $(BIN) src/*.o
	rm -rf $(RXBUILD)
