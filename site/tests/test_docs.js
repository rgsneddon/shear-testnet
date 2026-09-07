import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = fs.readFileSync(path.join(here, '../docs/index.html'), 'utf8');
const content = fs.readFileSync(path.join(here, '../docs/content.js'), 'utf8');
const app = fs.readFileSync(path.join(here, '../docs/app.js'), 'utf8');
const paper = fs.readFileSync(path.join(here, '../whitepaper/index.html'), 'utf8');
const pdf = fs.readFileSync(path.join(here, '../whitepaper/shear-whitepaper.pdf'));

function navLabels(html) {
  const nav = html.match(/id="shear-nav"[\s\S]*?<\/nav>/);
  assert.ok(nav, 'missing shear-nav');
  return [...nav[0].matchAll(/class="nav-btn[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
}

const withDocs = ['MAIN', 'POOL', 'EXPLORER', 'MEMPOOL', 'MINER', 'NODE', 'WALLET', 'DOCS'];

describe('docs.shear.digital', () => {
  it('is a file-tree browser with wallet, mining, vortex, vort1, reserve', () => {
    assert.match(docs, /id="docs-tree"/);
    assert.match(docs, /id="docs-read"/);
    assert.match(docs, /id="tree-search"/);
    assert.match(docs, /File tree/);
    assert.match(content, /id: 'wallet'/);
    assert.match(content, /id: 'mine'/);
    assert.match(content, /id: 'vort1'/);
    assert.match(content, /id: 'creators'/);
    assert.match(content, /id: 'reserve'/);
    assert.match(content, /vort1\./);
    assert.match(content, /ShearK-Miner 1\.5/);
    assert.match(content, /shewall\.bin/);
    assert.match(content, /Continuum/);
    assert.match(app, /hashchange/);
    assert.match(app, /SHEAR_DOCS/);
    assert.match(app, /tree-folder/);
    assert.match(app, /data-folder/);
    assert.match(app, /addEventListener\('toggle'/);
    assert.doesNotMatch(app, /<details open>/);
    assert.match(docs, /details\.tree-folder/);
    assert.match(docs, /summary::before/);
    const labels = navLabels(docs);
    assert.deepEqual(labels, withDocs);
    assert.equal(labels.includes('WHITEPAPER'), false);
    assert.match(docs, /class="nav-btn is-on" href="\/">DOCS</);
  });
});

describe('whitepaper.shear.digital', () => {
  it('presents a Zenodo-style record with a PDF, and has no WHITEPAPER nav button', () => {
    assert.match(paper, /id="zenodo-record"/);
    assert.match(paper, /shear-whitepaper\.pdf/);
    assert.match(paper, /<iframe[^>]+src="shear-whitepaper\.pdf"/);
    assert.match(paper, /Continuity-settled Proof of Work/);
    assert.match(paper, /Publication/);
    assert.match(paper, /Preprint/);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.length > 50_000);
    const labels = navLabels(paper);
    assert.deepEqual(labels, withDocs);
    assert.equal(labels.includes('WHITEPAPER'), false);
    assert.match(paper, /href="https:\/\/docs\.shear\.digital">DOCS</);
    assert.equal(labels[labels.length - 1], 'DOCS');
    assert.equal(labels[labels.length - 2], 'WALLET');
    const src = fs.readFileSync(path.join(here, '../whitepaper/build_pdf.py'), 'utf8');
    assert.doesNotMatch(src, /The Join/);
    assert.doesNotMatch(src, /join1\./);
    assert.equal(pdf.includes(Buffer.from('The Join')), false);
    assert.doesNotMatch(content, /The Join/);
    assert.doesNotMatch(content, /join1\./);
  });
});
