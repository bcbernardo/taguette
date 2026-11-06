#!/usr/bin/env node
/*
 * Offline realism check of the thematic-segments pipeline on a real,
 * hand-coded transcript. Contains no data: fixture paths are CLI arguments.
 *
 *   node scripts/segments_eval_reference.js FIXTURE.json GUIDE.json [--grid]
 *       [--emit global|column|hybrid] [--fake-decide] [--interviewer REGEX] [--interviewee REGEX] [--dim 128] [--bigrams]
 *
 * FIXTURE = {docId, plainText, highlights:[{id,cStart,cEnd,tagIds,text}],
 *            tags:[{id,path,description}]}; GUIDE = server-shaped segments.
 * The embedder is a TF-IDF + LSA (subspace-iteration SVD) stand-in fitted on
 * the document itself; it is much cruder than a neural sentence embedder, so
 * absolute numbers are indicative only.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'taguette', 'static', 'js');
const argv = process.argv.slice(2);
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && /^--(interviewer|interviewee|dim|emit)$/.test(argv[i - 1])));
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
}
if(pos.length < 2 || !opt('interviewer') || !opt('interviewee')) {
  console.error('usage: segments_eval_reference.js FIXTURE.json GUIDE.json '
                + '--interviewer REGEX --interviewee REGEX [--grid]');
  process.exit(2);
}
const fx = JSON.parse(fs.readFileSync(pos[0], 'utf8'));
const guide = JSON.parse(fs.readFileSync(pos[1], 'utf8'));
const DIM = parseInt(opt('dim', '128'), 10);
const BIGRAMS = argv.indexOf('--bigrams') >= 0;
const RE_I = new RegExp(opt('interviewer'), 'i');
const RE_P = new RegExp(opt('interviewee'), 'i');

const store = {};
const sandbox = {
  console, setTimeout, clearTimeout, Promise,
  gettext: (m, args) => (args ? m.replace(/%\((\w+)\)s/g, (x, k) => (k in args ? args[k] : x)) : m),
  taguConfigRegisterTab() {}, loadDocument() { return Promise.resolve(); }, loadTag() {},
  localStorage: {getItem: (k) => (k in store ? store[k] : null),
                 setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }},
};
sandbox.document = {getElementById: () => null, querySelector: () => null,
                    querySelectorAll: () => [], addEventListener() {}};
sandbox.window = sandbox;
sandbox.window.location = {search: ''};
sandbox.window.addEventListener = () => {};
vm.createContext(sandbox);
for(const f of ['suggest.js', 'segments.js']) {
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, f), 'utf8'), sandbox, {filename: f});
}
const S = sandbox;
if(opt('emit', null)) { vm.runInContext('SEG_EMIT_NORM = ' + JSON.stringify(opt('emit')), sandbox); }
const ev = (code) => vm.runInContext(code, sandbox);
const sugTokenize = ev('sugTokenize'), sugIsStop = ev('sugIsStop');
const sugSplitSentences = ev('sugSplitSentences');

/* ---------- TF-IDF + LSA embedder (stand-in for a neural encoder) ---------- */
function terms(text) {
  const w = [];
  for(const t of sugTokenize(text)) {
    if(t.word.length > 2 && !sugIsStop(t.word)) {
      w.push(t.word);
    }
  }
  if(BIGRAMS) {
    const n = w.length;
    for(let i = 0; i + 1 < n; ++i) {
      w.push(w[i] + '_' + w[i + 1]);
    }
  }
  return w;
}
function makeEmbedder(plain, dim) {
  const sents = sugSplitSentences(plain).map((s) => terms(s.text));
  const df = new Map();
  for(const s of sents) {
    for(const t of new Set(s)) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const vocab = new Map();
  for(const [t, c] of df) {
    if(c >= 2) {
      vocab.set(t, vocab.size);
    }
  }
  const V = vocab.size, N = sents.length;
  const idf = new Float64Array(V);
  for(const [t, i] of vocab) {
    idf[i] = Math.log((N + 1) / (df.get(t) + 1)) + 1;
  }
  function sparse(ts) {
    const c = new Map();
    for(const t of ts) {
      const i = vocab.get(t);
      if(i !== undefined) {
        c.set(i, (c.get(i) || 0) + 1);
      }
    }
    const idx = [], val = [];
    let n2 = 0;
    for(const [i, k] of c) {
      const v = (1 + Math.log(k)) * idf[i];
      idx.push(i); val.push(v); n2 += v * v;
    }
    n2 = Math.sqrt(n2) || 1;
    return {idx, val: val.map((v) => v / n2)};
  }
  const X = sents.map(sparse).filter((r) => r.idx.length);
  const l = Math.min(dim, V, X.length);
  // subspace iteration for the top-l right singular space of X (n x V)
  let Q = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  for(let j = 0; j < l; ++j) {
    const q = new Float64Array(V);
    for(let i = 0; i < V; ++i) { q[i] = rnd(); }
    Q.push(q);
  }
  function orth(cols) {
    for(let j = 0; j < cols.length; ++j) {
      for(let k = 0; k < j; ++k) {
        let d = 0;
        for(let i = 0; i < cols[j].length; ++i) { d += cols[j][i] * cols[k][i]; }
        for(let i = 0; i < cols[j].length; ++i) { cols[j][i] -= d * cols[k][i]; }
      }
      let n = 0;
      for(let i = 0; i < cols[j].length; ++i) { n += cols[j][i] * cols[j][i]; }
      n = Math.sqrt(n) || 1;
      for(let i = 0; i < cols[j].length; ++i) { cols[j][i] /= n; }
    }
    return cols;
  }
  Q = orth(Q);
  for(let it = 0; it < 6; ++it) {
    const Z = Q.map((q) => {          // Z_j = X q_j (length n)
      const z = new Float64Array(X.length);
      for(let r = 0; r < X.length; ++r) {
        let s = 0;
        for(let k = 0; k < X[r].idx.length; ++k) { s += X[r].val[k] * q[X[r].idx[k]]; }
        z[r] = s;
      }
      return z;
    });
    orth(Z);
    Q = Z.map((z) => {                // q_j = X^T z_j
      const q = new Float64Array(V);
      for(let r = 0; r < X.length; ++r) {
        for(let k = 0; k < X[r].idx.length; ++k) { q[X[r].idx[k]] += X[r].val[k] * z[r]; }
      }
      return q;
    });
    Q = orth(Q);
  }
  function embedOne(text) {
    const sp = sparse(terms(text));
    const out = new Float32Array(l);
    for(let j = 0; j < l; ++j) {
      let s = 0;
      for(let k = 0; k < sp.idx.length; ++k) { s += sp.val[k] * Q[j][sp.idx[k]]; }
      out[j] = s;
    }
    return out;
  }
  return {V, N, l, embed: (texts) => Promise.resolve(texts.map(embedOne))};
}

/* ---------- inputs ---------- */
const plain = fx.plainText;
const turns = ev('sugTurnsOfText')(plain);
const speakers = [{id: 'I', name: 'Interviewer', include: false},
                  {id: 'P', name: 'Interviewee', include: true}];
turns.forEach((t) => {
  const first = plain.slice(t.start, t.end).split('\n')[0];
  const m = /^\s*(?:\d+:)?\d+:\d+\s*-\s*(.*)$/.exec(first);
  t.speaker = m ? (RE_I.test(m[1]) ? 'I' : (RE_P.test(m[1]) ? 'P' : null)) : null;
});
const hls = fx.highlights;
const uses = {};
hls.forEach((h) => (h.tagIds || []).forEach((t) => { uses[t] = (uses[t] || 0) + 1; }));
const exemplars = hls.map((h) => ({docId: fx.docId, cStart: h.cStart, cEnd: h.cEnd,
                                   tagIds: h.tagIds, text: h.text}));

function mkInput(params, variant) {
  return {
    plainText: plain, turns, speakers, guide, params: S.segParams(params || {}),
    tags: fx.tags, exemplars, docId: fx.docId,
    excludeDocId: variant === 'noex' ? fx.docId : null,
    segPrototypeExtras: null, tagSegmentCooc: null, manual: null,
  };
}

/* Deterministic always-answering decide (--fake-decide): request counts then
   reflect a real service rather than a null stub. Word overlap stands in for
   the model's judgement. */
function contentWords(text) {
  const out = new Set();
  for(const t of sugTokenize(text || '')) {
    if(t.word.length > 2 && !sugIsStop(t.word)) { out.add(t.word); }
  }
  return out;
}
function overlap(a, b) {
  let n = 0;
  for(const w of a) { if(b.has(w)) { ++n; } }
  return n;
}
function fakeDecide(q, state) {
  state = state || '';
  const ans = {};
  const pick = (name, probs) => {
    const best = Object.keys(probs).sort((x, y) => probs[y] - probs[x])[0];
    ans[name] = {choice: best, probabilities: probs};
  };
  for(const name of Object.keys(q)) {
    const crit = q[name].criteria || {};
    if(name === 'continuity') {
      const m = /Passage so far: ([\s\S]*)\n\nNew sentence: ([\s\S]*)$/.exec(state);
      const shared = m ? overlap(contentWords(m[1]), contentWords(m[2])) : 0;
      const pn = shared < 2 ? 0.9 : 0.1;
      pick(name, {new_point: pn, continues: 1 - pn});
    } else if(name === 'content') {
      pick(name, {substantive: 0.95, small_talk: 0.05});
    } else if(/^t\d/.test(name)) {
      const o = overlap(contentWords(crit.applies), contentWords(state));
      const p = Math.min(0.95, 0.1 + 0.2 * o);
      pick(name, {applies: p, does_not_apply: 1 - p});
    } else if(name === 'segment') {
      const sw = contentWords(state);
      const scores = {};
      let tot = 0;
      for(const k of Object.keys(crit)) {
        scores[k] = (k === 'other_topic' ? 0.5 : 1) + overlap(contentWords(crit[k]), sw);
        tot += scores[k];
      }
      const probs = {};
      for(const k of Object.keys(crit)) { probs[k] = scores[k] / tot; }
      pick(name, probs);
    } else {
      const keys = Object.keys(crit);
      const probs = {};
      keys.forEach((k) => { probs[k] = 1 / keys.length; });
      pick(name, probs);
    }
  }
  return Promise.resolve(ans);
}

function counters() {
  const c = {embed: 0, embedTexts: 0, decide: 0, decideQ: 0, byKind: {}, llm: 0};
  const kind = (q) => (q.continuity ? 'continuity'
    : Object.keys(q).some((k) => /^t\d/.test(k)) ? 'unit(smalltalk+tags)'
    : q.content ? 'smalltalk' : 'window');
  return {
    c,
    deps(emb, mode) {
      return {
        embed: (t) => { ++c.embed; c.embedTexts += t.length; return emb.embed(t); },
        decide: (q, state) => {
          ++c.decide;
          const k = kind(q);
          c.byKind[k] = (c.byKind[k] || 0) + 1;
          c.decideQ += Object.keys(q).length;
          if(mode === 'fake') { return fakeDecide(q, state); }
          if(mode === 'uniform') {
            const ans = {};
            for(const name of Object.keys(q)) {
              const crit = q[name].criteria || {};
              const keys = Object.keys(crit);
              ans[name] = {};
              keys.forEach((kk) => { ans[name][kk] = 1 / keys.length; });
            }
            return Promise.resolve(ans);
          }
          return Promise.resolve(null);
        },
        llm: () => { ++c.llm; return Promise.resolve(null); },
      };
    },
  };
}

function pct(a, q) { return S.segQuantile(a, q); }
function timeLabel(text) {
  const m = /(\d+:\d\d(?::\d\d)?)\s*-\s/.exec(text);
  return m ? m[1] : '';
}
function lastStamp(pos) {
  const re = /(\d+:\d\d(?::\d\d)?) - /g;
  let m, last = '';
  const head = plain.slice(0, pos + 1);
  while((m = re.exec(head)) !== null) { last = m[1]; }
  return last;
}

async function run(label, variant, mode, params, emb, verbose) {
  const input = mkInput(params, variant);
  const k = counters();
  const deps = k.deps(emb, mode);
  const t0 = Date.now();
  const sr = await S.segRunSections(input, deps);
  const t1 = Date.now();
  const res = await S.segRunUnits(sr, input, deps);
  const t2 = Date.now();
  const m = S.segEvaluate(res, hls, {tagUseCounts: uses, theta: input.params.theta});
  const out = {label, m, res, k: k.c, tSections: t1 - t0, tUnits: t2 - t1};
  if(verbose) { report(out, input); }
  return out;
}

function report(o, input) {
  const {m, res} = o;
  console.log('\n=== ' + o.label + ' ===');
  console.log('unitRecall %s  charRecall %s  charPrec %s  median %s words (Q1 %s, Q3 %s)',
    m.unitRecall.toFixed(3), m.charRecall.toFixed(3), m.charPrecision.toFixed(3),
    m.sizeMedian, m.sizeQ1, m.sizeQ3);
  console.log('iou R/P/F1 %s/%s/%s  thetaRecall %s thetaF1 %s\nhit@1/3/5 %s/%s/%s  thetaPrec %s (n=%d)  units %d  sections %d  other%% %s  coverage present/missing %d/%d',
    m.iouRecall.toFixed(3), m.iouPrecision.toFixed(3), m.iouF1.toFixed(3), m.thetaRecall.toFixed(3), m.thetaF1.toFixed(3),
    m.hitAt[1].toFixed(3), m.hitAt[3].toFixed(3), m.hitAt[5].toFixed(3), m.thetaPrecision.toFixed(3),
    m.nTicked, m.nUnits, m.sections, m.otherWordsPct, m.coveragePresent, m.coverageMissing);
  console.log('requests: embed calls %d (%d texts); decide calls %d, questions %d, by kind %j; llm %d',
    o.k.embed, o.k.embedTexts, o.k.decide, o.k.decideQ, o.k.byKind, o.k.llm);
  console.log('stats %j', res.stats);
  console.log('time: sections %d ms, units+tags %d ms', o.tSections, o.tUnits);
  // tiling / sanity
  const secs = res.sections;
  let gaps = 0;
  for(let i = 1; i < secs.length; ++i) { if(secs[i].start !== secs[i - 1].end) { ++gaps; } }
  let cross = 0, withCue = 0;
  const secOf = {};
  secs.forEach((s) => { secOf[s.id] = s; });
  res.units.forEach((u) => {
    const s = secOf[u.sectionId];
    if(!s || u.start < s.start || u.end > s.end) { ++cross; }
    input.turns.forEach((t, i) => {
      if(res.infos[i].cue && res.infos[i].substantive && t.start < u.end && res.infos[i].cs < u.end
         && res.infos[i].cs >= u.start && t.end <= u.end) { ++withCue; }
    });
  });
  console.log('sanity: section gaps/overlaps %d (first start %d, last end %d of %d); units outside section %d; units containing a whole interviewer question %d',
    gaps, secs[0].start, secs[secs.length - 1].end, plain.length, cross, withCue);
  const turnStarts = new Set(input.turns.map((t) => t.start));
  const withOQ = secs.filter((x) => x.openingQuestion).length;
  const midTurn = secs.filter((x) => !turnStarts.has(x.start)).length;
  console.log('sections with opening question %d/%d; starting mid-turn %d; tiny (<250 codable words) %d',
    withOQ, secs.length, midTurn, secs.filter((x) => x.codableWords < 250).length);
  const bySeg = {};
  secs.forEach((s) => { const n = s.segId === null ? '(emergent)' : s.name; bySeg[n] = (bySeg[n] || 0) + 1; });
  console.log('sections per segment: ' + Object.keys(bySeg).map((k) => k + '=' + bySeg[k]).join('; '));
  const ws = secs.map((s) => s.codableWords);
  console.log('section codable words: min %s median %s max %s', pct(ws, 0), pct(ws, 0.5), pct(ws, 1));
  const sz = res.units.map((u) => u.words);
  const hist = {'<25': 0, '25-49': 0, '50-90': 0, '91-150': 0, '>150': 0};
  sz.forEach((w) => { hist[w < 25 ? '<25' : w < 50 ? '25-49' : w <= 90 ? '50-90' : w <= 150 ? '91-150' : '>150']++; });
  console.log('unit size distribution %j', hist);
  console.log('first 25 sections:');
  secs.slice(0, 25).forEach((s, i) => {
    console.log('  %s [%s] %s | %s', String(i + 1).padStart(2), lastStamp(s.start + 1).padEnd(6),
      (s.name || '').slice(0, 34).padEnd(34), (s.openingQuestion || '').replace(/\s+/g, ' ').slice(0, 60));
  });
}

(async () => {
  console.log('turns: %d (expected ~217); interviewer %d, interviewee %d, unlabeled %d',
    turns.length, turns.filter((t) => t.speaker === 'I').length,
    turns.filter((t) => t.speaker === 'P').length, turns.filter((t) => t.speaker === null).length);
  const tE = Date.now();
  const emb = makeEmbedder(plain, DIM);
  console.log('embedder: vocab %d, sentences %d, dims %d, fit %d ms (TF-IDF + LSA stand-in; crude)',
    emb.V, emb.N, emb.l, Date.now() - tE);
  const variants = [['embedding-only, no exemplars (excludeDocId)', 'noex', null],
                    ['embedding-only, leave-one-out exemplars', 'loo', null],
                    ['uniform-probability decide, leave-one-out', 'loo', 'uniform']];
  if(argv.indexOf('--fake-decide') >= 0) {
    variants.push(['fake always-answering decide, leave-one-out', 'loo', 'fake']);
  }
  const results = [];
  for(let i = 0; i < variants.length; ++i) {
    results.push(await run(variants[i][0], variants[i][1], variants[i][2], {}, emb, true));
  }
  if(argv.indexOf('--grid') >= 0) {
    console.log('\n=== grid (leave-one-out exemplars, embedding-only) ===');
    const cache = {};
    const sections = {};
    const runFn = async (p) => {
      const key = [p.kappa, p.lambda].join('|');
      const input = mkInput({kappa: p.kappa, lambda: p.lambda, tau: p.tau, theta: p.theta}, 'loo');
      const deps = counters().deps(emb, null);
      if(!sections[key]) { sections[key] = await S.segRunSections(input, deps); }
      const res = await S.segRunUnits(sections[key], input, deps);
      const m = S.segEvaluate(res, hls, {tagUseCounts: uses, theta: p.theta});
      m.rescore = (th) => S.segEvaluate(res, hls, {tagUseCounts: uses, theta: th});
      return m;
    };
    const g = await S.segGridSearch(runFn, {
      tau: [0.15, 0.25, 0.35, 0.5], kappa: [0.05, 0.15, 0.25], lambda: [1, 2, 4], theta: [0.5, 0.6, 0.7]});
    g.rows.forEach((r) => console.log('tau %s kappa %s lambda %s theta %s -> recall %s cP %s size %s units %d secs %d hit3 %s thP %s iouF1 %s thF1 %s',
      r.params.tau, r.params.kappa, r.params.lambda, r.params.theta, r.metrics.unitRecall.toFixed(3),
      r.metrics.charPrecision.toFixed(3), r.metrics.sizeMedian, r.metrics.nUnits, r.metrics.sections,
      r.metrics.hitAt[3].toFixed(3), r.metrics.thetaPrecision.toFixed(3), r.metrics.iouF1.toFixed(3), r.metrics.thetaF1.toFixed(3)));
    console.log('BEST %j fallback=%s', g.best.params, g.fallback);
  }
})().catch((e) => { console.error(e); process.exit(1); });
