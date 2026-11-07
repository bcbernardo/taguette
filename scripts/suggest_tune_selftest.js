#!/usr/bin/env node
/*
 * Runs sugTuneSelfTest() (taguette/static/js/suggest.js) under Node: the
 * metrics, AUC, best-F1 pick, combinations and the slider selection used by
 * the highlight tuning.
 *
 *   node scripts/suggest_tune_selftest.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'taguette', 'static', 'js');
const dummy = {textContent: '', style: {}, value: '', checked: false,
               addEventListener: () => {}};
const sandbox = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  Promise: Promise,
  gettext: (m, args) => (args ? m.replace(/%\((\w+)\)s/g, (x, k) => (k in args ? args[k] : x)) : m),
  taguConfigRegisterTab: () => {}, loadDocument: () => Promise.resolve(),
  loadTag: () => {},
  localStorage: {getItem: () => null, setItem: () => {}, removeItem: () => {}},
};
sandbox.document = {
  getElementById: () => dummy, querySelector: () => null,
  querySelectorAll: () => [], addEventListener: () => {},
};
sandbox.window = sandbox;
sandbox.window.location = {search: ''};
sandbox.window.addEventListener = () => {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'suggest.js'), 'utf8'), sandbox,
                {filename: 'suggest.js'});
const failures = vm.runInContext('sugTuneSelfTest()', sandbox);
process.exit(failures ? 1 : 0);
