/* Connect-and-send inside each address box. Loads the Ledger bundle and calls
   a public RPC only after the visitor clicks Connect. One transport is shared
   by every box: connecting again closes the previous one. */
(function () {
  'use strict';
  // Each network: which Ledger app, and the bundle calls.
  var NETS = {
    eth: { label: 'Ethereum (ETH)', app: 'Ethereum', send: 'evmSend', chainId: 1, symbol: 'ETH', dp: 18, rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io/tx/' },
    base: { label: 'Base (ETH)', app: 'Ethereum', send: 'evmSend', chainId: 8453, symbol: 'ETH', dp: 18, rpc: 'https://base-rpc.publicnode.com', explorer: 'https://basescan.org/tx/' },
    arb: { label: 'Arbitrum One (ETH)', app: 'Ethereum', send: 'evmSend', chainId: 42161, symbol: 'ETH', dp: 18, rpc: 'https://arbitrum-one-rpc.publicnode.com', explorer: 'https://arbiscan.io/tx/' },
    pol: { label: 'Polygon PoS (POL)', app: 'Ethereum', send: 'evmSend', chainId: 137, symbol: 'POL', dp: 18, rpc: 'https://polygon-bor-rpc.publicnode.com', explorer: 'https://polygonscan.com/tx/' },
    sol: { label: 'Solana (SOL)', app: 'Solana', send: 'solSend', symbol: 'SOL', dp: 9, rpc: 'https://solana-rpc.publicnode.com', explorer: 'https://solscan.io/tx/' }
  };
  Object.keys(NETS).forEach(function (k) { NETS[k].id = k; NETS[k].rpcHost = new URL(NETS[k].rpc).host; });
  // Per address box (addresses.json id): the networks it can send on, or a note.
  var BOXES = {
    evm: { nets: ['eth', 'base', 'arb', 'pol'], app: 'Ethereum' },
    sol: { nets: ['sol'], app: 'Solana' },
    btc: { soon: true }, ltc: { soon: true }, doge: { soon: true }, kas: { soon: true },
    xmr: { note: 'Ledger send is not offered for Monero: a Monero send needs a full wallet (scanning outputs, building ring signatures, talking to a daemon), which a web page cannot do safely. Copy the address or scan the QR in your Monero wallet.' }
  };
  var transport = null;
  var hasUsb = !!(navigator.hid || navigator.usb), hasBle = !!navigator.bluetooth;
  var usbKind = navigator.hid ? 'WebHID' : 'WebUSB';

  var bundleP = null;
  function loadBundle() {
    if (window.ShearLedger) return Promise.resolve(window.ShearLedger);
    if (!bundleP) bundleP = new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = 'vendor/ledger-bundle.js';
      s.onload = function () { ok(window.ShearLedger); };
      s.onerror = function () { bundleP = null; bad(new Error('Could not load the Ledger library')); };
      document.body.appendChild(s);
    });
    return bundleP;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(text, onClick) {
    var b = el('button', 'btn', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function friendly(e, connecting, app) {
    var m = (e && (e.message || e.statusText)) || String(e);
    var name = (e && (e.name || e.id)) || 'Error';
    var msg;
    if (/0x6511|0x6d00|0x6e00|0x6e01|CLA_NOT_SUPPORTED|INS_NOT_SUPPORTED/i.test(m)) msg = 'Open the ' + app + ' app on your Ledger, then try again.';
    else if (/0x6985|denied by the user|rejected/i.test(m)) msg = 'Cancelled on the Ledger. Nothing was sent.';
    else if (/locked|0x5515/i.test(m)) msg = 'Unlock your Ledger, open the ' + app + ' app, then try again.';
    else if (connecting && /NotFound|No device selected|cancel/i.test(name + ' ' + m)) msg = 'No Ledger was chosen in the browser prompt. Plug in or switch on the Ledger, unlock it, and try Connect again.';
    else if (connecting && /NotAllowed|Security|permission/i.test(name + ' ' + m)) msg = 'The browser blocked access to the device. Allow it when prompted (on Android, also allow Bluetooth and Nearby devices for Chrome), then try again.';
    else if (connecting && /Access denied|claimInterface|in use/i.test(m)) msg = 'Another app (such as Ledger Live) is using the Ledger. Close it, then try again.';
    else if (/disconnected|DisconnectedDevice/i.test(name + ' ' + m)) { transport = null; msg = 'The Ledger disconnected. Connect again.'; }
    else msg = connecting ? 'Could not connect to the Ledger.' : 'The send did not complete. Nothing was sent unless a transaction link appears.';
    return msg + ' [' + name + ': ' + m + ']';
  }

  function build(a) {
    var cfg = BOXES[a.id];
    var row = document.getElementById('addr-' + a.id);
    if (!cfg || !row) return;
    var info = row.querySelector('.donate-info') || row;
    var box = el('div', 'donate-send');
    info.appendChild(box);
    if (cfg.note) { box.appendChild(el('p', 'donate-send-note', cfg.note)); return; }
    if (cfg.soon) { box.appendChild(el('p', 'donate-send-note', 'Ledger send coming soon. For now, copy the address or scan the QR.')); return; }
    if (!hasUsb && !hasBle) {
      var w = el('p', 'send-warn');
      w.appendChild(el('strong', null, 'Your browser can’t connect to a Ledger.'));
      w.appendChild(document.createTextNode(' Use Chrome or Edge (Android: Chrome), or copy the address / scan the QR.'));
      box.appendChild(w);
      return;
    }
    var st = el('div', 'send-status');
    st.setAttribute('aria-live', 'polite');
    function status(t, warn) { st.textContent = t; st.className = 'send-status' + (warn ? ' send-warn' : ''); }

    var sel = null;
    function net() { return NETS[(sel && sel.value) || cfg.nets[0]]; }

    function doConnect(kind) {
      status(kind === 'usb' ? 'Connecting by USB (' + usbKind + '). Pick your Ledger in the browser prompt ...' : 'Connecting by Bluetooth. Pick your Nano X in the browser prompt ...');
      loadBundle().then(function (L) {
        if (transport) { try { transport.close(); } catch (e) {} transport = null; }
        return L.connect(kind).then(function (t) { transport = t; });
      }).then(function () {
        status('Connected. Open the ' + cfg.app + ' app on your Ledger, enter an amount, then review and sign.');
      }).catch(function (e) { status(friendly(e, true, cfg.app), true); });
    }

    var conn = el('div', 'donate-tools');
    if (hasUsb) conn.appendChild(button('Connect Ledger by USB', function () { doConnect('usb'); }));
    if (hasBle) conn.appendChild(button('Connect Nano X by Bluetooth', function () { doConnect('ble'); }));
    box.appendChild(conn);
    if (!(hasUsb && hasBle)) box.appendChild(el('p', 'send-warn', hasUsb ? 'Bluetooth is not available in this browser; USB works.' : 'USB is not available in this browser; Bluetooth (Nano X) works.'));

    var form = el('div', 'send-grid');
    if (cfg.nets.length > 1) {
      var lab = el('label', null, 'Network');
      sel = document.createElement('select');
      cfg.nets.forEach(function (k) { var o = el('option', null, NETS[k].label); o.value = k; sel.appendChild(o); });
      lab.appendChild(sel);
      form.appendChild(lab);
    }
    var alab = el('label', null, 'Amount (' + net().symbol + ')');
    var amtIn = document.createElement('input');
    amtIn.inputMode = 'decimal'; amtIn.placeholder = '0.01'; amtIn.autocomplete = 'off';
    alab.appendChild(amtIn);
    form.appendChild(alab);
    if (sel) sel.addEventListener('change', function () { alab.firstChild.textContent = 'Amount (' + net().symbol + ')'; });
    var sendBtn = button('Review and sign on Ledger', function () {
      var c = net(), to = a.address;
      var amt = amtIn.value.trim();
      if (!transport) return status('Connect your Ledger first: use "Connect Ledger by USB" or "Connect Nano X by Bluetooth" above, unlock it and open the coin app.', true);
      var mm = /^[0-9]+(?:[.]([0-9]+))?$/.exec(amt);
      if (!mm || (mm[1] && mm[1].length > c.dp)) return status('Enter an amount like 0.01 (up to ' + c.dp + ' decimals)', true);
      sendBtn.disabled = true;
      window.ShearLedger[c.send](transport, c, to, amt, status).then(function (r) {
        st.className = 'send-status';
        st.textContent = 'Sent. Thank you! Transaction: ';
        var l = document.createElement('a'); l.href = c.explorer + r.hash; l.textContent = r.hash; l.rel = 'noopener noreferrer'; l.target = '_blank';
        st.appendChild(l);
      }).catch(function (e) { status(friendly(e, false, c.app), true); }).then(function () { sendBtn.disabled = false; });
    });
    var sr = el('div', 'send-row');
    sr.appendChild(sendBtn);
    form.appendChild(sr);
    form.appendChild(st);
    box.appendChild(form);
  }

  function init() { (window.SHEAR_DONATE_ADDRESSES || []).forEach(build); }
  if (window.SHEAR_DONATE_ADDRESSES) init();
  else document.addEventListener('donate:addresses', init, { once: true });
})();
