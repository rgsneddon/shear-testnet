/* Shear shared product chrome — identical Dark SaaS topbar across all surfaces.
   Prefer mounting into #shear-chrome-root; also replaces .topbar / .top-banner. */
(function (global) {
  'use strict';

  /* Preview (localhost): root-relative. Live (*.shear.digital): absolute product URLs. */
  var LINKS = (function () {
    var h = '';
    try { h = (global.location && global.location.hostname) || ''; } catch (e) {}
    var local = h === '127.0.0.1' || h === 'localhost' || h === '';
    if (local) {
      return [
        { id: 'MAIN', label: 'MAIN', href: '/' },
        { id: 'POOL', label: 'POOL', href: '/pool/' },
        { id: 'EXPLORER', label: 'EXPLORER', href: '/explorer/' },
        { id: 'MEMPOOL', label: 'MEMPOOL', href: '/mempool/' },
        { id: 'DAG', label: 'DAG', href: 'https://dag.shear.digital/' },
        { id: 'MINER', label: 'MINER', href: '/miner/' },
        { id: 'NODE', label: 'NODE', href: '/node/' },
        { id: 'WALLET', label: 'WALLET', href: '/wallet/' },
        { id: 'VORTICES', label: 'VORTICES', href: '/vortices/' },
        { id: 'TEAM', label: 'TEAM', href: 'https://team.shear.digital/' },
        { id: 'DOCS', label: 'DOCS', href: '/docs/' }
      ];
    }
    return [
      { id: 'MAIN', label: 'MAIN', href: 'https://shear.digital/' },
      { id: 'POOL', label: 'POOL', href: 'https://pool.shear.digital/' },
      { id: 'EXPLORER', label: 'EXPLORER', href: 'https://explorer.shear.digital/' },
      { id: 'MEMPOOL', label: 'MEMPOOL', href: 'https://mempool.shear.digital/' },
      { id: 'DAG', label: 'DAG', href: 'https://dag.shear.digital/' },
      { id: 'MINER', label: 'MINER', href: 'https://shear.digital/miner/' },
      { id: 'NODE', label: 'NODE', href: 'https://shear.digital/node/' },
      { id: 'WALLET', label: 'WALLET', href: 'https://shear.digital/wallet/' },
      { id: 'VORTICES', label: 'VORTICES', href: 'https://vortices.shear.digital/' },
      { id: 'TEAM', label: 'TEAM', href: 'https://team.shear.digital/' },
      { id: 'DOCS', label: 'DOCS', href: 'https://shear.digital/docs/' }
    ];
  })();

  function normBase(base) {
    if (!base) return 'brand/';
    return base.slice(-1) === '/' ? base : base + '/';
  }

  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function buildMarkup(opts) {
    var active = String(opts.active || '').toUpperCase();
    var brandBase = normBase(opts.brandBase);
    var darkWm = brandBase + '05d-wordmark-nevia-dark-transparent.png';
    var lightWm = brandBase + '05c-wordmark-nevia-light-transparent.png';
    var mainHref = LINKS[0].href;
    var showPill = opts.testnetPill === true;

    var navHtml = LINKS.map(function (link) {
      var on = link.id === active;
      var cls = 'nav-btn' + (on ? ' is-on active' : '');
      var extra = link.external ? ' target="_blank" rel="noopener"' : '';
      return (
        '<a class="' +
        cls +
        '" href="' +
        escapeAttr(link.href) +
        '"' +
        extra +
        '>' +
        link.label +
        '</a>'
      );
    }).join('\n      ');

    var pillHtml = showPill
      ? '<span class="shear-chrome-pill">Testnet</span>\n      '
      : '';

    return (
      '<header class="top-banner" id="shear-topbar">' +
      '\n  <div class="banner-brand">' +
      '\n    <a href="' +
      escapeAttr(mainHref) +
      '" aria-label="Shear home">' +
      '\n      <img id="shear-wordmark" class="banner-wordmark theme-img-light" alt="Shear"' +
      '\n        src="' +
      escapeAttr(lightWm) +
      '"' +
      '\n        data-light="' +
      escapeAttr(lightWm) +
      '"' +
      '\n        data-dark="' +
      escapeAttr(darkWm) +
      '"/>' +
      '\n      <img class="banner-wordmark theme-img-dark" alt=""' +
      '\n        src="' +
      escapeAttr(darkWm) +
      '"/>' +
      '\n    </a>' +
      '\n  </div>' +
      '\n  <nav class="nav" id="shear-nav" aria-label="Product">' +
      '\n      ' +
      navHtml +
      '\n  </nav>' +
      '\n  <div class="banner-tools">' +
      '\n      ' +
      pillHtml +
      '<button type="button" class="theme-toggle" id="theme-toggle" aria-label="Dark" title="Dark">' +
      '\n        <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/></svg>' +
      '\n        <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></g></svg>' +
      '\n      </button>' +
      '\n      <button type="button" class="nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="shear-nav" aria-label="Open menu" title="Menu"><span class="nav-toggle-bars" aria-hidden="true"></span></button>' +
      '\n  </div>' +
      '\n</header>'
    );
  }

  function ensureThemeApi() {
    if (typeof global.toggleShearTheme === 'function') return;
    var KEY = 'shear-theme';
    function onShearHost() {
      return /(^|\.)shear\.digital$/.test(location.hostname || '');
    }
    function cookieGet() {
      var found = '';
      var parts = String(document.cookie || '').split(';');
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim();
        if (p.indexOf(KEY + '=') !== 0) continue;
        try {
          var v = decodeURIComponent(p.slice(KEY.length + 1));
          if (v === 'dark' || v === 'light') found = v;
        } catch (e) {}
      }
      return found;
    }
    function cookieSet(t) {
      var clear = KEY + '=; Path=/; Max-Age=0; SameSite=Lax';
      document.cookie = clear;
      if (location.protocol === 'https:') document.cookie = clear + '; Secure';
      var bits = KEY + '=' + encodeURIComponent(t) + '; Path=/; Max-Age=31536000; SameSite=Lax';
      if (onShearHost()) bits += '; Domain=.shear.digital';
      if (location.protocol === 'https:') bits += '; Secure';
      document.cookie = bits;
    }
    function storeGet() {
      try {
        var v = localStorage.getItem(KEY);
        if (v === 'dark' || v === 'light') return v;
      } catch (e) {}
      return '';
    }
    function storeSet(t) {
      try {
        localStorage.setItem(KEY, t);
      } catch (e) {}
    }
    function saved() {
      var fromCookie = cookieGet();
      if (fromCookie) {
        storeSet(fromCookie);
        return fromCookie;
      }
      var fromStore = storeGet();
      if (fromStore) {
        cookieSet(fromStore);
        return fromStore;
      }
      return '';
    }
    function mode() {
      var s = saved();
      if (s) return s;
      try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch (e) {
        return 'dark';
      }
    }
    function apply(t) {
      document.documentElement.setAttribute('data-theme', t);
      document.querySelectorAll('img[data-light][data-dark]').forEach(function (img) {
        var src = t === 'dark' ? img.getAttribute('data-dark') : img.getAttribute('data-light');
        if (src) img.setAttribute('src', src);
      });
      var btn = document.getElementById('theme-toggle');
      if (btn) {
        var label = t === 'dark' ? 'Light' : 'Dark';
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
      }
    }
    /* Always prefer stored preference over hardcoded data-theme on <html>. */
    apply(mode());
    global.toggleShearTheme = function () {
      var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      var next = cur === 'dark' ? 'light' : 'dark';
      storeSet(next);
      cookieSet(next);
      apply(next);
    };
  }

  function setNav(open) {
    var header = document.querySelector('.top-banner');
    var btn = document.getElementById('nav-toggle');
    if (!header) return;
    header.classList.toggle('nav-open', !!open);
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      btn.setAttribute('title', open ? 'Close' : 'Menu');
    }
  }

  function wireChrome() {
    ensureThemeApi();
    if (typeof global.toggleShearNav !== 'function') {
      global.toggleShearNav = function () {
        var header = document.querySelector('.top-banner');
        setNav(!(header && header.classList.contains('nav-open')));
      };
    }
    var themeBtn = document.getElementById('theme-toggle');
    if (themeBtn && !themeBtn.getAttribute('data-shear-bound')) {
      themeBtn.setAttribute('data-shear-bound', '1');
      themeBtn.addEventListener('click', function () {
        if (typeof global.toggleShearTheme === 'function') global.toggleShearTheme();
      });
    }
    var navBtn = document.getElementById('nav-toggle');
    if (navBtn && !navBtn.getAttribute('data-shear-bound')) {
      navBtn.setAttribute('data-shear-bound', '1');
      navBtn.addEventListener('click', function () {
        if (typeof global.toggleShearNav === 'function') global.toggleShearNav();
      });
    }
    var nav = document.getElementById('shear-nav');
    if (nav && !nav.getAttribute('data-shear-bound')) {
      nav.setAttribute('data-shear-bound', '1');
      nav.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function () {
          setNav(false);
        });
      });
    }
    if (!global.__shearChromeResizeBound) {
      global.__shearChromeResizeBound = true;
      window.addEventListener('resize', function () {
        if (window.innerWidth > 1024) setNav(false);
      });
    }
  }

  function findMountTarget() {
    return (
      document.getElementById('shear-chrome-root') ||
      document.querySelector('header.topbar') ||
      document.querySelector('header.top-banner') ||
      document.querySelector('.topbar') ||
      document.querySelector('.top-banner')
    );
  }

  function mount(opts) {
    opts = opts || {};
    var target = findMountTarget();
    if (!target) {
      console.warn('[ShearChrome] no mount target (#shear-chrome-root / .topbar / .top-banner)');
      return null;
    }
    if (!opts.active && target.getAttribute) {
      opts.active = target.getAttribute('data-active') || '';
    }
    if (!opts.brandBase && target.getAttribute) {
      opts.brandBase = target.getAttribute('data-brand-base') || 'brand/';
    }
    if (opts.testnetPill == null && target.getAttribute) {
      var pillAttr = target.getAttribute('data-testnet-pill');
      if (pillAttr === '1' || pillAttr === 'true') opts.testnetPill = true;
    }
    var html = buildMarkup(opts);
    var wrap = document.createElement('div');
    wrap.innerHTML = html.trim();
    var header = wrap.firstChild;
    if (target.id === 'shear-chrome-root' || target.classList.contains('shear-chrome-root')) {
      target.innerHTML = '';
      target.appendChild(header);
    } else {
      target.parentNode.replaceChild(header, target);
    }
    wireChrome();
    return header;
  }

  var api = {
    mount: mount,
    links: LINKS,
    buildMarkup: buildMarkup
  };
  global.ShearChrome = api;

  function autoMount() {
    var root = document.getElementById('shear-chrome-root');
    if (!root) return;
    if (root.querySelector('.top-banner')) return;
    mount({
      active: root.getAttribute('data-active') || '',
      brandBase: root.getAttribute('data-brand-base') || 'brand/',
      testnetPill: root.getAttribute('data-testnet-pill') === '1'
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }
})(typeof window !== 'undefined' ? window : this);
