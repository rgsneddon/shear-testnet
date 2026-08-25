VERSION ?= 0.1.6
CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -std=c11
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)
ifeq ($(OS),Windows_NT)
  BIN := shear-miner.exe
  LIBS ?= -lws2_32 -pthread
else
  BIN := shear-miner
  LIBS ?= -pthread
endif

SCALAR_OBJS := src/shear_miner.o src/shear_hash.o src/sha256.o src/sha256_dispatch.o
ifeq ($(UNAME_M),x86_64)
  ISA_OBJS := src/sha256_ni.o src/sha256_avx2.o
else ifeq ($(UNAME_M),amd64)
  ISA_OBJS := src/sha256_ni.o src/sha256_avx2.o
else
  ISA_OBJS := src/sha256_isa_stub.o
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
