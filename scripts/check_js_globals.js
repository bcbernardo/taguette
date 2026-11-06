#!/usr/bin/env node
// All front-end scripts share one global scope (no modules, no bundler), so a
// top-level function or var defined in two files silently overrides the one
// loaded first. Fail when that happens.
//   node scripts/check_js_globals.js
'use strict';
var fs = require('fs');
var path = require('path');

var dir = path.join(__dirname, '..', 'taguette', 'static', 'js');
var seen = {};
var dupes = [];
fs.readdirSync(dir).filter(function(f) {
  return /\.js$/.test(f) && !/\.min\.js$/.test(f);
}).forEach(function(file) {
  var src = fs.readFileSync(path.join(dir, file), 'utf8');
  var re = /^(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|var\s+([A-Za-z_$][\w$]*))/gm;
  var names = {};
  var m;
  while((m = re.exec(src)) !== null) {
    names[m[1] || m[2]] = true;
  }
  Object.keys(names).forEach(function(name) {
    if(seen[name]) {
      dupes.push(name + ': ' + seen[name] + ', ' + file);
    } else {
      seen[name] = file;
    }
  });
});
if(dupes.length) {
  console.error('Global names defined in more than one file:\n  '
                + dupes.join('\n  '));
  process.exit(1);
}
console.log('JS GLOBALS OK (' + Object.keys(seen).length + ' names)');
