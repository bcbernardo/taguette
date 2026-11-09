#!/usr/bin/env node
/*
 * Checks the segment-based ('segmented') integration in suggest.js under Node:
 * async run in sugComputePane with stale-result guarding, slider -> (tau,
 * theta), extra-field preservation, staged tags from the ticked ones.
 *
 *   node scripts/suggest_segmented_selftest.js
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

let failures = 0;
function assert(c, m) { if(!c) { console.error('FAIL:', m); ++failures; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const text = 'x'.repeat(200);
const boc = []; for(let i = 0; i <= 200; ++i) { boc.push(i); }
sandbox.boc = boc; sandbox.text = text;

vm.runInContext(`
  var calls = {analyze: [], refresh: [], render: 0};
  var analyzeDelay = 30;
  var segAnalyzeDocument = function(o) {
    calls.analyze.push(o);
    return new Promise(function(r) { setTimeout(function() { r({id: 'res'}); }, analyzeDelay); });
  };
  var segRefreshUnits = function(o) { calls.refresh.push(o); return Promise.resolve({id: 'res2'}); };
  var segUnitsAsCandidates = function(res, theta) {
    return [
      {start: 0, end: 50, raw: 0.9, section_id: 's1', tags: [{id: 1, name: 'A', conf: 0.9}, {id: 99, name: 'Gone', conf: 0.8}], ticked: [1, 99]},
      {start: 60, end: 120, raw: 0.5, section_id: 's2', tags: [{id: 2, name: 'B', conf: 0.5}], ticked: []},
    ];
  };
  var tags = {'1': {id: 1, path: 'A'}, '2': {id: 2, path: 'B'}};
  var current_document = 7;
  sugRenderPane = function() {}; sugRemoveSuggestionDom = function() {};
  sugRenderStaged = function() {}; sugUpdateCounts = function() {}; sugHideMenu = function() {};
  function mkSession() {
    return {active: true, split: false, aggressiveness: 100, transcription: false,
      expand: false, rankMode: 'lexical', useEmbeddings: false, plainText: text,
      byteOfChar: boc, totalBytes: 200, sentences: [],
      panes: {'': {algo: 'segmented', candidates: null, suggestions: [], clusterLabels: {}}},
      staged: [], nextSid: 0, nextAid: 0, speakers: [], turns: [], editGen: 0};
  }
  sug_session = mkSession();
`, sandbox);

async function main() {
  const run = (code) => vm.runInContext(code, sandbox);

  // merge keeps extras of the higher-raw candidate
  const m = run(`sugMergeOverlaps([{start:0,end:10,raw:.2,lexPct:.1,cStart:0,cEnd:10,section_id:'a',tags:[1]},
     {start:5,end:15,raw:.8,lexPct:.5,cStart:5,cEnd:15,section_id:'b',tags:[2]}])`);
  assert(m.length === 1 && m[0].section_id === 'b' && m[0].end === 15 && m[0].cStart === 0, 'merge extras');

  // async run
  run("sugComputePane('')");
  assert(run('sug_session.panes[""].candidates') === null, 'no candidates while running');
  assert(run('document.getElementById("x").textContent') !== undefined, 'status stub');
  await sleep(80);
  let sugs = run("sug_session.panes[''].suggestions");
  assert(sugs.length === 2, 'two suggestions after async run: ' + sugs.length);
  assert(sugs[0].section_id === 's1' && sugs[0].tags.length === 2 && sugs[0].ticked.length === 2,
         'extras copied into suggestion objects');
  assert(run('calls.analyze.length') === 1 && run('calls.analyze[0].tau') === undefined, 'analyze without slider params');
  assert(run("sug_session.panes[''].candidates[1].start") === 60, 'byte offsets');
  assert(run("document.getElementById('x').textContent") !== '', 'status set');

  // slider is a display filter: no re-analysis, no refresh, fewer shown at low values
  run(`sug_session.aggressiveness = 0; sugSliderSettled()`);
  assert(run('calls.refresh.length') === 0 && run('calls.analyze.length') === 1, 'slider does not re-run units');
  assert(run("sug_session.panes[''].suggestions.length") === 1, 'low slider drops the weaker unit');
  assert(run("sug_session.panes[''].suggestions[0].section_id") === 's1', 'strongest unit kept');
  run(`sug_session.aggressiveness = 100; sugSliderSettled()`);
  assert(run("sug_session.panes[''].suggestions.length") === 2, 'slider 100 shows every unit');
  assert(run("document.getElementById('x').textContent") !== undefined, 'status ok');
  assert(run("sug_session.panes[''].suggestions[0].lexPct") > run("sug_session.panes[''].suggestions[1].lexPct"), 'stronger unit has higher pct (darker)');

  // stale result ignored: algo switched while running
  run(`sug_session = mkSession(); SUG_ALGO_CACHE = {}; SUG_SEG_VERSION++; calls.analyze = [];`);
  run("sugComputePane('')");
  run("sug_session.panes[''].algo = 'textrank'; sug_session.panes[''].runToken++");
  await sleep(80);
  assert(run("sug_session.panes[''].candidates") === null, 'stale (algo switch) ignored');

  // stale: editGen bumped
  run(`sug_session = mkSession(); SUG_ALGO_CACHE = {}; SUG_SEG_VERSION++;`);
  run("sugComputePane('')");
  run('sug_session.editGen++');
  await sleep(80);
  assert(run("sug_session.panes[''].candidates") === null, 'stale (edit) ignored');

  // rejection -> message in status, empty pane
  run(`sug_session = mkSession(); SUG_ALGO_CACHE = {}; SUG_SEG_VERSION++;
       segAnalyzeDocument = function() { return Promise.reject(new Error('no embedding model')); };`);
  run("sugComputePane('')");
  await sleep(20);
  assert(run("document.getElementById('x').textContent") === 'no embedding model', 'error shown');
  assert(run("sug_session.panes[''].suggestions.length") === 0, 'pane empty on error');

  // accept -> staged.tags from ticked, deleted tag skipped
  run(`segAnalyzeDocument = function(o) { return Promise.resolve({}); };
       sug_session = mkSession(); SUG_ALGO_CACHE = {}; SUG_SEG_VERSION++; sugComputePane('')`);
  await sleep(20);
  run(`var sid0 = sug_session.panes[''].suggestions[0].sid; sug_session.panes[''].suggestions[0].ticked = [1, 99]; sugAccept(sid0)`);
  const st = run('sug_session.staged[0]');
  assert(st.tags.length === 1 && st.tags[0] === 1, 'staged.tags from ticked, unknown skipped: ' + st.tags);
  assert(st.suggestedTags.length === 1 && st.section_id === 's1', 'suggestedTags kept');

  // cache key follows segResultKey(): new guide / speakers / params -> new key
  run(`var segKeyValue = 'k1'; var segResultKey = function() { return segKeyValue; };`);
  const k1 = run('sugSegCacheKey()');
  run("segKeyValue = 'k2'");
  assert(k1 !== run('sugSegCacheKey()') && k1.indexOf('k1') !== -1, 'cache key includes segResultKey');

  // stale sugSegCandidates: an older request never writes sess.segResult
  run(`sug_session = mkSession(); SUG_ALGO_CACHE = {};
       var slow = [];
       segAnalyzeDocument = function(o) {
         return new Promise(function(r) { slow.push(r); });
       };
       var pA = sugSegCandidates();
       sug_session.editGen++; var pB = sugSegCandidates();`);
  run("slow[1]({id: 'B'}); slow[0]({id: 'A'});");
  const outs = await Promise.all([run('pA'), run('pB')]);
  assert(outs[0] === null && outs[1] && outs[1].cands.length === 2, 'older candidates request dropped');
  assert(run('sug_session.segResult.id') === 'B', 'segResult is the newest');
  run(`segAnalyzeDocument = function() {
         var e = new Error('stale'); e.stale = true; return Promise.reject(e);
       };
       sug_session = mkSession();`);
  assert((await run('sugSegCandidates()')) === null, 'stale rejection resolves to null');

  // staged highlights do not come back as suggestions (>= 50% overlap), any algorithm
  run(`sug_session = mkSession(); SUG_ALGO_CACHE = {}; sug_session.panes[''].algo = 'textrank';
       sug_session.panes[''].candidates = [
         {start: 0, end: 10, cStart: 0, cEnd: 10, raw: 1, lexPct: 1},
         {start: 20, end: 30, cStart: 20, cEnd: 30, raw: 1, lexPct: 1},
         {start: 40, end: 50, cStart: 40, cEnd: 50, raw: 1, lexPct: 1}];
       sug_session.aggressiveness = 100;
       sug_session.staged = [{aid: 1, start: 0, end: 10}, {aid: 2, start: 25, end: 30}, {aid: 3, start: 48, end: 60}];
       sugRefilterPane('');`);
  const starts = run("sug_session.panes[''].suggestions.map(function(x) { return x.start; })");
  assert(JSON.stringify(starts) === '[40]', 'staged-overlap filter (>= 50% dropped, 20% kept) got ' + JSON.stringify(starts));

  // sugSaveStaged: saved items leave the staged list, failed ones stay
  run(`sug_session = mkSession();
       var project_id = 1, posted = [], alerts = [], recorded = [], doneCalls = 0;
       var showSpinner = function() {}, hideSpinner = function() {};
       var alert = function(m) { alerts.push(m); };
       sugRemoveStagedDom = function() {}; var failAt = {20: true};
       var postJSON = function(url, body) {
         posted.push(body.start_offset);
         return failAt[body.start_offset] ? Promise.reject(new Error('boom')) : Promise.resolve({});
       };
       var segRecordSaved = function(list) { recorded.push(list.map(function(x) { return x.start; })); return Promise.resolve(); };
       sug_session.staged = [{aid: 1, start: 0, end: 10, tags: [1]}, {aid: 2, start: 20, end: 30, tags: []},
                             {aid: 3, start: 40, end: 50, tags: []}];
       sugSaveStaged(function() { doneCalls++; });`);
  await sleep(30);
  assert(JSON.stringify(run('posted')) === '[0,20,40]', 'all posted once');
  assert(JSON.stringify(run('sug_session.staged.map(function(x) { return x.aid; })')) === '[2]', 'only the failed item stays staged');
  assert(JSON.stringify(run('recorded')) === '[[0,40]]', 'segRecordSaved gets only the saved items');
  assert(run('doneCalls') === 0 && run('alerts.length') === 1, 'failure: alert, session kept, done not called');
  run(`failAt = {}; posted = []; sugSaveStaged(function() { doneCalls++; });`);
  await sleep(30);
  assert(JSON.stringify(run('posted')) === '[20]', 'second save posts only what is left');
  assert(run('sug_session.staged.length') === 0 && run('doneCalls') === 1, 'success: staged empty, done called');
  run(`posted = []; sugSaveStaged(function() { doneCalls++; });`);
  assert(run('posted.length') === 0 && run('doneCalls') === 2, 'nothing staged: done directly, no posts');

  // speaker labels: label ends
  const le = (t, o) => run(`sugTurnLabelEnd(${JSON.stringify(Object.assign({start: 10, end: 10 + t.length, text: t}, o || {}))})`) - 10;
  assert(le('0:57 - Huw Evans: Wonderful.') === 'Wonderful.'.length ? false : le('0:57 - Huw Evans: Wonderful.') === '0:57 - Huw Evans: '.length, 'timed inline label: ' + le('0:57 - Huw Evans: Wonderful.'));
  assert(le('1:02:03 - Huw Evans (kayaguides.com): Hello there') === '1:02:03 - Huw Evans (kayaguides.com): '.length, 'timed + affiliation');
  assert(le('John: so I went there') === 'John: '.length, 'plain Name:');
  assert(le('[00:12] Maria Silva: ok then') === '[00:12] Maria Silva: '.length, 'bracketed ts');
  assert(le('Well, that is what I think: maybe') === 0, 'sentence is not a label');
  assert(le('We went home and then slept') === 0, 'unlabelled turn');
  assert(le('Interviewer:\nHow did it go?', {contentStart: 10 + 13}) === 13, 'prefix line');
  assert(le('Interviewer:') === 'Interviewer:'.length, 'lone prefix line spans the turn');
  // trim / split
  const txt = 'Alpha beta gamma. John: delta epsilon zeta eta. Mary: theta iota kappa lambda mu.';
  const lab = (w) => { const i = txt.indexOf(w); return {s: i, e: i + w.length + 1}; };
  const ranges = JSON.stringify([lab('John:'), lab('Mary:')]);
  const trim = (cs) => run(`sugTrimToSpeech(${JSON.stringify(cs)}, ${ranges}, ${JSON.stringify(txt)})`).map((c) => txt.slice(c.start, c.end));
  assert(JSON.stringify(trim([{start: 0, end: txt.length, raw: 1, tags: [{id: 1}]}])) ===
         JSON.stringify(['Alpha beta gamma.', 'delta epsilon zeta eta.', 'theta iota kappa lambda mu.']), 'split at both labels');
  assert(JSON.stringify(trim([{start: txt.indexOf('John:'), end: txt.indexOf('Mary:') - 1}])) === JSON.stringify(['delta epsilon zeta eta.']), 'start moved to label end');
  assert(JSON.stringify(trim([{start: 0, end: txt.indexOf('John:') + 3}])) === JSON.stringify(['Alpha beta gamma.']), 'end moved back before label');
  assert(trim([{start: txt.indexOf('John:'), end: txt.indexOf('John:') + 4}]).length === 0, 'candidate inside label dropped');
  assert(trim([{start: 0, end: 5}]).length === 1 && run(`sugTrimToSpeech([{start:0,end:5}], [], 'x')`).length === 1, 'untouched without overlap');
  const pieces = run(`sugTrimToSpeech([{start: 0, end: ${txt.length}, raw: 0.7, tags: [{id: 1}], ticked: [1]}], ${ranges}, ${JSON.stringify(txt)})`);
  assert(pieces.every((p) => p.raw === 0.7 && p.tags[0].id === 1 && p.ticked[0] === 1), 'pieces keep fields');
  // finish step uses sug_session.turns
  run(`sug_session = mkSession(); sug_session.plainText = ${JSON.stringify(txt)};
       sug_session.byteOfChar = []; for(var bi = 0; bi <= ${txt.length}; ++bi) { sug_session.byteOfChar.push(bi); }
       sug_session.turns = [{start: 0, end: 17, text: ${JSON.stringify(txt.slice(0, 17))}},
         {start: ${txt.indexOf('John:')}, end: ${txt.indexOf('Mary:') - 1}, text: ${JSON.stringify(txt.slice(txt.indexOf('John:'), txt.indexOf('Mary:') - 1))}},
         {start: ${txt.indexOf('Mary:')}, end: ${txt.length}, text: ${JSON.stringify(txt.slice(txt.indexOf('Mary:')))}}];`);
  const fin = run(`sugFinishCandidates([{start: 0, end: ${txt.length}, raw: 1}], sug_session.plainText, sug_session.byteOfChar)`);
  assert(fin.length === 3, 'finish step splits at labels: ' + fin.length);

  // suggested-tags filter: below band_low hidden unless pre-ticked
  const shown = run(`sugSegShownTags([{id: 1, conf: 0.9}, {id: 2, conf: 0.2}, {id: 3, conf: 0.1}], [3])`).map((t) => t.id);
  assert(JSON.stringify(shown) === '[1,3]', 'weak tags hidden: ' + shown);
  assert(run(`sugSegShownTags([{id: 2, conf: 0.2}], [])`).length === 0, 'no tag reaches band_low');

  console.log(failures ? 'SUGGEST SEGMENTED: ' + failures + ' failure(s)' : 'SUGGEST SEGMENTED SELFTEST OK');
  process.exit(failures);
}
main().catch((e) => { console.error(e); process.exit(1); });
