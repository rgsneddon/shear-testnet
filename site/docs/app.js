(function () {
  var treeEl = document.getElementById('docs-tree');
  var readEl = document.getElementById('docs-read');
  var searchEl = document.getElementById('tree-search');
  var data = window.SHEAR_DOCS;
  if (!treeEl || !readEl || !data) return;

  function pageId() {
    var h = (location.hash || '#/overview').replace(/^#\/?/, '');
    return data.pages[h] ? h : 'overview';
  }

  function renderTree(filter) {
    var q = String(filter || '').toLowerCase().trim();
    var html = '';
    data.tree.forEach(function (folder) {
      var kids = folder.children.filter(function (c) {
        if (!q) return true;
        return (c.title + ' ' + folder.title + ' ' + c.id).toLowerCase().indexOf(q) >= 0;
      });
      if (!kids.length && q) return;
      html += '<details open><summary>' + folder.title + '</summary>';
      kids.forEach(function (c) {
        html += '<a href="#/' + c.id + '" data-id="' + c.id + '">' + c.title + '</a>';
      });
      html += '</details>';
    });
    treeEl.innerHTML = html;
  }

  function paint() {
    var id = pageId();
    var page = data.pages[id] || data.pages.overview;
    readEl.innerHTML = '<p class="crumb">docs / ' + page.crumb + '</p><h1>' + page.title + '</h1>' + page.html;
    treeEl.querySelectorAll('a').forEach(function (a) {
      a.classList.toggle('is-on', a.getAttribute('data-id') === id);
    });
    document.title = page.title + ' · Shear documentation';
  }

  renderTree('');
  paint();
  window.addEventListener('hashchange', paint);
  if (searchEl) {
    searchEl.addEventListener('input', function () {
      renderTree(searchEl.value);
      paint();
    });
  }
})();
