import http from 'node:http';

export const RPC_PORT = 18332;
export const RPC_HOST = '127.0.0.1';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || ''));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export function createRpc({
  store,
  p2p = null,
  port = Number(process.env.SHEAR_RPC_PORT || RPC_PORT),
  host = process.env.SHEAR_RPC_BIND || RPC_HOST,
} = {}) {
  const sse = new Set();

  function pushEvent(ev, payload) {
    const line = `event: ${ev}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sse) {
      try { res.write(line); } catch { /* drop */ }
    }
  }

  if (store && typeof store.on === 'function') {
    store.on('reorg', (e) => pushEvent('reorg', e));
    store.on('credits_frozen', (e) => pushEvent('credits_frozen', e));
  }

  function dispatch(method, params = {}) {
    const m = String(method || '');
    if (m === 'getpolicy' || m === 'policy') {
      return { ok: true, ...(typeof store.getpolicy === 'function' ? store.getpolicy() : {}) };
    }
    if (m === 'getchaintips' || m === 'chaintips') {
      return { ok: true, tips: typeof store.getchaintips === 'function' ? store.getchaintips() : [] };
    }
    if (m === 'getreorgs' || m === 'reorgs') {
      return { ok: true, reorgs: typeof store.getreorgs === 'function' ? store.getreorgs() : [] };
    }
    if (m === 'addnode') {
      const hostP = String(params.host || params[0] || '');
      const portP = Number(params.port || params[1] || 30303);
      if (!hostP || !p2p || typeof p2p.connect !== 'function') {
        return { ok: false, reason: 'no_p2p' };
      }
      return p2p.connect(hostP, portP).then(() => ({ ok: true, host: hostP, port: portP }))
        .catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    }
    if (m === 'setTip' || m === 'settip') {
      return { ok: false, reason: 'setTip_forbidden' };
    }
    return { ok: false, reason: 'unknown_method', method: m };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('\n');
      sse.add(res);
      req.on('close', () => sse.delete(res));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/policy' || url.pathname === '/getpolicy')) {
      json(res, 200, dispatch('getpolicy'));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/chaintips' || url.pathname === '/getchaintips')) {
      json(res, 200, dispatch('getchaintips'));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/reorgs' || url.pathname === '/getreorgs')) {
      json(res, 200, dispatch('getreorgs'));
      return;
    }
    let body = {};
    if (req.method === 'POST') {
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch {
        json(res, 400, { ok: false, reason: 'bad_json' });
        return;
      }
    }
    const method = body.method || url.pathname.replace(/^\//, '');
    const params = body.params || Object.fromEntries(url.searchParams);
    const got = dispatch(method, params);
    const out = typeof got?.then === 'function' ? await got : got;
    if (body.id != null) {
      json(res, 200, { jsonrpc: '2.0', id: body.id, result: out });
      return;
    }
    json(res, out?.ok === false ? 400 : 200, out);
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        resolve({ host, port: server.address().port });
      });
    });
  }

  function close() {
    for (const res of sse) {
      try { res.end(); } catch { /* */ }
    }
    sse.clear();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { listen, close, dispatch, server, get port() { return server.address()?.port ?? port; } };
}
