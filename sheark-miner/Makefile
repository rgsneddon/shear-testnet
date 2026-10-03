VERSION ?= 2.8
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
  endif
endif
# Public packs stay on the compiler baseline. SHEARK_NATIVE=1 is a local opt-in.
ifeq ($(SHEARK_NATIVE),1)
  CFLAGS += -march=native
endif
RX := $(abspath ../crypto/randomx)
RXBUILD := $(RX)/build
RXLIB := $(RXBUILD)/librandomx.a
RX_ARCH := default
ifeq ($(SHEARK_NATIVE),1)
  RX_ARCH := native
endif
INCLUDES := -Isrc -I$(RX)/src

ifeq ($(OS),Windows_NT)
  BIN := ShearK-Miner.exe
  # Do not -static and do not -L the MSYS lib dir: that steals libmingw32
  # (_gnu_exception_handler) and cannot link MSYS OpenSSL. Link the DLLs
  # by path. sheark-miner/pack/zip_windows.py copies them beside the exe.
  LIBS ?= -lws2_32 -lcrypt32 -pthread
  CMAKE_GEN ?= -G "MinGW Makefiles"
  OPENSSL_BIN ?= C:/msys64/mingw64/bin
  OPENSSL_INC ?= C:/msys64/mingw64/include
  CFLAGS += -I$(OPENSSL_INC)
  OPENSSL_DLLS := $(OPENSSL_BIN)/libssl-3-x64.dll $(OPENSSL_BIN)/libcrypto-3-x64.dll
else
  BIN := ShearK-Miner
  LIBS ?= -pthread -lm -lssl -lcrypto
  CMAKE_GEN ?=
  OPENSSL_DLLS :=
endif

OBJS := src/sheark_miner.o src/shear_hash.o src/sha256.o src/sha512.o src/stratum_tls.o

.PHONY: all clean selftest randomx

all: $(BIN)

randomx: $(RXLIB)

$(RXLIB):
	mkdir -p $(RXBUILD)
	cd $(RXBUILD) && cmake $(CMAKE_GEN) -DCMAKE_BUILD_TYPE=Release -DARCH=$(RX_ARCH) $(RX)
	$(MAKE) -C $(RXBUILD) -j4

src/%.o: src/%.c src/shear_hash.h src/sha512.h src/stratum_tls.h src/tls_roots.h
	$(CC) $(CFLAGS) $(INCLUDES) -c -o $@ $<

$(BIN): $(RXLIB) $(OBJS)
	$(CXX) $(CFLAGS) -o $@ $(OBJS) $(RXLIB) $(OPENSSL_DLLS) $(LIBS)
ifeq ($(OS),Windows_NT)
	python pack/zip_windows.py --stage
endif

selftest: $(BIN)
	./$(BIN) --selftest

clean:
	rm -f $(BIN) src/*.o
	rm -rf $(RXBUILD)
