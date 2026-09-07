(function () {
  var treeEl = document.getElementById('docs-tree');
  var readEl = document.getElementById('docs-read');
  var searchEl = document.getElementById('tree-search');
  var data = window.SHEAR_DOCS;
  if (!treeEl || !readEl || !data) return;

  var openFolders = Object.create(null);

  function pageId() {
    var h = (location.hash || '#/overview').replace(/^#\/?/, '');
    return data.pages[h] ? h : 'overview';
  }

  function folderHasPage(folder, id) {
    return folder.children.some(function (c) { return c.id === id; });
  }

  function folderOpen(folder, q) {
    if (q) return true;
    if (Object.prototype.hasOwnProperty.call(openFolders, folder.title)) {
      return !!openFolders[folder.title];
    }
    return folderHasPage(folder, pageId());
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
      var open = folderOpen(folder, q);
      html += '<details class="tree-folder" data-folder="' + folder.title + '"' + (open ? ' open' : '') + '>';
      html += '<summary>' + folder.title + '</summary><div class="tree-kids">';
      kids.forEach(function (c) {
        html += '<a href="#/' + c.id + '" data-id="' + c.id + '">' + c.title + '</a>';
      });
      html += '</div></details>';
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
    treeEl.querySelectorAll('details.tree-folder').forEach(function (d) {
      var name = d.getAttribute('data-folder');
      var folder = data.tree.filter(function (f) { return f.title === name; })[0];
      if (folder && folderHasPage(folder, id) && openFolders[name] !== false) {
        d.open = true;
        openFolders[name] = true;
      }
    });
    document.title = page.title + ' · Shear documentation';
  }

  treeEl.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (!d || d.tagName !== 'DETAILS' || !d.getAttribute('data-folder')) return;
    openFolders[d.getAttribute('data-folder')] = d.open;
  }, true);

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
