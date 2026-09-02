(function () {
  var KEY = 'shear-theme';
  function onShearHost() {
    return /(^|\.)shear\.digital$/.test(location.hostname || '');
  }
  function cookieGet() {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf(KEY + '=') === 0) {
        var v = decodeURIComponent(p.slice(KEY.length + 1));
        if (v === 'dark' || v === 'light') return v;
      }
    }
    return '';
  }
  function cookieSet(t) {
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
    try { localStorage.setItem(KEY, t); } catch (e) {}
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
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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
    document.documentElement.dispatchEvent(new CustomEvent('shear-theme', { detail: t }));
  }
  apply(mode());
  function syncBannerH() {
    var header = document.querySelector('.top-banner');
    if (!header) return;
    var h = Math.ceil(header.getBoundingClientRect().height) || 52;
    document.documentElement.style.setProperty('--shear-banner-h', h + 'px');
  }
  function setNav(open) {
    var header = document.querySelector('.top-banner');
    var btn = document.getElementById('nav-toggle');
    if (!header) return;
    header.classList.toggle('nav-open', open);
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? 'Close' : 'Menu';
    }
    syncBannerH();
  }
  window.toggleShearNav = function () {
    var header = document.querySelector('.top-banner');
    setNav(!(header && header.classList.contains('nav-open')));
  };
  syncBannerH();
  window.addEventListener('resize', syncBannerH);
  var OSADMIN_KEY = 'shear_osadmin';
  function cookieRead(name) {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf(name + '=') === 0) {
        try { return decodeURIComponent(p.slice(name.length + 1)); } catch (e) { return p.slice(name.length + 1); }
      }
    }
    return '';
  }
  window.flagShearOsadmin = function (on) {
    var bits;
    if (on) {
      bits = OSADMIN_KEY + '=' + encodeURIComponent(location.origin) + '; Path=/; Max-Age=43200; SameSite=Lax';
    } else {
      bits = OSADMIN_KEY + '=; Path=/; Max-Age=0; SameSite=Lax';
    }
    if (onShearHost()) bits += '; Domain=.shear.digital';
    if (location.protocol === 'https:') bits += '; Secure';
    document.cookie = bits;
    window.paintShearOsadmin();
  };
  window.paintShearOsadmin = function () {
    var nav = document.getElementById('shear-nav');
    if (!nav) return;
    var origin = cookieRead(OSADMIN_KEY).replace(/\/$/, '');
    var el = document.getElementById('nav-osadmin');
    if (!origin) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    if (!el) {
      el = document.createElement('a');
      el.id = 'nav-osadmin';
      el.className = 'nav-btn';
      el.textContent = 'OSadmin';
      nav.appendChild(el);
      el.addEventListener('click', function () { setNav(false); });
    }
    el.href = origin + '/';
    var here = String(location.origin || '').replace(/\/$/, '');
    if (here === origin) el.classList.add('is-on');
    else el.classList.remove('is-on');
  };
  function bindNav() {
    var nav = document.getElementById('shear-nav');
    if (nav) {
      nav.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function () { setNav(false); });
      });
    }
    window.addEventListener('resize', function () {
      if (window.innerWidth > 1024) setNav(false);
    });
    window.paintShearOsadmin();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      apply(mode());
      bindNav();
    });
  } else {
    bindNav();
  }
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  function onScheme() {
    if (cookieGet() || storeGet()) return;
    apply(mode());
  }
  if (mq.addEventListener) mq.addEventListener('change', onScheme);
  else if (mq.addListener) mq.addListener(onScheme);
  window.toggleShearTheme = function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    storeSet(next);
    cookieSet(next);
    apply(next);
  };
})();
