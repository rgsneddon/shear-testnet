VERSION ?= 0.1.1
CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -std=c11
UNAME_S := $(shell uname -s)
ifeq ($(OS),Windows_NT)
  BIN := shear-miner.exe
  LIBS ?= -lws2_32 -pthread
else
  BIN := shear-miner
  LIBS ?= -pthread
endif

SRC := src/shear_miner.c src/shear_hash.c

.PHONY: all clean selftest

all: $(BIN)

$(BIN): $(SRC) src/shear_hash.h
	$(CC) $(CFLAGS) -o $@ $(SRC) $(LIBS)

selftest: $(BIN)
	./$(BIN) --selftest

clean:
	rm -f $(BIN)
