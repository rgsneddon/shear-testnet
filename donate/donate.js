/* donate.shear.digital: address list, copy buttons and client-side QR codes.
   Makes no network request except fetching addresses.json from this same site. */
(function () {
  'use strict';
  var list = document.getElementById('donate-list');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function qrSvg(text) {
    var qr = qrcode(0, 'M'); // type 0 = smallest version that fits
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }

  function copy(text, btn) {
    function done(ok) {
      btn.textContent = ok ? 'Copied' : 'Select and copy';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  }

  function row(a) {
    var r = el('div', 'donate-row');
    r.id = 'addr-' + a.id;
    var info = el('div', 'donate-info');
    var head = el('div', 'donate-head');
    head.appendChild(el('strong', null, a.name));
    head.appendChild(el('span', 'donate-ticker', a.ticker));
    info.appendChild(head);
    var code = el('code', 'donate-addr', a.address);
    info.appendChild(code);
    var tools = el('div', 'donate-tools');
    var btn = el('button', 'btn donate-copy', 'Copy');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Copy ' + a.name + ' address');
    btn.addEventListener('click', function () { copy(a.address, btn); });
    var qbtn = el('button', 'btn donate-qr-btn', 'QR code');
    qbtn.type = 'button';
    qbtn.setAttribute('aria-expanded', 'false');
    tools.appendChild(btn);
    tools.appendChild(qbtn);
    info.appendChild(tools);
    r.appendChild(info);
    var q = el('div', 'donate-qr');
    q.hidden = true;
    q.setAttribute('role', 'img');
    q.setAttribute('aria-label', 'QR code for the ' + a.name + ' address');
    qbtn.addEventListener('click', function () {
      if (!q.firstChild) q.innerHTML = qrSvg(a.address);
      q.hidden = !q.hidden;
      qbtn.setAttribute('aria-expanded', String(!q.hidden));
    });
    r.appendChild(q);
    return r;
  }

  fetch('addresses.json', { cache: 'no-cache', credentials: 'omit' })
    .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function (data) {
      list.textContent = '';
      (data.addresses || []).forEach(function (a) { list.appendChild(row(a)); });
      window.SHEAR_DONATE_ADDRESSES = data.addresses || [];
      document.dispatchEvent(new CustomEvent('donate:addresses'));
    })
    .catch(function (e) {
      list.textContent = 'Could not load the address list (' + e.message + '). Please reload the page.';
    });
})();
