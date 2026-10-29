/* Connect-and-send UI. Loads the Ledger bundle and calls a public RPC only
   after the visitor clicks Connect. */
(function () {
  'use strict';
  // Each network: which address (addresses.json id) it pays, which Ledger app, and the bundle calls.
  var CHAINS = [
    { id: 'eth', label: 'ETH on Ethereum', addr: 'evm', app: 'Ethereum', send: 'evmSend', acct: 'evmAccount', chainId: 1, symbol: 'ETH', dp: 18, rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io/tx/' },
    { id: 'base', label: 'ETH on Base', addr: 'evm', app: 'Ethereum', send: 'evmSend', acct: 'evmAccount', chainId: 8453, symbol: 'ETH', dp: 18, rpc: 'https://base-rpc.publicnode.com', explorer: 'https://basescan.org/tx/' },
    { id: 'arb', label: 'ETH on Arbitrum One', addr: 'evm', app: 'Ethereum', send: 'evmSend', acct: 'evmAccount', chainId: 42161, symbol: 'ETH', dp: 18, rpc: 'https://arbitrum-one-rpc.publicnode.com', explorer: 'https://arbiscan.io/tx/' },
    { id: 'pol', label: 'POL on Polygon PoS', addr: 'evm', app: 'Ethereum', send: 'evmSend', acct: 'evmAccount', chainId: 137, symbol: 'POL', dp: 18, rpc: 'https://polygon-bor-rpc.publicnode.com', explorer: 'https://polygonscan.com/tx/' },
    { id: 'sol', label: 'SOL on Solana', addr: 'sol', app: 'Solana', send: 'solSend', acct: 'solAccount', symbol: 'SOL', dp: 9, rpc: 'https://solana-rpc.publicnode.com', explorer: 'https://solscan.io/tx/' }
  ];
  CHAINS.forEach(function (c) { c.rpcHost = new URL(c.rpc).host; });
  var app = document.getElementById('send-app');
  var transport = null;

  function h(html) { var d = document.createElement('div'); d.innerHTML = html; return d; }
  function addrFor(id) {
    var a = (window.SHEAR_DONATE_ADDRESSES || []).filter(function (x) { return x.id === id; })[0];
    return a && a.address;
  }
  function chainSel() { var v = document.getElementById('s-chain').value; return CHAINS.filter(function (x) { return x.id === v; })[0]; }

  var hasUsb = !!(navigator.hid || navigator.usb), hasBle = !!navigator.bluetooth;
  var usbKind = navigator.hid ? 'WebHID' : 'WebUSB';
  var opts = CHAINS.map(function (c) { return '<option value="' + c.id + '">' + c.label + ' (' + c.symbol + ')</option>'; }).join('');
  var intro = '<p>Send from your own Ledger to our address. You confirm the amount and our address on your Ledger screen before anything is signed. Open the matching app on the device (Ethereum for ETH and POL, Solana for SOL). Bitcoin, Litecoin, Dogecoin and Kaspa sends are coming next. Monero stays copy and QR only: a Monero send needs a full wallet (scanning outputs, building ring signatures, talking to a daemon), which a web page cannot do safely.</p>';
  app.textContent = '';
  if (!hasUsb && !hasBle) {
    app.appendChild(h(intro + '<p class="send-warn"><strong>Your browser can&#39;t connect to a Ledger.</strong> Use Chrome or Edge (Android: Chrome), or copy the address / scan the QR above.</p>'));
    return;
  }
  app.appendChild(h(intro +
    '<div class="send-grid">' +
    '<div class="send-row">' + (hasUsb ? '<button type="button" class="btn" id="c-usb">Connect Ledger by USB</button>' : '') +
    (hasBle ? '<button type="button" class="btn" id="c-ble">Connect Nano X by Bluetooth</button>' : '') + '</div>' +
    (hasUsb && hasBle ? '' : '<p class="send-warn">' + (hasUsb ? 'Bluetooth is not available in this browser; USB works.' : 'USB is not available in this browser; Bluetooth (Nano X) works.') + '</p>') +
    '<label>Network<select id="s-chain">' + opts + '</select></label>' +
    '<label>Amount<input id="s-amt" inputmode="decimal" placeholder="0.01" autocomplete="off" /></label>' +
    '<div class="send-row"><button type="button" class="btn" id="s-send" disabled>Review and sign on Ledger</button></div>' +
    '<div class="send-status" id="s-status" aria-live="polite"></div></div>'));
  var st = document.getElementById('s-status');
  function status(t, warn) { st.textContent = t; st.className = 'send-status' + (warn ? ' send-warn' : ''); }

  var bundleP = null;
  function loadBundle() {
    if (window.ShearLedger) return Promise.resolve(window.ShearLedger);
    if (!bundleP) bundleP = new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = 'vendor/ledger-bundle.js';
      s.onload = function () { ok(window.ShearLedger); };
      s.onerror = function () { bad(new Error('Could not load the Ledger library')); };
      document.body.appendChild(s);
    });
    return bundleP;
  }

  function doConnect(kind) {
    status(kind === 'usb' ? 'Connecting by USB (' + usbKind + '). Pick your Ledger in the browser prompt ...' : 'Connecting by Bluetooth. Pick your Nano X in the browser prompt ...');
    loadBundle().then(function (L) {
      if (transport) { try { transport.close(); } catch (e) {} transport = null; }
      return L.connect(kind).then(function (t) { transport = t; });
    }).then(function () {
      document.getElementById('s-send').disabled = false;
      status('Connected. Pick a network, open its app on your Ledger, enter an amount, then review and sign.');
    }).catch(function (e) { status(friendly(e, true), true); });
  }
  function friendly(e, connecting) {
    var m = (e && (e.message || e.statusText)) || String(e);
    var name = (e && (e.name || e.id)) || 'Error';
    var msg;
    if (/0x6511|0x6d00|0x6e00|0x6e01|CLA_NOT_SUPPORTED|INS_NOT_SUPPORTED/i.test(m)) msg = 'Open the ' + chainSel().app + ' app on your Ledger, then try again.';
    else if (/0x6985|denied by the user|rejected/i.test(m)) msg = 'Cancelled on the Ledger. Nothing was sent.';
    else if (/locked|0x5515/i.test(m)) msg = 'Unlock your Ledger, open the ' + chainSel().app + ' app, then try again.';
    else if (connecting && /NotFound|No device selected|cancel/i.test(name + ' ' + m)) msg = 'No Ledger was chosen in the browser prompt. Plug in or switch on the Ledger, unlock it, and try Connect again.';
    else if (connecting && /NotAllowed|Security|permission/i.test(name + ' ' + m)) msg = 'The browser blocked access to the device. Allow it when prompted (on Android, also allow Bluetooth and Nearby devices for Chrome), then try again.';
    else if (connecting && /Access denied|claimInterface|in use/i.test(m)) msg = 'Another app (such as Ledger Live) is using the Ledger. Close it, then try again.';
    else if (/disconnected|DisconnectedDevice/i.test(name + ' ' + m)) { transport = null; document.getElementById('s-send').disabled = true; msg = 'The Ledger disconnected. Connect again.'; }
    else msg = connecting ? 'Could not connect to the Ledger.' : 'The send did not complete. Nothing was sent unless a transaction link appears.';
    return msg + ' [' + name + ': ' + m + ']';
  }
  if (hasUsb) document.getElementById('c-usb').addEventListener('click', function () { doConnect('usb'); });
  if (hasBle) document.getElementById('c-ble').addEventListener('click', function () { doConnect('ble'); });
  document.getElementById('s-send').addEventListener('click', function () {
    var btn = this, c = chainSel(), to = addrFor(c.addr);
    var amt = document.getElementById('s-amt').value.trim();
    if (!to) return status('Address list not loaded yet.', true);
    var mm = /^[0-9]+(?:[.]([0-9]+))?$/.exec(amt);
    if (!mm || (mm[1] && mm[1].length > c.dp)) return status('Enter an amount like 0.01 (up to ' + c.dp + ' decimals)', true);
    btn.disabled = true;
    window.ShearLedger[c.send](transport, c, to, amt, status).then(function (r) {
      st.className = 'send-status';
      st.textContent = 'Sent. Thank you! Transaction: ';
      var a = document.createElement('a'); a.href = c.explorer + r.hash; a.textContent = r.hash; a.rel = 'noopener noreferrer'; a.target = '_blank';
      st.appendChild(a);
    }).catch(function (e) { status(friendly(e), true); }).then(function () { btn.disabled = false; });
  });
})();
