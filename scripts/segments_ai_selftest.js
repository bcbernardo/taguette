#!/usr/bin/env node
/*
 * Runs segAiSelfTest() (taguette/static/js/segments-ai.js) under Node.
 * The browser files are loaded into one vm context with the few browser
 * globals they touch at load time stubbed. Exit code = number of failures.
 *
 *   node scripts/segments_ai_selftest.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'taguette', 'static', 'js');

function fakeElement() {
  return new Proxy(function() {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : fakeElement()),
    apply: () => fakeElement(),
    set: () => true,
  });
}

const store = {};
const documentStub = {
  cookie: '',
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  body: fakeElement(),
};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, URLSearchParams, FormData: global.FormData, Blob: global.Blob,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  document: documentStub,
  location: {search: '', pathname: '/', href: 'http://localhost/'},
  gettext: (m, args) => (args
    ? m.replace(/%\((\w+)\)s/g, (_, n) => args[n]) : m),
  // taguette.js helpers the module relies on (taguette.js itself needs a DOM)
  encodeGetParams: (p) => Object.keys(p)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(p[k]))
    .join('&'),
  getCookie: (name) => {
    const r = documentStub.cookie.match('\\b' + name + '=([^;]*)\\b');
    return r ? r[1] : undefined;
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {};
vm.createContext(sandbox);

function load(name, optional) {
  const file = path.join(JS_DIR, name);
  if(!fs.existsSync(file)) {
    if(optional) { return; }
    throw new Error('missing ' + file);
  }
  try {
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, {filename: file});
  } catch(e) {
    if(!optional) { throw e; }
    console.warn('(skipping optional ' + name + ': ' + e.message + ')');
  }
}

load('config.js');
load('suggest.js');
load('tags-ai.js');
load('segments.js', true);   // optional: segGuidePrompt/segParseGuide tests
load('segments-ai.js');

vm.runInContext('segAiSelfTest()', sandbox).then(
  (failures) => { process.exit(failures ? 1 : 0); },
  (err) => { console.error(err); process.exit(1); }
);
