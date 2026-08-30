VERSION ?= 1.1
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

.PHONY: all clean selftest randomx

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
