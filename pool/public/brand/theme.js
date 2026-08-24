(function () {
  var KEY = 'shear-theme';
  function mode() {
    var saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    var img = document.getElementById('shear-wordmark');
    if (img) {
      var src = t === 'dark' ? img.getAttribute('data-dark') : img.getAttribute('data-light');
      if (src) img.setAttribute('src', src);
    }
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = t === 'dark' ? 'Light' : 'Dark';
  }
  apply(mode());
  window.toggleShearTheme = function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    apply(next);
  };
})();
