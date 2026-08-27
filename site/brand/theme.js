(function () {
  var KEY = 'shear-theme';
  function mode() {
    var saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') return saved;
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
    if (localStorage.getItem(KEY) === 'dark' || localStorage.getItem(KEY) === 'light') return;
    apply(mode());
  }
  if (mq.addEventListener) mq.addEventListener('change', onScheme);
  else if (mq.addListener) mq.addListener(onScheme);
  window.toggleShearTheme = function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    apply(next);
  };
})();
