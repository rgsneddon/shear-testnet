import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Pages with a prerendered navbar (a .top-banner already inside
// #shear-chrome-root) must still get a working burger: autoMount wires the
// chrome (wireChrome) before it returns, without re-rendering, as the live
// shared/shear-chrome.js on shear.digital does:
//   if (root.querySelector('.top-banner')) { wireChrome(); return; } /* static prerendered nav: wire only, no re-render */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = [
  'site/shared/shear-chrome.js',
  'pool/public/shared/shear-chrome.js',
  'explorer/shared/shear-chrome.js',
  'mempool/shared/shear-chrome.js',
  'team/shared/shear-chrome.js',
];

function el(id) {
  const attrs = {}; const listeners = {}; const classes = new Set();
  return {
    id, attrs, listeners,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    click() { for (const fn of listeners.click || []) fn({ type: 'click' }); },
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; v ? classes.add(c) : classes.delete(c); return v; },
    },
    querySelectorAll: () => [],
  };
}

function prerenderedPage() {
  const header = el('shear-topbar');
  const navToggle = el('nav-toggle'); navToggle.attrs['aria-expanded'] = 'false';
  const themeToggle = el('theme-toggle');
  const nav = el('shear-nav');
  const links = [el(''), el('')];
  nav.querySelectorAll = () => links;
  const chromeRoot = el('shear-chrome-root');
  chromeRoot.attrs['data-active'] = 'MAIN';
  chromeRoot.querySelector = (sel) => (sel === '.top-banner' ? header : null);
  let created = 0;
  const byId = { 'shear-chrome-root': chromeRoot, 'nav-toggle': navToggle, 'theme-toggle': themeToggle, 'shear-nav': nav };
  const document = {
    readyState: 'complete', cookie: '',
    documentElement: el('html'),
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => (sel === '.top-banner' || sel === 'header.top-banner' ? header : null),
    querySelectorAll: () => [],
    createElement: () => { created++; return el(''); },
    addEventListener: () => {},
  };
  const window = {
    document, location: { hostname: 'shear.digital' }, innerWidth: 390,
    localStorage: { getItem: () => null, setItem: () => {} },
    matchMedia: () => ({ matches: true }),
    addEventListener: () => {},
  };
  window.window = window;
  return { window, header, navToggle, links, created: () => created };
}

describe('shared chrome: burger works on prerendered navbars', () => {
  for (const rel of CHROME) {
    it(`${rel} wires the burger toggle without re-rendering a prerendered navbar`, () => {
      const page = prerenderedPage();
      const ctx = vm.createContext(page.window);
      vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), ctx, { filename: rel });
      assert.equal(page.created(), 0, `${rel}: prerendered navbar was re-rendered`);
      assert.ok((page.navToggle.listeners.click || []).length >= 1, `${rel}: burger has no click handler`);
      page.navToggle.click();
      assert.equal(page.header.classList.contains('nav-open'), true, `${rel}: burger click does not open the menu`);
      assert.equal(page.navToggle.getAttribute('aria-expanded'), 'true');
      page.links[0].click();
      assert.equal(page.header.classList.contains('nav-open'), false, `${rel}: a nav link click does not close the menu`);
    });
  }
});
