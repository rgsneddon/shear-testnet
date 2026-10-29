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

  var hasHid = !!navigator.hid, hasBle = !!navigator.bluetooth;
  var opts = CHAINS.map(function (c) { return '<option value="' + c.id + '">' + c.label + ' (' + c.symbol + ')</option>'; }).join('');
  app.textContent = '';
  app.appendChild(h(
    '<p>Send from your own Ledger to our address. You confirm the amount and our address on your Ledger screen before anything is signed. Open the matching app on the device (Ethereum for ETH and POL, Solana for SOL). Needs Chrome, Edge, Brave or Opera on desktop, or Chrome on Android for Bluetooth. Bitcoin, Litecoin, Dogecoin and Kaspa sends are coming next. Monero stays copy and QR only: a Monero send needs a full wallet (scanning outputs, building ring signatures, talking to a daemon), which a web page cannot do safely.</p>' +
    (hasHid || hasBle ? '' : '<p class="send-warn">This browser supports neither WebHID nor Web Bluetooth, so it cannot talk to a Ledger. Use a Chromium-based desktop browser, or copy an address above instead.</p>') +
    '<div class="send-grid">' +
    '<div class="send-row"><button type="button" class="btn" id="c-usb"' + (hasHid ? '' : ' disabled title="WebHID not supported in this browser"') + '>Connect Ledger by USB</button>' +
    '<button type="button" class="btn" id="c-ble"' + (hasBle ? '' : ' disabled title="Web Bluetooth not supported in this browser"') + '>Connect Nano X by Bluetooth</button></div>' +
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
    status('Connecting ...');
    loadBundle().then(function (L) {
      if (transport) { try { transport.close(); } catch (e) {} transport = null; }
      return L.connect(kind).then(function (t) { transport = t; });
    }).then(function () {
      document.getElementById('s-send').disabled = false;
      status('Connected. Pick a network, open its app on your Ledger, enter an amount, then review and sign.');
    }).catch(function (e) { status(friendly(e), true); });
  }
  function friendly(e) {
    var m = (e && (e.message || e.name)) || String(e);
    if (/0x6511|0x6d00|0x6e00|0x6e01|CLA_NOT_SUPPORTED|INS_NOT_SUPPORTED/i.test(m)) return 'Open the ' + chainSel().app + ' app on your Ledger, then try again.';
    if (/0x6985|denied|rejected/i.test(m)) return 'Cancelled on the Ledger. Nothing was sent.';
    if (/locked|0x5515/i.test(m)) return 'Unlock your Ledger, open the ' + chainSel().app + ' app, then try again.';
    if (/disconnected|closed|NotFound/i.test(m)) { transport = null; document.getElementById('s-send').disabled = true; return 'The Ledger disconnected. Connect again.'; }
    return 'Error: ' + m;
  }
  if (hasHid) document.getElementById('c-usb').addEventListener('click', function () { doConnect('usb'); });
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
