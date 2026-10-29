/* Connect-and-send UI. Loads the Ledger bundle and calls a public RPC only
   after the visitor clicks Connect. */
(function () {
  'use strict';
  var CHAINS = [
    { id: 'eth', label: 'Ethereum', chainId: 1, symbol: 'ETH', rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io/tx/' },
    { id: 'base', label: 'Base', chainId: 8453, symbol: 'ETH', rpc: 'https://base-rpc.publicnode.com', explorer: 'https://basescan.org/tx/' },
    { id: 'arb', label: 'Arbitrum One', chainId: 42161, symbol: 'ETH', rpc: 'https://arbitrum-one-rpc.publicnode.com', explorer: 'https://arbiscan.io/tx/' },
    { id: 'pol', label: 'Polygon PoS', chainId: 137, symbol: 'POL', rpc: 'https://polygon-bor-rpc.publicnode.com', explorer: 'https://polygonscan.com/tx/' }
  ];
  CHAINS.forEach(function (c) { c.rpcHost = new URL(c.rpc).host; });
  var app = document.getElementById('send-app');
  var transport = null;

  function h(html) { var d = document.createElement('div'); d.innerHTML = html; return d; }
  function evmTo() {
    var a = (window.SHEAR_DONATE_ADDRESSES || []).filter(function (x) { return x.id === 'evm'; })[0];
    return a && a.address;
  }

  var hasHid = !!navigator.hid, hasBle = !!navigator.bluetooth;
  var opts = CHAINS.map(function (c) { return '<option value="' + c.id + '">' + c.label + ' (' + c.symbol + ')</option>'; }).join('');
  app.textContent = '';
  app.appendChild(h(
    '<p>Send ETH or POL from your own Ledger to our EVM address. You confirm the amount and our address on your Ledger screen. Needs the Ethereum app open on the device, and Chrome, Edge, Brave or Opera on desktop (or Chrome on Android for Bluetooth). Bitcoin, Litecoin, Dogecoin and Solana sends are coming next.</p>' +
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
      return L.connect(kind).then(function (t) { transport = t; return L.evmAccount(t); });
    }).then(function (from) {
      document.getElementById('s-send').disabled = false;
      status('Connected. Your Ledger account: ' + from);
    }).catch(function (e) { status(friendly(e), true); });
  }
  function friendly(e) {
    var m = (e && (e.message || e.name)) || String(e);
    if (/0x6511|0x6d00|0x6e00|CLA_NOT_SUPPORTED|INS_NOT_SUPPORTED/i.test(m)) return 'Open the Ethereum app on your Ledger, then connect again.';
    if (/0x6985|denied|rejected/i.test(m)) return 'Cancelled on the Ledger. Nothing was sent.';
    if (/locked|0x5515/i.test(m)) return 'Unlock your Ledger, open the Ethereum app, then connect again.';
    return 'Error: ' + m;
  }
  if (hasHid) document.getElementById('c-usb').addEventListener('click', function () { doConnect('usb'); });
  if (hasBle) document.getElementById('c-ble').addEventListener('click', function () { doConnect('ble'); });
  document.getElementById('s-send').addEventListener('click', function () {
    var btn = this, to = evmTo();
    var c = CHAINS.filter(function (x) { return x.id === document.getElementById('s-chain').value; })[0];
    var amt = document.getElementById('s-amt').value.trim();
    if (!to) return status('Address list not loaded yet.', true);
    if (!/^\d+(\.\d{1,18})?$/.test(amt)) return status('Enter an amount like 0.01', true);
    btn.disabled = true;
    window.ShearLedger.evmSend(transport, c, to, amt, status).then(function (r) {
      st.className = 'send-status';
      st.textContent = 'Sent. Thank you! Transaction: ';
      var a = document.createElement('a'); a.href = c.explorer + r.hash; a.textContent = r.hash; a.rel = 'noopener noreferrer'; a.target = '_blank';
      st.appendChild(a);
    }).catch(function (e) { status(friendly(e), true); }).then(function () { btn.disabled = false; });
  });
})();
