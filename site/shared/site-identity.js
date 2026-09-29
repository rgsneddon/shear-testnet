/* Shear site identity ? foot line + live network magic binder
   Sources: Date (year), GitHub latest Continuum release (wallet), pool /api/stats magic (network).
   Paints [data-shear-foot] and every [data-shear-network] / [data-shear-network-slug].
   Falls back to shared/pins.json then data-* attrs on [data-shear-foot].
   Future network cuts (v6+): update pool /api/stats only ? pages pick up magic without HTML edits. */
(function (global) {
  'use strict';

  var FALLBACK_WALLET = '0.61';
  var FALLBACK_NET = 'shear-testnet-v6';
  var lastNetwork = FALLBACK_NET;
  var lastWallet = FALLBACK_WALLET;
  var lastYear = '';

  function yearNow() {
    try {
      return String(new Date().getFullYear());
    } catch (e) {
      return '';
    }
  }

  function networkSlug(network) {
    var n = String(network || '').trim();
    if (n.indexOf('shear-') === 0) return n.slice('shear-'.length);
    return n;
  }

  function formatLine(year, wallet, network) {
    return (
      'Shear · ' +
      year +
      ' · Continuum ' +
      wallet +
      ' · ' +
      network
    );
  }

  function paintNetwork(network) {
    if (network) lastNetwork = String(network).trim() || lastNetwork;
    var net = lastNetwork || FALLBACK_NET;
    var slug = networkSlug(net);
    var nodes = document.querySelectorAll('[data-shear-network]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = net;
    }
    var slugs = document.querySelectorAll('[data-shear-network-slug]');
    for (var j = 0; j < slugs.length; j++) {
      slugs[j].textContent = slug;
    }
    return net;
  }

  function paintFoot(year, wallet, network) {
    var line = formatLine(year, wallet, network);
    var nodes = document.querySelectorAll('[data-shear-foot]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = line;
    }
  }

  function paintAll(year, wallet, network) {
    lastYear = year || lastYear || yearNow();
    if (wallet) lastWallet = wallet;
    if (network) lastNetwork = network;
    paintFoot(lastYear, lastWallet, lastNetwork);
    paintNetwork(lastNetwork);
  }

  function scriptDir() {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var src = scripts[i].src || '';
      if (src.indexOf('site-identity.js') !== -1) {
        return src.replace(/[^/]+$/, '');
      }
    }
    for (var j = scripts.length - 1; j >= 0; j--) {
      var s2 = scripts[j].src || '';
      if (s2.indexOf('shear-chrome.js') !== -1) {
        return s2.replace(/[^/]+$/, '');
      }
    }
    return '/shared/';
  }

  function statsUrl() {
    var h = '';
    try {
      h = (global.location && global.location.hostname) || '';
    } catch (e) {}
    if (h === 'shear.digital' || h === 'www.shear.digital') {
      return '/api/stats';
    }
    if (h === 'pool.shear.digital') {
      return '/api/stats';
    }
    if (h && h.indexOf('shear.digital') !== -1) {
      return 'https://pool.shear.digital/api/stats';
    }
    return 'https://pool.shear.digital/api/stats';
  }

  function stripV(tag) {
    tag = String(tag || '').trim();
    if (tag.charAt(0) === 'v' || tag.charAt(0) === 'V') return tag.slice(1);
    return tag;
  }

  function versionParts(tag) {
    return stripV(tag).split('.').map(function (n) {
      var v = parseInt(n, 10);
      return isNaN(v) ? 0 : v;
    });
  }

  /* A GitHub "latest" tag must not paint an older Continuum than the hard pin. */
  function versionAtLeast(tag, floor) {
    var a = versionParts(tag);
    var b = versionParts(floor);
    var n = a.length > b.length ? a.length : b.length;
    for (var i = 0; i < n; i++) {
      var av = a[i] || 0;
      var bv = b[i] || 0;
      if (av > bv) return true;
      if (av < bv) return false;
    }
    return true;
  }

  function fetchJson(url, ops) {
    return fetch(url, ops || { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function loadPins() {
    var url = scriptDir() + 'pins.json';
    return fetchJson(url).catch(function () {
      return fetchJson('/shared/pins.json').catch(function () {
        return {};
      });
    });
  }

  function loadGithubWallet() {
    return fetch(
      'https://api.github.com/repos/rgsneddon/shear-testnet/releases/latest',
      {
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json' }
      }
    )
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        return stripV(j.tag_name || j.name || '');
      });
  }

  function loadNetwork() {
    return fetchJson(statsUrl())
      .then(function (s) {
        return String(s.magic || s.network || '').trim();
      })
      .catch(function () {
        return '';
      });
  }

  function attrFallback(name, def) {
    var el = document.querySelector('[data-shear-foot]');
    if (!el || !el.getAttribute) return def;
    return el.getAttribute(name) || def;
  }

  function boot() {
    var year = yearNow();
    var wallet = attrFallback('data-wallet-fallback', FALLBACK_WALLET);
    var network = attrFallback('data-network-fallback', FALLBACK_NET);
    paintAll(year, wallet, network);

    Promise.all([
      loadPins(),
      loadNetwork(),
      loadGithubWallet().catch(function () {
        return '';
      })
    ]).then(function (parts) {
      var pins = parts[0] || {};
      var netLive = parts[1] || '';
      var ghWallet = parts[2] || '';
      if (ghWallet && versionAtLeast(ghWallet, FALLBACK_WALLET)) wallet = ghWallet;
      else if (pins.wallet_latest_version && versionAtLeast(pins.wallet_latest_version, FALLBACK_WALLET)) {
        wallet = stripV(pins.wallet_latest_version);
      }
      if (netLive) network = netLive;
      else if (pins.active_network_name) network = pins.active_network_name;
      paintAll(year, wallet, network);
    });
  }

  global.ShearSiteIdentity = {
    boot: boot,
    formatLine: formatLine,
    paintNetwork: function (n) {
      return paintNetwork(n || lastNetwork);
    },
    getNetwork: function () {
      return lastNetwork;
    },
    networkSlug: networkSlug,
    loadNetwork: loadNetwork,
    statsUrl: statsUrl,
    FALLBACK_NET: FALLBACK_NET
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : this);
