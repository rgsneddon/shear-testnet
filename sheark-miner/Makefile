VERSION ?= 1.5
CC ?= cc
# GNU Make defaults CXX to g++ even when g++ is absent (WSL clang-only).
ifeq ($(origin CXX),default)
  CXX := c++
endif
CXX ?= c++
CFLAGS ?= -O3 -Wall -Wextra -std=c11 -fomit-frame-pointer
ifneq ($(OS),Windows_NT)
  UNAME := $(shell uname -s)
  ifeq ($(UNAME),Linux)
    CFLAGS += -march=native -pthread
  endif
endif
RX := $(abspath ../crypto/randomx)
RXBUILD := $(RX)/build
RXLIB := $(RXBUILD)/librandomx.a
INCLUDES := -Isrc -I$(RX)/src

ifeq ($(OS),Windows_NT)
  BIN := ShearK-Miner.exe
  LIBS ?= -lws2_32 -pthread -static
  CMAKE_GEN ?= -G "MinGW Makefiles"
else
  BIN := ShearK-Miner
  LIBS ?= -pthread -lm
  CMAKE_GEN ?=
endif

OBJS := src/sheark_miner.o src/shear_hash.o src/sha512.o

.PHONY: all clean selftest randomx mainnet

# Magic-only 1.5 rebuild. Does not recut version. Do not replace the testnet binary.
MAINNET_BIN := ShearK-Miner-mainnet
MAINNET_CFLAGS := $(CFLAGS) -DSHEAR_MAGIC=\"shear-v1\"

mainnet: $(RXLIB)
	$(CC) $(MAINNET_CFLAGS) $(INCLUDES) -c -o src/sheark_miner_mainnet.o src/sheark_miner.c
	$(CC) $(MAINNET_CFLAGS) $(INCLUDES) -c -o src/shear_hash_mainnet.o src/shear_hash.c
	$(CC) $(CFLAGS) $(INCLUDES) -c -o src/sha512.o src/sha512.c
	$(CXX) $(CFLAGS) -o $(MAINNET_BIN) src/sheark_miner_mainnet.o src/shear_hash_mainnet.o src/sha512.o $(RXLIB) $(LIBS)

all: $(BIN)

randomx: $(RXLIB)

$(RXLIB):
	mkdir -p $(RXBUILD)
	cd $(RXBUILD) && cmake $(CMAKE_GEN) -DCMAKE_BUILD_TYPE=Release -DARCH=native $(RX)
	$(MAKE) -C $(RXBUILD) -j4

src/%.o: src/%.c src/shear_hash.h src/sha512.h
	$(CC) $(CFLAGS) $(INCLUDES) -c -o $@ $<

$(BIN): $(RXLIB) $(OBJS)
	$(CXX) $(CFLAGS) -o $@ $(OBJS) $(RXLIB) $(LIBS)

selftest: $(BIN)
	./$(BIN) --selftest

clean:
	rm -f $(BIN) src/*.o
	rm -rf $(RXBUILD)
