import net from 'node:net';
import { MAGIC_TESTNET, PRODUCT_VERSION } from '../../crypto/asert.js';

export const P2P_PORT = 30303;
export const P2P_UA = `shear-node/${PRODUCT_VERSION}`;

export function encodeWireBlock(b) {
  return {
    header: Buffer.from(b.header).toString('hex'),
    hash: Buffer.from(b.hash).toString('hex'),
    height: b.height,
    txs: b.txs,
    samples: b.samples,
    miner: b.miner,
  };
}

export function decodeWireBlock(w) {
  return {
    header: Buffer.from(w.header, 'hex'),
    hash: w.hash ? Buffer.from(w.hash, 'hex') : undefined,
    height: w.height,
    txs: w.txs,
    samples: w.samples,
    miner: w.miner,
  };
}

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

export function createP2p({
  store,
  port = P2P_PORT,
  host = '0.0.0.0',
  magic = MAGIC_TESTNET,
} = {}) {
  const sockets = new Set();
  let server = null;

  function tipMsg() {
    const t = store.tip();
    return {
      type: 'tip',
      magic,
      height: t?.height || 0,
      hash: t ? Buffer.from(t.hash).toString('hex') : '',
    };
  }

  function send(sock, msg) {
    try { sock.write(line(msg)); } catch { /* ignore */ }
  }

  function broadcast(msg, except) {
    for (const s of sockets) {
      if (s !== except) send(s, msg);
    }
  }

  function handle(sock, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.magic && msg.magic !== magic) {
      sock.destroy();
      return;
    }
    if (msg.type === 'hello') {
      send(sock, tipMsg());
      return;
    }
    if (msg.type === 'tip' || msg.type === 'inv') {
      const local = store.tip();
      const localHash = local ? Buffer.from(local.hash).toString('hex') : '';
      if (msg.hash && msg.hash !== localHash) {
        send(sock, { type: 'getblocks', magic });
      }
      return;
    }
    if (msg.type === 'getblocks') {
      send(sock, {
        type: 'blocks',
        magic,
        blocks: store.blocks.map(encodeWireBlock),
      });
      return;
    }
    if (msg.type === 'blocks') {
      const fork = (msg.blocks || []).map(decodeWireBlock);
      const before = store.tip();
      const got = store.ingest(fork);
      const after = store.tip();
      const changed = (before && after)
        ? !Buffer.from(before.hash).equals(Buffer.from(after.hash))
        : Boolean(after && !before);
      if (got?.ok && changed) broadcast(tipMsg(), sock);
    }
  }

  function attach(sock) {
    sockets.add(sock);
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        handle(sock, msg);
      }
    });
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => sockets.delete(sock));
    send(sock, { type: 'hello', magic, ua: P2P_UA });
    send(sock, tipMsg());
  }

  function listen() {
    server = net.createServer(attach);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        resolve({ host, port: server.address().port });
      });
    });
  }

  function connect(peerHost, peerPort) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(peerPort, peerHost, () => {
        attach(sock);
        resolve(sock);
      });
      sock.once('error', reject);
    });
  }

  function announce() {
    broadcast(tipMsg());
  }

  function close() {
    for (const s of sockets) {
      try { s.destroy(); } catch { /* ignore */ }
    }
    sockets.clear();
    if (server) {
      server.close();
      server = null;
    }
  }

  function wrap(name) {
    if (typeof store[name] !== 'function') return;
    const orig = store[name].bind(store);
    store[name] = (...args) => {
      const got = orig(...args);
      if (got?.ok) announce();
      return got;
    };
  }
  wrap('append');
  wrap('adopt');
  wrap('ingest');
  wrap('submitHeader');

  return {
    listen,
    connect,
    close,
    announce,
    sockets,
    get port() { return server?.address()?.port ?? port; },
    get listening() { return Boolean(server?.listening); },
  };
}
