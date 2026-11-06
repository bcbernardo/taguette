#!/usr/bin/env node
/*
 * Runs segSelfTest() (taguette/static/js/segments.js) under Node. suggest.js
 * and segments.js are loaded into one vm context with the browser globals they
 * touch at load time stubbed. Exit code = number of failures.
 *
 *   node scripts/segments_selftest.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'taguette', 'static', 'js');

const store = {};
const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Promise: Promise,
  gettext: function(m, args) {
    return args ? m.replace(/%\((\w+)\)s/g, (x, k) => (k in args ? args[k] : x)) : m;
  },
  taguConfigRegisterTab: function() {},
  loadDocument: function() { return Promise.resolve(); },
  loadTag: function() {},
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
};
sandbox.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};
sandbox.window = sandbox;
sandbox.window.location = {search: ''};
sandbox.window.addEventListener = () => {};
vm.createContext(sandbox);

for(const f of ['suggest.js', 'segments.js']) {
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, f), 'utf8'), sandbox, {filename: f});
}

vm.runInContext('segSelfTest()', sandbox).then(
  (failures) => process.exit(failures),
  (err) => { console.error(err); process.exit(1); });
