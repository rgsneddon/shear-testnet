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
  function setNav(open) {
    var header = document.querySelector('.top-banner');
    var btn = document.getElementById('nav-toggle');
    if (!header) return;
    header.classList.toggle('nav-open', open);
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? 'Close' : 'Menu';
    }
  }
  window.toggleShearNav = function () {
    var header = document.querySelector('.top-banner');
    setNav(!(header && header.classList.contains('nav-open')));
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
