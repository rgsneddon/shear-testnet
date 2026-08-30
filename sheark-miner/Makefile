VERSION ?= 1.0
CC ?= cc
CXX ?= c++
CFLAGS ?= -O2 -Wall -Wextra -std=c11
RX := $(abspath ../crypto/randomx)
RXBUILD := $(RX)/build
RXLIB := $(RXBUILD)/librandomx.a
INCLUDES := -Isrc -I$(RX)/src

ifeq ($(OS),Windows_NT)
  BIN := ShearK-Miner.exe
  LIBS ?= -lws2_32 -pthread
else
  BIN := ShearK-Miner
  LIBS ?= -pthread -lm
endif

OBJS := src/sheark_miner.o src/shear_hash.o src/sha512.o

.PHONY: all clean selftest randomx

all: $(BIN)

randomx: $(RXLIB)

$(RXLIB):
	mkdir -p $(RXBUILD)
	cd $(RXBUILD) && cmake -DCMAKE_BUILD_TYPE=Release -DARCH=native $(RX)
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
