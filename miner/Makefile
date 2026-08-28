VERSION ?= 1.0
CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -std=c11
UNAME_S := $(shell uname -s)
ifeq ($(OS),Windows_NT)
  BIN := Shear-Miner.exe
  LIBS ?= -lws2_32 -pthread
else
  BIN := Shear-Miner
  LIBS ?= -pthread
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

.PHONY: all clean selftest

all: $(BIN)

src/%.o: src/%.c
	$(CC) $(CFLAGS) -c -o $@ $<

src/sha256_ni.o: src/sha256_ni.c src/sha256.h
	$(CC) $(CFLAGS) -msse4.1 -msha -c -o $@ src/sha256_ni.c

src/sha256_avx2.o: src/sha256_avx2.c src/sha256.h
	$(CC) $(CFLAGS) -mavx2 -DSHEAR_ALLOW_AVX2 -c -o $@ src/sha256_avx2.c

$(BIN): $(SCALAR_OBJS) $(ISA_OBJS)
	$(CC) $(CFLAGS) -o $@ $(SCALAR_OBJS) $(ISA_OBJS) $(LIBS)

selftest: $(BIN)
	./$(BIN) --selftest

clean:
	rm -f $(BIN) src/*.o
