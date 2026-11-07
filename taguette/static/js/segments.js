/*
 * Thematic segments: pure algorithmic core.
 *
 * Splits an interview transcript into thematic sections following an
 * interview guide (a Viterbi labelling of text windows over guide segments
 * plus an `other` state), cuts sections into suggested coding units and
 * scores codebook tags for each unit. No DOM, no fetch: every model call goes
 * through injected `deps` (embed / decide / llm), so it runs under Node.
 *
 * - Helpers + parameters
 * - Turn info + windows
 * - Labelling (emissions, Viterbi, decision tie-break)
 * - Sections
 * - Manual edits
 * - Units
 * - Tags
 * - Prompts + tolerant parsers
 * - Evaluation + grid search
 * - Pipeline
 * - Self-test
 */


/*
 * Helpers + parameters
 */

var SEG_PARAM_DEFS = [
  {key: 'window_max_words', label: 'Maximum window size (words)',
   help: 'Longest stretch of text that is assigned to a single segment at once. Long answers are cut into windows of at most this size.',
   def: 80, min: 20, max: 400, step: 5, advanced: false},
  {key: 'section_min_words', label: 'Minimum section size (codable words)',
   help: 'Sections with fewer words are merged into the neighbouring section they most resemble.',
   def: 150, min: 0, max: 2000, step: 10, advanced: false},
  {key: 'emergent_min_words', label: 'Minimum emergent segment size (words)',
   help: 'A subject outside the guide must span at least this many words to be proposed as an emergent segment.',
   def: 250, min: 0, max: 3000, step: 10, advanced: false},
  {key: 'unit_min_words', label: 'Suggested unit size (min/max words)',
   help: 'Smallest and largest size of the suggested passages to code.',
   def: 25, min: 5, max: 200, step: 5, advanced: false, pair: 'unit_words'},
  {key: 'unit_max_words', label: 'Suggested unit size (min/max words)',
   help: 'Smallest and largest size of the suggested passages to code.',
   def: 150, min: 20, max: 600, step: 5, advanced: false, pair: 'unit_words'},
  {key: 'tau', label: 'Unit granularity',
   help: 'Higher values cut sections into more, shorter units; lower values give fewer, longer units.',
   def: 0.25, min: 0, max: 0.9, step: 0.05, advanced: false},
  {key: 'top_k', label: 'Tags checked per suggestion',
   help: 'How many of the most similar tags are checked for each suggested unit.',
   def: 8, min: 1, max: 20, step: 1, advanced: false},
  {key: 'theta', label: 'Minimum confidence to tick a tag',
   help: 'Tags proposed with at least this confidence are pre-selected.',
   def: 0.6, min: 0, max: 1, step: 0.05, advanced: false},
  {key: 'band_low', label: 'Uncertainty band (checked by the fast LLM)',
   help: 'Tags whose confidence falls inside this band are double-checked by the fast language model.',
   def: 0.4, min: 0, max: 1, step: 0.05, advanced: false, pair: 'band'},
  {key: 'band_high', label: 'Uncertainty band (checked by the fast LLM)',
   help: 'Tags whose confidence falls inside this band are double-checked by the fast language model.',
   def: 0.6, min: 0, max: 1, step: 0.05, advanced: false, pair: 'band'},
  {key: 'kappa', label: 'Advanced: tolerance for off-script subjects',
   help: 'Higher values make it easier for a passage to be labelled as an off-script subject instead of a guide segment.',
   def: 0.15, min: 0, max: 0.9, step: 0.05, advanced: true},
  {key: 'lambda', label: 'Advanced: resistance to switching segments',
   help: 'Higher values give fewer, longer sections; lower values follow the conversation more closely.',
   def: 2.0, min: 0, max: 10, step: 0.25, advanced: true}
];

// Translation that also substitutes %(name)s when the catalog is missing or
// returns the template untouched (the Node harness uses an identity stub).
// Named segGettext because segments-ai.js already owns `segT`.
function segGettext(message, args) {
  var out = message;
  if(typeof gettext === 'function') {
    try {
      out = gettext(message, args);
    } catch(e) {
      out = message;
    }
  }
  if(args && typeof out === 'string' && out.indexOf('%(') !== -1) {
    out = out.replace(/%\((\w+)\)s/g, function(m, k) {
      return args.hasOwnProperty(k) ? String(args[k]) : m;
    });
  }
  return out;
}

function segClamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function segParamDefaults() {
  var out = {};
  for(var i = 0; i < SEG_PARAM_DEFS.length; ++i) {
    out[SEG_PARAM_DEFS[i].key] = SEG_PARAM_DEFS[i].def;
  }
  return out;
}

function segApplyParamObject(out, obj) {
  if(!obj || typeof obj !== 'object') {
    return;
  }
  for(var i = 0; i < SEG_PARAM_DEFS.length; ++i) {
    var d = SEG_PARAM_DEFS[i];
    var v = obj[d.key];
    if(typeof v === 'number' && isFinite(v)) {
      out[d.key] = segClamp(v, d.min, d.max);
    }
  }
}

function segParamDef(key) {
  for(var i = 0; i < SEG_PARAM_DEFS.length; ++i) {
    if(SEG_PARAM_DEFS[i].key === key) {
      return SEG_PARAM_DEFS[i];
    }
  }
  return null;
}

// Defaults + stored overrides + call-time overrides, clamped and coherent
function segParams(overrides) {
  var out = segParamDefaults();
  if(typeof taguConfig === 'function') {
    try {
      segApplyParamObject(out, taguConfig().segmentation_params);
    } catch(e) {
      // ignore broken stored config
    }
  }
  segApplyParamObject(out, overrides);
  if(out.unit_min_words >= out.unit_max_words) {
    var step = segParamDef('unit_max_words').step;
    out.unit_max_words = out.unit_min_words + step;
    var cap = segParamDef('unit_max_words').max;
    if(out.unit_max_words > cap) {
      out.unit_max_words = cap;
      out.unit_min_words = cap - step;
    }
  }
  if(out.band_low > out.band_high) {
    var tmp = out.band_low;
    out.band_low = out.band_high;
    out.band_high = tmp;
  }
  return out;
}

// Store only the keys that differ from the defaults
function segSaveParams(obj) {
  var defs = segParamDefaults();
  var merged = segParamDefaults();
  segApplyParamObject(merged, obj);
  var diff = {};
  for(var k in defs) {
    if(merged[k] !== defs[k]) {
      diff[k] = merged[k];
    }
  }
  if(typeof taguConfig === 'function' && typeof taguConfigSave === 'function') {
    var cfg = taguConfig();
    cfg.segmentation_params = diff;
    taguConfigSave(cfg);
  }
  return diff;
}

// Linear-interpolated quantile (q in [0,1]); 0 for an empty list
function segQuantile(values, q) {
  if(!values.length) {
    return 0;
  }
  var a = values.slice().sort(function(x, y) {
    return x - y;
  });
  var pos = segClamp(q, 0, 1) * (a.length - 1);
  var lo = Math.floor(pos);
  var hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

// Cosine that tolerates Array/Float32Array, missing and zero vectors
function segCos(a, b) {
  if(!a || !b) {
    return 0;
  }
  var dot = 0, na = 0, nb = 0;
  var n = Math.min(a.length, b.length);
  for(var i = 0; i < n; ++i) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if(na === 0 || nb === 0) {
    return 0;
  }
  return dot / Math.sqrt(na * nb);
}

// Plain-Array unit vector (zero vector stays zero, unlike sugNormalize)
function segVecNorm(v) {
  var n = v.length;
  var out = new Array(n);
  var s = 0, i;
  for(i = 0; i < n; ++i) {
    s += v[i] * v[i];
  }
  s = Math.sqrt(s);
  for(i = 0; i < n; ++i) {
    out[i] = s === 0 ? 0 : v[i] / s;
  }
  return out;
}

// acc += v (acc may be null -> new array)
function segAddInto(acc, v) {
  if(!v) {
    return acc;
  }
  if(!acc) {
    acc = new Array(v.length);
    for(var j = 0; j < v.length; ++j) {
      acc[j] = 0;
    }
  }
  for(var i = 0; i < v.length && i < acc.length; ++i) {
    acc[i] += v[i];
  }
  return acc;
}

function segMean(a) {
  var s = 0;
  for(var i = 0; i < a.length; ++i) {
    s += a[i];
  }
  return a.length ? s / a.length : 0;
}

function segMeanStd(a) {
  var m = segMean(a);
  var s = 0;
  for(var i = 0; i < a.length; ++i) {
    s += (a[i] - m) * (a[i] - m);
  }
  return {mean: m, std: Math.max(1e-6, a.length ? Math.sqrt(s / a.length) : 0)};
}

function segCountWords(text) {
  return sugTokenize(text).length;
}

function segTrunc(text, n) {
  text = String(text == null ? '' : text);
  return text.length > n ? text.substring(0, n - 1) + '…' : text;
}

function segProgress(deps, stage, done, total) {
  if(deps && typeof deps.progress === 'function') {
    try {
      deps.progress(stage, done, total);
    } catch(e) {
      // progress must never break the pipeline
    }
  }
}

function segTurnKey(turn) {
  return sugTextKey('t', turn.text);
}

// Run fn over items with at most `size` promises in flight per batch
function segBatched(items, size, fn) {
  var results = new Array(items.length);
  function next(start) {
    if(start >= items.length) {
      return Promise.resolve(results);
    }
    var chunk = [];
    for(var i = start; i < Math.min(items.length, start + size); ++i) {
      chunk.push(fn(items[i], i));
    }
    return Promise.all(chunk).then(function(vals) {
      for(var j = 0; j < vals.length; ++j) {
        results[start + j] = vals[j];
      }
      return next(start + size);
    });
  }
  return next(0);
}

// Safe wrapper: a rejecting/throwing dep behaves like "not configured"
function segSafe(fn) {
  try {
    return Promise.resolve(fn()).then(null, function() {
      return null;
    });
  } catch(e) {
    return Promise.resolve(null);
  }
}

function segDepDecide(deps, questions, state) {
  if(!deps || typeof deps.decide !== 'function') {
    return Promise.resolve(null);
  }
  return segSafe(function() {
    return deps.decide(questions, state);
  });
}

function segDepLLM(deps, prompt, maxTokens) {
  if(!deps || typeof deps.llm !== 'function') {
    return Promise.resolve(null);
  }
  return segSafe(function() {
    return deps.llm(prompt, maxTokens);
  });
}

// Fake deterministic embedder for tests: hashed bag of content words
function segHash(str, seed) {
  var h = seed >>> 0;
  for(var i = 0; i < str.length; ++i) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function segFakeEmbed(texts, dim, asFloat32) {
  dim = dim || 256;
  var out = [];
  for(var t = 0; t < texts.length; ++t) {
    var v = new Array(dim);
    var i;
    for(i = 0; i < dim; ++i) {
      v[i] = 0;
    }
    var toks = sugTokenize(texts[t]);
    for(i = 0; i < toks.length; ++i) {
      var w = toks[i].word;
      if(w.length < 2 || sugIsStop(w)) {
        continue;
      }
      var idx = segHash(w, 0x811c9dc5) % dim;
      v[idx] += (segHash(w, 0xdeadbeef) & 1) ? 1 : -1;
    }
    out.push(asFloat32 ? new Float32Array(v) : v);
  }
  return Promise.resolve(out);
}


/*
 * Turn info + windows
 */

// Per-turn facts shared by windows and units
function segTurnInfos(input) {
  var spk = {};
  var speakers = input.speakers || [];
  for(var s = 0; s < speakers.length; ++s) {
    spk[speakers[s].id] = speakers[s];
  }
  var plain = input.plainText;
  var turns = input.turns || [];
  var infos = [];
  for(var i = 0; i < turns.length; ++i) {
    var t = turns[i];
    var cs = (typeof t.contentStart === 'number' && t.contentStart >= t.start)
      ? Math.min(t.contentStart, t.end) : t.start;
    // The speaker label is never spoken content: start after labelEnd too
    if(typeof t.labelEnd === 'number' && t.labelEnd > cs) {
      cs = Math.min(t.labelEnd, t.end);
    }
    while(cs < t.end && /\s/.test(plain.charAt(cs))) {
      ++cs;
    }
    var text = plain.slice(cs, t.end);
    var sents = sugSplitSentences(text);
    var words = segCountWords(text);
    var cue = t.speaker !== null && t.speaker !== undefined
      && !!spk[t.speaker] && spk[t.speaker].include === false;
    var backchannel = words <= 3 || sents.length === 0;
    if(!backchannel) {
      backchannel = true;
      for(var q = 0; q < sents.length; ++q) {
        if(!sugIsBackchannel(sents[q])) {
          backchannel = false;
          break;
        }
      }
    }
    infos.push({
      cs: cs, text: text, sents: sents, words: words, cue: cue,
      backchannel: backchannel,
      substantive: cue && !backchannel && words >= 8
    });
  }
  return infos;
}

// Cut a turn's sentences into ~equal chunks of at most `max` words (greedy:
// close a chunk when the next sentence would overflow it or the running
// total passes the balanced target)
function segChunkSentences(sents, max) {
  var sw = [], total = 0, i;
  for(i = 0; i < sents.length; ++i) {
    sw.push(segCountWords(sents[i].text));
    total += sw[i];
  }
  var n = Math.max(1, Math.ceil(total / max));
  var target = total / n;
  var chunks = [], cur = [], curWords = 0, before = 0;
  for(i = 0; i < sents.length; ++i) {
    var close = cur.length > 0 && (curWords + sw[i] > max
      || (chunks.length < n - 1 && before + sw[i] / 2 > target * (chunks.length + 1)));
    if(close) {
      chunks.push({sents: cur, words: curWords});
      cur = [];
      curWords = 0;
    }
    cur.push(sents[i]);
    curWords += sw[i];
    before += sw[i];
  }
  if(cur.length) {
    chunks.push({sents: cur, words: curWords});
  }
  return chunks;
}

function segBuildWindows(input, infos) {
  var P = input.params || segParams();
  infos = infos || segTurnInfos(input);
  var turns = input.turns || [];
  var plain = input.plainText;
  var windows = [];
  for(var ti = 0; ti < turns.length; ++ti) {
    var info = infos[ti];
    if(info.backchannel) {
      continue; // transparent: takes the label of the surrounding section
    }
    var chunks = segChunkSentences(info.sents, P.window_max_words);
    for(var c = 0; c < chunks.length; ++c) {
      var ch = chunks[c];
      var start = info.cs + ch.sents[0].start;
      var end = info.cs + ch.sents[ch.sents.length - 1].end;
      windows.push({
        i: windows.length, start: start, end: end,
        text: plain.slice(start, end), turnIdx: ti,
        cue: info.cue, substantive: info.substantive,
        firstOfTurn: c === 0, words: ch.words,
        weight: info.cue ? (info.substantive ? 1.5 : 0)
          : Math.min(1, ch.words / 20)
      });
    }
  }
  return windows;
}


/*
 * Labelling
 */

function segGuideProtoText(g) {
  return (g.name || '') + '. ' + (g.description || '') + '\n'
    + (g.guide_questions || []).join('\n');
}

// Texts to embed for the guide: one prototype per segment + its questions
function segGuideTexts(guide) {
  var protoTexts = [], qTexts = [], qIndex = [];
  for(var k = 0; k < guide.length; ++k) {
    protoTexts.push(segGuideProtoText(guide[k]));
    var qs = guide[k].guide_questions || [];
    qIndex.push([]);
    for(var q = 0; q < qs.length; ++q) {
      qIndex[k].push(qTexts.length);
      qTexts.push(qs[q]);
    }
  }
  return {protoTexts: protoTexts, qTexts: qTexts, qIndex: qIndex};
}

// protos = {P: [vec per segment], Q: [[vec per question] per segment]}
function segBuildProtos(guide, protoVecs, qVecs, qIndex, extras) {
  var P = [], Q = [];
  for(var k = 0; k < guide.length; ++k) {
    var p = segVecNorm(protoVecs[k]);
    var ex = extras && extras[guide[k].id];
    if(ex && ex.length) {
      var sum = null;
      for(var e = 0; e < ex.length; ++e) {
        sum = segAddInto(sum, segVecNorm(ex[e]));
      }
      var m = segVecNorm(sum);
      var comb = new Array(p.length);
      for(var j = 0; j < p.length; ++j) {
        comb[j] = p[j] + (m[j] || 0);
      }
      p = segVecNorm(comb);
    }
    P.push(p);
    var qv = [];
    for(var q = 0; q < qIndex[k].length; ++q) {
      qv.push(segVecNorm(qVecs[qIndex[k][q]]));
    }
    Q.push(qv);
  }
  return {P: P, Q: Q};
}

// Fill emissions for a group of windows: z-normalise their similarities over
// the whole group (model-agnostic), weight them, and give `other` the
// kappa-quantile of the per-window best z.
function segGroupEmit(idxs, simFn, G, E, windows, kappa, factor) {
  if(!idxs.length) {
    return;
  }
  var sims = [], flat = [], j, k;
  for(j = 0; j < idxs.length; ++j) {
    var row = new Array(G);
    for(k = 0; k < G; ++k) {
      row[k] = simFn(idxs[j], k);
      flat.push(row[k]);
    }
    sims.push(row);
  }
  var ms = segMeanStd(flat);
  var M = [];
  for(j = 0; j < idxs.length; ++j) {
    var best = -Infinity;
    for(k = 0; k < G; ++k) {
      sims[j][k] = (sims[j][k] - ms.mean) / ms.std;
      best = Math.max(best, sims[j][k]);
    }
    M.push(best);
  }
  var qo = segQuantile(M, kappa);
  for(j = 0; j < idxs.length; ++j) {
    var w = idxs[j];
    var wt = factor === null ? windows[w].weight : factor;
    for(k = 0; k < G; ++k) {
      E[w][k] = wt * sims[j][k];
    }
    E[w][G] = wt * qo;
  }
}

// E[w][k]: emission of state k for window w (k = G is `other`)
function segEmissions(windows, vecs, protos, params) {
  var G = protos.P.length;
  var E = [], w;
  for(w = 0; w < windows.length; ++w) {
    var row = [];
    for(var k = 0; k <= G; ++k) {
      row.push(0);
    }
    E.push(row);
  }
  if(G === 0) {
    return E;
  }
  var content = [], cues = [];
  for(w = 0; w < windows.length; ++w) {
    if(!windows[w].cue) {
      content.push(w);
    } else if(windows[w].substantive) {
      cues.push(w);
    }
  }
  segGroupEmit(content, function(w, k) {
    return segCos(vecs[w], protos.P[k]);
  }, G, E, windows, params.kappa, null);
  segGroupEmit(cues, function(w, k) {
    var qs = protos.Q[k];
    if(!qs || !qs.length) {
      return segCos(vecs[w], protos.P[k]);
    }
    var best = -Infinity;
    for(var q = 0; q < qs.length; ++q) {
      best = Math.max(best, segCos(vecs[w], qs[q]));
    }
    return best;
  }, G, E, windows, params.kappa, 1.5);
  return E;
}

// Maximise the summed emissions with a uniform switch penalty (cheaper when
// the new window opens a substantive interviewer question, dearer in the
// middle of a turn). O(n*S): the best
// predecessor is shared by all switching moves. Ties -> lower state index.
function segViterbi(E, windows, params) {
  var n = E.length;
  if(n === 0) {
    return [];
  }
  var S = E[0].length, lam = params.lambda;
  var dp = E[0].slice(), back = [], s, w;
  for(w = 1; w < n; ++w) {
    var win = windows[w];
    var cost = (win.cue && win.substantive && win.firstOfTurn) ? 0.25 * lam
      : (win.firstOfTurn ? lam : 1.5 * lam);
    var best = -Infinity, bi = 0;
    for(s = 0; s < S; ++s) {
      if(dp[s] > best) {
        best = dp[s];
        bi = s;
      }
    }
    var nd = new Array(S), bk = new Array(S);
    for(s = 0; s < S; ++s) {
      var stay = dp[s], sw = best - cost, prev;
      if(s === bi || stay > sw + 1e-12) {
        prev = s;
      } else if(sw > stay + 1e-12) {
        prev = bi;
      } else {
        prev = Math.min(s, bi);
      }
      nd[s] = E[w][s] + (prev === s ? stay : sw);
      bk[s] = prev;
    }
    dp = nd;
    back.push(bk);
  }
  var cur = 0;
  for(s = 1; s < S; ++s) {
    if(dp[s] > dp[cur] + 1e-12) {
      cur = s;
    }
  }
  var labels = new Array(n);
  for(w = n - 1; w >= 0; --w) {
    labels[w] = cur;
    if(w > 0) {
      cur = back[w - 1][cur];
    }
  }
  return labels;
}

// Windows whose best two emissions are within 0.3: candidates for the
// decision model (smallest margin first; at most min(120, 20% of the
// content windows))
function segAmbiguous(E, windows) {
  var out = [], content = 0;
  for(var w = 0; w < windows.length; ++w) {
    if(!windows[w].cue) {
      ++content;
    }
    if(windows[w].cue || windows[w].weight < 0.5 || E[w].length < 2) {
      continue;
    }
    var b1 = -Infinity, b2 = -Infinity;
    for(var k = 0; k < E[w].length; ++k) {
      if(E[w][k] > b1) {
        b2 = b1;
        b1 = E[w][k];
      } else if(E[w][k] > b2) {
        b2 = E[w][k];
      }
    }
    if(b1 - b2 < 0.3) {
      out.push({w: w, margin: b1 - b2});
    }
  }
  out.sort(function(a, b) {
    return (a.margin - b.margin) || (a.w - b.w);
  });
  return out.slice(0, Math.min(120, Math.ceil(0.2 * content)));
}

// Top-3 guide segments (not `other`) by current emission
function segTopSegments(row, G, n) {
  var idx = [];
  for(var k = 0; k < G; ++k) {
    idx.push(k);
  }
  idx.sort(function(a, b) {
    return (row[b] - row[a]) || (a - b);
  });
  return idx.slice(0, n);
}

function segWindowQuestion(segs) {
  var criteria = {};
  for(var i = 0; i < segs.length; ++i) {
    criteria['s' + segs[i].id] = (segs[i].name || '') + ': ' + (segs[i].description || '');
  }
  criteria.other_topic = 'a subject not covered by the listed areas';
  return {segment: {
    type: 'choice',
    instructions: 'Which broad area of the interview script does this passage of an interview transcript belong to? Choose other_topic if it is an off-script subject.',
    criteria: criteria
  }};
}

function segWindowState(window, lastCueText, prevText) {
  var parts = [];
  if(lastCueText) {
    parts.push('Interviewer\'s latest question: ' + segTrunc(lastCueText, 600));
  }
  if(prevText) {
    parts.push('Previous passage: ' + segTrunc(prevText, 600));
  }
  parts.push('Passage: ' + segTrunc(window.text, 600));
  return parts.join('\n\n');
}

// Probability of `criterion` in answers[name]; null when unusable
function segAnswerProb(answers, name, criterion) {
  var a = answers && answers[name];
  if(!a) {
    return null;
  }
  var pr = a.probabilities;
  if(pr && typeof pr[criterion] === 'number' && isFinite(pr[criterion])) {
    return pr[criterion];
  }
  if(typeof a.choice === 'string') {
    return a.choice === criterion ? 1 : 0;
  }
  return null;
}

// -> {probs: {stateIndex: p}} | null
function segParseWindowAnswer(answers, guide) {
  var a = answers && answers.segment;
  if(!a) {
    return null;
  }
  var G = guide.length;
  function stateOf(key) {
    if(key === 'other_topic') {
      return G;
    }
    var m = /^s(.+)$/.exec(key);
    if(!m) {
      return -1;
    }
    for(var i = 0; i < G; ++i) {
      if(String(guide[i].id) === m[1]) {
        return i;
      }
    }
    return -1;
  }
  var probs = {}, any = false, key;
  if(a.probabilities && typeof a.probabilities === 'object') {
    for(key in a.probabilities) {
      var st = stateOf(key), p = a.probabilities[key];
      if(st >= 0 && typeof p === 'number' && isFinite(p)) {
        probs[st] = p;
        any = true;
      }
    }
  }
  if(!any && typeof a.choice === 'string' && stateOf(a.choice) >= 0) {
    probs[stateOf(a.choice)] = 1;
    any = true;
  }
  return any ? {probs: probs} : null;
}

// Pull the emissions of ambiguous windows towards the decision model's
// opinion: best state keeps e1, others lose 2*weight*(pmax - p)
function segApplyDecisions(E, windows, decisions) {
  for(var key in decisions) {
    var w = parseInt(key, 10);
    var probs = decisions[key] && decisions[key].probs;
    if(!probs || !E[w]) {
      continue;
    }
    var pmax = -Infinity, k;
    for(k in probs) {
      pmax = Math.max(pmax, probs[k]);
    }
    var e1 = Math.max.apply(null, E[w]);
    for(k in probs) {
      E[w][k] = e1 + 2 * windows[w].weight * (probs[k] - pmax);
    }
  }
}

// -> labels (state index per window; G = other). `decisions` = {windowIdx: {probs}}
function segLabel(windows, vecs, protos, params, decisions) {
  var E = segEmissions(windows, vecs, protos, params);
  if(decisions) {
    segApplyDecisions(E, windows, decisions);
  }
  return segViterbi(E, windows, params);
}


/*
 * Sections
 */

function segCollapse(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function segOpeningQuestionOf(input, window, infos) {
  if(!window || !window.cue || !window.substantive) {
    return null;
  }
  var text = segCollapse(infos[window.turnIdx].text);
  return text ? segTrunc(text, 140) : null;
}

function segSectionLabel(name, openingQuestion) {
  return openingQuestion
    ? name + ' — “' + openingQuestion + '”' : name;
}

function segRunSum(windows, vecs, i0, i1) {
  var sum = null, codable = 0;
  for(var w = i0; w < i1; ++w) {
    if(!windows[w].cue) {
      codable += windows[w].words;
      sum = segAddInto(sum, vecs[w] ? segVecNorm(vecs[w]) : null);
    }
  }
  return {sum: sum, codable: codable};
}

function segBuildRuns(windows, labels, vecs) {
  var runs = [], w;
  for(w = 0; w < windows.length; ++w) {
    if(runs.length && runs[runs.length - 1].label === labels[w]) {
      runs[runs.length - 1].i1 = w + 1;
    } else {
      runs.push({label: labels[w], i0: w, i1: w + 1});
    }
  }
  // The interviewer's question opens the section: pull the cue windows that
  // precede a new run's first content window out of the previous run.
  for(var r = 1; r < runs.length; ++r) {
    var run = runs[r], prev = runs[r - 1];
    if(windows[run.i0].cue) {
      continue;
    }
    var j = run.i0;
    while(j - 1 > prev.i0 && windows[j - 1].cue) {
      --j;
    }
    if(j < run.i0) {
      prev.i1 = j;
      run.i0 = j;
    }
  }
  for(r = 0; r < runs.length; ++r) {
    var st = segRunSum(windows, vecs, runs[r].i0, runs[r].i1);
    runs[r].sum = st.sum;
    runs[r].codable = st.codable;
  }
  return runs;
}

// Merge undersized runs into the most similar neighbour until stable
function segAbsorbRuns(runs, protos, params) {
  var G = protos.P.length;
  function ref(run) {
    return run.label < G ? protos.P[run.label] : run.sum;
  }
  while(runs.length > 1) {
    var pick = -1, pickWords = Infinity, r;
    for(r = 0; r < runs.length; ++r) {
      var min = runs[r].label === G ? params.emergent_min_words : params.section_min_words;
      if(runs[r].codable < min && runs[r].codable < pickWords) {
        pick = r;
        pickWords = runs[r].codable;
      }
    }
    if(pick < 0) {
      break;
    }
    var run = runs[pick], into;
    if(pick === 0) {
      into = 1;
    } else if(pick === runs.length - 1) {
      into = pick - 1;
    } else {
      var sp = segCos(run.sum, ref(runs[pick - 1]));
      var sn = segCos(run.sum, ref(runs[pick + 1]));
      into = sp >= sn ? pick - 1 : pick + 1;
    }
    var nb = runs[into];
    nb.i0 = Math.min(nb.i0, run.i0);
    nb.i1 = Math.max(nb.i1, run.i1);
    nb.codable += run.codable;
    nb.sum = segAddInto(nb.sum ? nb.sum.slice() : null, run.sum);
    if(run.sum && nb.sum === null) {
      nb.sum = run.sum.slice();
    }
    runs.splice(pick, 1);
    for(r = runs.length - 1; r > 0; --r) {
      if(runs[r].label === runs[r - 1].label) {
        runs[r - 1].i1 = runs[r].i1;
        runs[r - 1].codable += runs[r].codable;
        runs[r - 1].sum = segAddInto(runs[r - 1].sum ? runs[r - 1].sum.slice() : null, runs[r].sum);
        runs.splice(r, 1);
      }
    }
  }
  return runs;
}

function segBuildSections(windows, labels, input, vecs, protos, infos) {
  var P = input.params || segParams();
  var guide = input.guide || [];
  var G = guide.length;
  var plain = input.plainText;
  var turns = input.turns || [];
  infos = infos || segTurnInfos(input);
  var len = plain.length;
  if(windows.length === 0) {
    return len === 0 ? [] : [{
      id: 'sec0', start: 0, end: len, segId: null, emergent: null,
      openingQuestion: null, name: segGettext('Whole document'),
      label: segGettext('Whole document'), words: segCountWords(plain),
      codableWords: 0, windowRange: [0, 0], manual: false, vec: null
    }];
  }
  var runs;
  if(G === 0) {
    // Nothing to follow: the whole document is one section
    var all = segRunSum(windows, vecs, 0, windows.length);
    runs = [{label: 0, i0: 0, i1: windows.length, sum: all.sum, codable: all.codable}];
  } else {
    runs = segAbsorbRuns(segBuildRuns(windows, labels, vecs), protos, P);
  }
  var sections = [], n = 0;
  for(var r = 0; r < runs.length; ++r) {
    var run = runs[r];
    var first = windows[run.i0];
    var start = r === 0 ? 0 : (first.firstOfTurn ? turns[first.turnIdx].start : first.start);
    if(r > 0) {
      start = Math.max(start, sections[r - 1].start + 1);
      sections[r - 1].end = start;
    }
    var sec = {
      id: 'sec' + r, start: start, end: len, segId: null, emergent: null,
      openingQuestion: segOpeningQuestionOf(input, first, infos),
      name: '', label: '', words: 0, codableWords: run.codable,
      windowRange: [run.i0, run.i1], manual: false,
      vec: run.sum ? segVecNorm(run.sum) : null
    };
    if(G === 0) {
      sec.name = segGettext('Whole document');
    } else if(run.label < G) {
      sec.segId = guide[run.label].id;
      sec.name = guide[run.label].name;
    } else {
      ++n;
      sec.emergent = {key: 'e' + n, name: segGettext('Emergent %(n)s', {n: n}),
                      description: '', question: '', proposed: false};
      sec.name = sec.emergent.name;
    }
    sec.label = segSectionLabel(sec.name, sec.openingQuestion);
    sections.push(sec);
  }
  for(r = 0; r < sections.length; ++r) {
    sections[r].words = segCountWords(plain.slice(sections[r].start, sections[r].end));
  }
  return sections;
}

function segCoverage(sections, guide) {
  var seen = {};
  for(var i = 0; i < sections.length; ++i) {
    if(sections[i].segId !== null && sections[i].segId !== undefined) {
      seen[sections[i].segId] = true;
    }
  }
  var present = [], missing = [];
  for(var k = 0; k < guide.length; ++k) {
    (seen[guide[k].id] ? present : missing).push(guide[k].id);
  }
  return {present: present, missing: missing};
}

// Best existing guide segment for an emergent vector (dedup suggestion)
function segSimilarSegment(emergentVec, guide, guideVecs, minCos) {
  minCos = minCos === undefined ? 0.85 : minCos;
  if(!emergentVec) {
    return null;
  }
  var best = null;
  for(var k = 0; k < guide.length; ++k) {
    var c = segCos(emergentVec, guideVecs[k]);
    if(c >= minCos && (!best || c > best.cos)) {
      best = {segId: guide[k].id, cos: c};
    }
  }
  return best;
}


/*
 * Manual edits
 */

// Index of the last turn starting at or before `pos` (-1 if none)
function segTurnAt(turns, pos) {
  var lo = 0, hi = turns.length - 1, ans = -1;
  while(lo <= hi) {
    var mid = (lo + hi) >> 1;
    if(turns[mid].start <= pos) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function segCloneSection(s) {
  var c = {};
  for(var k in s) {
    c[k] = s[k];
  }
  c.windowRange = s.windowRange ? s.windowRange.slice() : [0, 0];
  c.emergent = s.emergent ? {key: s.emergent.key, name: s.emergent.name,
    description: s.emergent.description, question: s.emergent.question,
    proposed: s.emergent.proposed} : null;
  return c;
}

// Re-impose the user's section starts and assignments. Edits are keyed by
// turn text: turns whose text changed (or is ambiguous) lose their edits.
// ctx (optional) = {guide, windows, plainText, infos} to refresh derived fields.
function segApplyManual(sections, turns, manual, ctx) {
  if(!manual || !sections.length) {
    return sections;
  }
  ctx = ctx || {};
  var count = {}, at = {}, i;
  for(i = 0; i < turns.length; ++i) {
    var k = segTurnKey(turns[i]);
    count[k] = (count[k] || 0) + 1;
    at[k] = i;
  }
  var cuts = {};
  var starts = manual.starts || [];
  for(i = 0; i < starts.length; ++i) {
    if(count[starts[i]] === 1) {
      cuts[turns[at[starts[i]]].start] = true;
    }
  }
  var assign = manual.assign || {};
  var emergents = {};
  for(i = 0; i < sections.length; ++i) {
    if(sections[i].emergent) {
      emergents[sections[i].emergent.key] = sections[i].emergent;
    }
  }
  var out = [], s;
  for(s = 0; s < sections.length; ++s) {
    var sec = sections[s];
    var pts = [sec.start];
    for(var c in cuts) {
      var pos = parseInt(c, 10);
      if(pos > sec.start && pos < sec.end) {
        pts.push(pos);
      }
    }
    pts.sort(function(a, b) {
      return a - b;
    });
    for(var p = 0; p < pts.length; ++p) {
      var piece = segCloneSection(sec);
      piece.start = pts[p];
      piece.end = p + 1 < pts.length ? pts[p + 1] : sec.end;
      if(p > 0) {
        piece.openingQuestion = null;
        piece.windowRange = null;
      }
      if(cuts[piece.start]) {
        piece.manual = true;
      }
      var ti = segTurnAt(turns, piece.start);
      var key = ti >= 0 ? segTurnKey(turns[ti]) : null;
      var entry = key !== null && count[key] === 1 ? assign[key] : null;
      if(entry) {
        piece.manual = true;
        if(entry.segId !== null && entry.segId !== undefined) {
          piece.segId = entry.segId;
          piece.emergent = null;
        } else if(entry.emergentKey) {
          piece.segId = null;
          piece.emergent = emergents[entry.emergentKey] ? segCloneSection({
            emergent: emergents[entry.emergentKey]}).emergent
            : {key: entry.emergentKey, name: entry.emergentKey, description: '',
               question: '', proposed: false};
          emergents[entry.emergentKey] = emergents[entry.emergentKey] || piece.emergent;
        } else {
          piece.segId = null;
          piece.emergent = null;
        }
      }
      out.push(piece);
    }
  }
  segRefreshSections(out, ctx);
  return out;
}

// Recompute names, ids and (when windows are known) window-derived fields
function segRefreshSections(sections, ctx) {
  var guide = ctx.guide || null, windows = ctx.windows || null;
  var byId = {}, g;
  if(guide) {
    for(g = 0; g < guide.length; ++g) {
      byId[guide[g].id] = guide[g];
    }
  }
  var ptr = 0;
  for(var i = 0; i < sections.length; ++i) {
    var s = sections[i];
    s.id = 'sec' + i;
    if(windows) {
      while(ptr < windows.length && windows[ptr].start < s.start) {
        ++ptr;
      }
      var j = ptr, codable = 0;
      while(j < windows.length && windows[j].start < s.end) {
        if(!windows[j].cue) {
          codable += windows[j].words;
        }
        ++j;
      }
      s.windowRange = [ptr, j];
      s.codableWords = codable;
      if(ctx.plainText !== undefined) {
        s.words = segCountWords(ctx.plainText.slice(s.start, s.end));
        s.openingQuestion = (ctx.infos && ptr < j && windows[ptr].firstOfTurn
          && windows[ptr].start >= s.start)
          ? segOpeningQuestionOf(null, windows[ptr], ctx.infos) : null;
      }
      ptr = ptr;
    }
    if(s.segId !== null && s.segId !== undefined && byId[s.segId]) {
      s.name = byId[s.segId].name;
    } else if(s.emergent) {
      s.name = s.emergent.name;
    } else if(guide) {
      s.name = segGettext('Unassigned');
    }
    s.label = segSectionLabel(s.name, s.openingQuestion);
  }
}


/*
 * Units
 */

// All codable sentences of every section, in document order. Every turn
// boundary and section start is a hard cut: a unit lives inside one turn's
// spoken content (so it never contains a speaker label). Backchannel-only
// and cue turns yield no sentences.
function segCollectSentences(sections, input, infos) {
  var turns = input.turns || [], plain = input.plainText, items = [];
  for(var si = 0; si < sections.length; ++si) {
    var sec = sections[si], pendingCut = true;
    var ti = Math.max(0, segTurnAt(turns, sec.start));
    for(; ti < turns.length && turns[ti].start < sec.end; ++ti) {
      var t = turns[ti], info = infos[ti];
      var a = Math.max(info.cs, sec.start), b = Math.min(t.end, sec.end);
      if(b <= a) {
        continue;
      }
      pendingCut = true;
      if(info.cue || info.backchannel) {
        continue;
      }
      var sents = (a === info.cs && b === t.end)
        ? info.sents : sugSplitSentences(plain.slice(a, b));
      for(var q = 0; q < sents.length; ++q) {
        items.push({
          start: a + sents[q].start, end: a + sents[q].end,
          text: sents[q].text, words: segCountWords(sents[q].text),
          sec: si, cut: pendingCut, turn: ti
        });
        pendingCut = false;
      }
    }
  }
  return items;
}

function segContinuityQuestion() {
  return {continuity: {
    type: 'choice',
    instructions: 'In an interview transcript, does the new sentence continue the same point as the passage before it, or start a new point?',
    criteria: {
      continues: 'the new sentence continues the same point as the passage before it',
      new_point: 'the new sentence starts a new point'
    }
  }};
}

function segContinuityState(label, lastSentences, sentence) {
  return 'Section: ' + label + '\n\nPassage so far: ' + lastSentences
    + '\n\nNew sentence: ' + sentence;
}

function segParseContinuity(answers) {
  return segAnswerProb(answers, 'continuity', 'new_point');
}

function segSmallTalkQuestion() {
  return {content: {
    type: 'choice',
    instructions: 'Is this passage of an interview substantive content worth coding, or small talk / logistics / pleasantries?',
    criteria: {
      substantive: 'substantive content worth coding',
      small_talk: 'small talk, logistics or pleasantries'
    }
  }};
}

function segSmallTalkState(label, text) {
  return 'Section: ' + label + '\n\nPassage: ' + segTrunc(text, 1500);
}

function segParseSmallTalk(answers) {
  return segAnswerProb(answers, 'content', 'small_talk');
}

// Distribution of cos(sentence, centroid of up to 3 preceding sentences of
// the same hard-cut run): the document's own scale for "same point".
function segSimilarityDistribution(items, vecs) {
  var D = [];
  for(var j = 1; j < items.length; ++j) {
    if(items[j].cut || items[j].sec !== items[j - 1].sec) {
      continue;
    }
    var sum = null;
    for(var p = j - 1; p >= Math.max(0, j - 3); --p) {
      if(items[p + 1].cut || items[p].sec !== items[j].sec) {
        break;
      }
      sum = segAddInto(sum, vecs[p]);
    }
    if(sum) {
      D.push(segCos(vecs[j], sum));
    }
  }
  return D;
}

// Continuity questions are rationed: only joins within SEG_AMBIGUOUS_IQR * IQR
// of the threshold, at most min(SEG_CONTINUITY_MAX, 5% of sentences) per run;
// beyond that the threshold alone decides.
var SEG_AMBIGUOUS_IQR = 0.1;
var SEG_CONTINUITY_MAX = 80;
var SEG_CONTINUITY_FRACTION = 0.05;

// Greedy cohesion cut, sequential because ambiguous cases may consult the
// decision model and the unit centroid depends on earlier answers.
function segGreedyUnits(items, vecs, sections, P, thr, iqr, deps) {
  var units = [], cur = null, nulls = 0, asked = 0;
  var cap = Math.min(SEG_CONTINUITY_MAX, Math.ceil(SEG_CONTINUITY_FRACTION * items.length));
  function startUnit(j) {
    cur = {i0: j, i1: j + 1, start: items[j].start, end: items[j].end,
           words: items[j].words, sum: segAddInto(null, vecs[j]), sec: items[j].sec};
    units.push(cur);
  }
  function join(j) {
    cur.i1 = j + 1;
    cur.end = items[j].end;
    cur.words += items[j].words;
    cur.sum = segAddInto(cur.sum, vecs[j]);
  }
  function loop(j) {
    while(j < items.length) {
      var it = items[j];
      if(!cur || it.cut || it.sec !== cur.sec) {
        startUnit(j);
        ++j;
        continue;
      }
      if(cur.words + it.words > P.unit_max_words) {
        startUnit(j);
        ++j;
        continue;
      }
      var c = segCos(vecs[j], cur.sum);
      var ambiguous = iqr > 0 && Math.abs(c - thr) < SEG_AMBIGUOUS_IQR * iqr;
      if(ambiguous && nulls < 3 && asked < cap && deps) {
        ++asked;
        var last = [];
        for(var q = Math.max(cur.i0, cur.i1 - 2); q < cur.i1; ++q) {
          last.push(items[q].text);
        }
        var state = segContinuityState(sections[it.sec].label, last.join(' '), it.text);
        return segDepDecide(deps, segContinuityQuestion(), state).then(
          function(jj, cc, answers) {
            var p = answers ? segParseContinuity(answers) : null;
            nulls = p === null ? nulls + 1 : 0;
            var cut = p !== null ? p >= 0.5 : cc < thr;
            if(cut) {
              startUnit(jj);
            } else {
              join(jj);
            }
            return loop(jj + 1);
          }.bind(null, j, c));
      }
      if(c < thr) {
        startUnit(j);
      } else {
        join(j);
      }
      ++j;
    }
    return Promise.resolve(units);
  }
  return loop(0);
}

// Merge units below the minimum into the more similar neighbour of the same
// section (never across a hard cut: that would swallow the interviewer's
// question), when the result stays within 1.25 * max.
function segMergeSmallUnits(units, items, P) {
  var limit = 1.25 * P.unit_max_words;
  var stuck = [];
  function canJoin(a, b) {
    return a.sec === b.sec && items[a.i0].turn === items[b.i0].turn
      && !items[b.i0].cut && a.words + b.words <= limit;
  }
  for(;;) {
    var pick = -1, w = Infinity, i;
    for(i = 0; i < units.length; ++i) {
      if(units[i].words < P.unit_min_words && !stuck[units[i].i0]
         && units[i].words < w) {
        pick = i;
        w = units[i].words;
      }
    }
    if(pick < 0) {
      break;
    }
    var u = units[pick];
    var prev = pick > 0 && canJoin(units[pick - 1], u) ? units[pick - 1] : null;
    var next = pick + 1 < units.length && canJoin(u, units[pick + 1]) ? units[pick + 1] : null;
    var target = null, before = false;
    if(prev && next) {
      before = segCos(u.sum, prev.sum) >= segCos(u.sum, next.sum);
    } else {
      before = !!prev;
    }
    target = before ? prev : next;
    if(!target) {
      stuck[u.i0] = true;
      continue;
    }
    if(before) {
      target.i1 = u.i1;
      target.end = u.end;
    } else {
      target.i0 = u.i0;
      target.start = u.start;
    }
    target.words += u.words;
    target.sum = segAddInto(target.sum.slice(), u.sum);
    units.splice(pick, 1);
  }
  return units;
}

// -> Promise<Unit[]> (array has `.dropped` = number of small-talk units; with
// a codebook the small-talk check is deferred to segProposeTags)
function segBuildUnits(sections, input, deps, infos) {
  var P = input.params || segParams();
  infos = infos || segTurnInfos(input);
  var items = segCollectSentences(sections, input, infos);
  if(!items.length) {
    var empty = [];
    empty.dropped = 0;
    return Promise.resolve(empty);
  }
  return Promise.resolve(deps.embed(items.map(function(it) {
    return it.text;
  }))).then(function(raw) {
    var vecs = [];
    for(var i = 0; i < items.length; ++i) {
      vecs.push(segVecNorm(raw[i]));
    }
    var D = segSimilarityDistribution(items, vecs);
    var thr = D.length ? segQuantile(D, P.tau) : -2;
    var iqr = D.length ? segQuantile(D, 0.75) - segQuantile(D, 0.25) : 0;
    return segGreedyUnits(items, vecs, sections, P, thr, iqr, deps);
  }).then(function(units) {
    segMergeSmallUnits(units, items, P);
    var out = [];
    for(var i = 0; i < units.length; ++i) {
      var u = units[i];
      out.push({
        id: '', sectionId: sections[u.sec].id, start: u.start, end: u.end,
        text: input.plainText.slice(u.start, u.end), words: u.words,
        vec: segVecNorm(u.sum), smallTalk: null, tags: []
      });
    }
    segProgress(deps, 'units', 0, out.length);
    if((input.tags || []).length) {
      // segProposeTags asks the small-talk question together with the tags
      // (one request per unit) and drops the small-talk units there
      out.forEach(function(u, i) {
        u.id = 'u' + i;
      });
      out.dropped = 0;
      return out;
    }
    return segBatched(out, 8, function(unit) {
      var sec = null;
      for(var s = 0; s < sections.length; ++s) {
        if(sections[s].id === unit.sectionId) {
          sec = sections[s];
          break;
        }
      }
      return segDepDecide(deps, segSmallTalkQuestion(),
                       segSmallTalkState(sec ? sec.label : '', unit.text))
        .then(function(ans) {
          unit.smallTalk = ans ? segParseSmallTalk(ans) : null;
        });
    }).then(function() {
      var kept = [];
      for(var q = 0; q < out.length; ++q) {
        if(out[q].smallTalk === null || out[q].smallTalk < 0.7) {
          out[q].id = 'u' + kept.length;
          kept.push(out[q]);
        }
      }
      kept.dropped = out.length - kept.length;
      return kept;
    });
  });
}


/*
 * Tags
 */

function segTagQuestion(tag, example) {
  var def = (tag.description && String(tag.description).trim()) || '(no definition)';
  var text = tag.path + ': ' + def;
  if(example) {
    text += '. Example: "' + segTrunc(example, 300) + '"';
  }
  return {
    type: 'choice',
    instructions: 'Does this qualitative code apply to the interview passage?',
    criteria: {applies: text, does_not_apply: 'the passage does not express this code'}
  };
}

function segTagState(sectionName, openingQuestion, unitText) {
  return 'Section: ' + sectionName + '\nOpening question: '
    + (openingQuestion || 'none') + '\n\nPassage:\n' + unitText;
}

// -> {tagId: p(applies)} for the tags present in the answers
function segParseTagAnswers(answers, tagIds) {
  var out = {};
  for(var i = 0; i < tagIds.length; ++i) {
    var p = segAnswerProb(answers, 't' + tagIds[i], 'applies');
    if(p !== null) {
      out[tagIds[i]] = p;
    }
  }
  return out;
}

function segSimConf(z) {
  return 1 / (1 + Math.exp(-3 * (z - 0.5)));
}

function segRound(v, d) {
  var m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

function segOverlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

// Candidates (top_k tags by similarity) for every unit
function segTagCandidates(units, sections, input, tagVecs, exVecs, exemplars, P) {
  var tags = input.tags || [];
  var cooc = input.tagSegmentCooc || {};
  var secById = {};
  for(var s = 0; s < sections.length; ++s) {
    secById[sections[s].id] = sections[s];
  }
  var tagIdx = {};
  for(var t = 0; t < tags.length; ++t) {
    tagIdx[tags[t].id] = t;
  }
  var all = [];
  for(var u = 0; u < units.length; ++u) {
    var unit = units[u];
    var best = [];
    for(t = 0; t < tags.length; ++t) {
      best.push({d: segCos(unit.vec, tagVecs[t]), e1: -Infinity, e2: -Infinity, ex: -1});
    }
    for(var e = 0; e < exemplars.length; ++e) {
      var ex = exemplars[e];
      if(ex.cStart !== undefined && ex.cEnd !== undefined && ex.docId === input.docId
         && segOverlaps(ex.cStart, ex.cEnd, unit.start, unit.end)) {
        continue; // the unit's own highlight must not vote for itself
      }
      var c = segCos(unit.vec, exVecs[e]);
      for(var q = 0; q < ex.tagIds.length; ++q) {
        var ti = tagIdx[ex.tagIds[q]];
        if(ti === undefined) {
          continue;
        }
        var b = best[ti];
        if(c > b.e1) {
          b.e2 = b.e1;
          b.e1 = c;
          b.ex = e;
        } else if(c > b.e2) {
          b.e2 = c;
        }
      }
    }
    var sec = secById[unit.sectionId];
    var cand = [];
    for(t = 0; t < tags.length; ++t) {
      var bb = best[t];
      var sc = bb.d;
      if(bb.e1 > -Infinity) {
        var em = bb.e2 > -Infinity ? (bb.e1 + bb.e2) / 2 : bb.e1;
        sc = Math.max(sc, em);
      }
      if(sec && sec.segId !== null && cooc[tags[t].id]
         && cooc[tags[t].id][sec.segId] > 0) {
        sc += 0.02;
      }
      cand.push({t: t, tag: tags[t], score: sc, ex: bb.ex});
    }
    cand.sort(function(a, b) {
      return (b.score - a.score) || (a.t - b.t);
    });
    cand = cand.slice(0, P.top_k);
    all.push(cand);
  }
  return all;
}

function segTagRecheckPrompt(sectionLabel, items) {
  var lines = [
    'You are checking qualitative codes for passages of an interview transcript.',
    'For each numbered passage, decide whether each listed code clearly applies.',
    'Section: ' + sectionLabel, ''
  ];
  for(var i = 0; i < items.length; ++i) {
    lines.push('Passage ' + items[i].unit + ':');
    lines.push(items[i].text);
    lines.push('Codes to check:');
    for(var t = 0; t < items[i].tags.length; ++t) {
      var tg = items[i].tags[t];
      lines.push('- tag ' + tg.id + ': ' + tg.path + ' — '
                 + (tg.description || '(no definition)'));
    }
    lines.push('');
  }
  lines.push('Reply with JSON only, in this exact shape:');
  lines.push('{"results":[{"unit": <passage number>, "tag": <tag number>, "applies": true|false}]}');
  return lines.join('\n');
}

function segParseTagRecheck(text) {
  var val = segParseLooseJson(text);
  var list = Array.isArray(val) ? val : (val && Array.isArray(val.results) ? val.results : null);
  if(!list) {
    return null;
  }
  var out = [];
  for(var i = 0; i < list.length; ++i) {
    var r = list[i];
    if(!r || typeof r !== 'object') {
      continue;
    }
    var unit = parseInt(r.unit, 10), tag = parseInt(r.tag, 10);
    var ap = r.applies;
    if(typeof ap === 'string') {
      ap = /^(true|yes|1)$/i.test(ap.trim()) ? true
        : (/^(false|no|0)$/i.test(ap.trim()) ? false : null);
    }
    if(isNaN(unit) || isNaN(tag) || typeof ap !== 'boolean') {
      continue;
    }
    out.push({unit: unit, tag: tag, applies: ap});
  }
  return out.length ? out : null;
}

// Band re-check: one bundled fast-LLM call per section (split above 15 units)
function segTagRecheck(units, sections, input, deps, P) {
  if(!deps || typeof deps.llm !== 'function') {
    return Promise.resolve();
  }
  var jobs = [], bySec = {}, s;
  for(s = 0; s < sections.length; ++s) {
    bySec[sections[s].id] = {sec: sections[s], units: []};
  }
  for(var u = 0; u < units.length; ++u) {
    var amb = units[u].tags.filter(function(t) {
      return t.source !== 'llm' && t.conf >= P.band_low && t.conf <= P.band_high;
    });
    if(amb.length && bySec[units[u].sectionId]) {
      bySec[units[u].sectionId].units.push({unit: units[u], tags: amb});
    }
  }
  var tagInfo = {};
  (input.tags || []).forEach(function(t) {
    tagInfo[t.id] = t;
  });
  for(var id in bySec) {
    var list = bySec[id].units;
    for(var i = 0; i < list.length; i += 15) {
      jobs.push({sec: bySec[id].sec, chunk: list.slice(i, i + 15)});
    }
  }
  return Promise.all(jobs.map(function(job) {
    var items = job.chunk.map(function(c, n) {
      return {unit: n + 1, text: c.unit.text, tags: c.tags.map(function(t) {
        return {id: t.id, path: t.name, description: (tagInfo[t.id] || {}).description};
      })};
    });
    var pairs = 0;
    items.forEach(function(it) {
      pairs += it.tags.length;
    });
    return segDepLLM(deps, segTagRecheckPrompt(job.sec.name, items),
                  Math.min(4000, 40 * pairs + 100)).then(function(txt) {
      var res = txt ? segParseTagRecheck(txt) : null;
      if(!res) {
        return;
      }
      res.forEach(function(r) {
        var c = job.chunk[r.unit - 1];
        if(!c) {
          return;
        }
        for(var q = 0; q < c.tags.length; ++q) {
          if(c.tags[q].id === r.tag) {
            c.tags[q].conf = r.applies ? 0.9 : 0.1;
            c.tags[q].source = 'llm';
          }
        }
      });
    });
  }));
}

// Sets unit.tags = [{id, name, conf, score, source}] sorted by conf desc
function segProposeTags(units, sections, input, deps) {
  var P = input.params || segParams();
  var tags = input.tags || [];
  if(!units.length || !tags.length) {
    units.forEach(function(u) {
      u.tags = [];
    });
    return Promise.resolve();
  }
  var exemplars = (input.exemplars || []).filter(function(e) {
    return e && e.text && e.tagIds && e.tagIds.length
      && !(input.excludeDocId !== null && input.excludeDocId !== undefined
           && e.docId === input.excludeDocId);
  });
  var defTexts = tags.map(function(t) {
    return t.path + '\n' + (t.description || '');
  });
  var secById = {};
  sections.forEach(function(s) {
    secById[s.id] = s;
  });
  var cands, zstat;
  return Promise.resolve(deps.embed(defTexts)).then(function(tv) {
    return exemplars.length
      ? Promise.resolve(deps.embed(exemplars.map(function(e) {
        return e.text;
      }))).then(function(ev) {
        return [tv, ev];
      }) : [tv, []];
  }).then(function(pair) {
    var tagVecs = pair[0].map(segVecNorm), exVecs = pair[1].map(segVecNorm);
    cands = segTagCandidates(units, sections, input, tagVecs, exVecs, exemplars, P);
    var scores = [];
    cands.forEach(function(row) {
      row.forEach(function(c) {
        scores.push(c.score);
      });
    });
    zstat = segMeanStd(scores);
    segProgress(deps, 'tags', 0, units.length);
    var done = 0;
    return segBatched(units, 8, function(unit, i) {
      var row = cands[i], sec = secById[unit.sectionId] || {name: '', openingQuestion: null};
      var questions = {content: segSmallTalkQuestion().content}, ids = [];
      row.forEach(function(c) {
        ids.push(c.tag.id);
        questions['t' + c.tag.id] = segTagQuestion(c.tag, c.ex >= 0 ? exemplars[c.ex].text : '');
      });
      return segDepDecide(deps, questions, segTagState(sec.name, sec.openingQuestion, unit.text))
        .then(function(ans) {
          var probs = ans ? segParseTagAnswers(ans, ids) : {};
          unit.smallTalk = ans ? segParseSmallTalk(ans) : null;
          unit.tags = row.map(function(c) {
            var p = probs[c.tag.id];
            var has = typeof p === 'number';
            return {
              id: c.tag.id, name: c.tag.path,
              conf: segRound(has ? p : segSimConf((c.score - zstat.mean) / zstat.std), 2),
              score: segRound(c.score, 4), source: has ? 's1' : 'sim'
            };
          });
          segProgress(deps, 'tags', ++done, units.length);
        });
    });
  }).then(function() {
    // drop small talk (answered together with the tags), keep the rest
    var kept = units.filter(function(u) {
      return u.smallTalk === null || u.smallTalk < 0.7;
    });
    units.dropped = (units.dropped || 0) + units.length - kept.length;
    units.length = 0;
    kept.forEach(function(u, i) {
      u.id = 'u' + i;
      units.push(u);
    });
    return segTagRecheck(units, sections, input, deps, P);
  }).then(function() {
    units.forEach(function(u) {
      var order = u.tags.map(function(t, i) {
        return {t: t, i: i};
      });
      order.sort(function(a, b) {
        return (b.t.conf - a.t.conf) || (b.t.score - a.t.score) || (a.i - b.i);
      });
      u.tags = order.map(function(o) {
        return o.t;
      });
    });
  });
}


/*
 * Prompts + tolerant parsers
 */

function segStripModelText(text) {
  var t = String(text === null || text === undefined ? '' : text);
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  var close = t.search(/<\/think>/i);
  if(close >= 0) {
    t = t.substring(close + 8);
  }
  t = t.replace(/<think>[\s\S]*$/i, '');
  t = t.replace(/```[a-zA-Z]*/g, '');
  return t.trim();
}

// End index of the JSON value starting at `start` (string-aware), or -1
function segBalancedEnd(t, start) {
  var depth = 0, inStr = false;
  for(var i = start; i < t.length; ++i) {
    var ch = t[i];
    if(inStr) {
      if(ch === '\\') {
        ++i;
      } else if(ch === '"') {
        inStr = false;
      }
    } else if(ch === '"') {
      inStr = true;
    } else if(ch === '{' || ch === '[') {
      ++depth;
    } else if(ch === '}' || ch === ']') {
      if(--depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function segTryParse(s) {
  try {
    return JSON.parse(s);
  } catch(e) {
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
    } catch(e2) {
      return undefined;
    }
  }
}

// First JSON object/array in a model reply, or null
function segParseLooseJson(text) {
  var t = segStripModelText(text);
  var m = /[\{\[]/.exec(t);
  if(!m) {
    return null;
  }
  var start = m.index, val;
  var end = segBalancedEnd(t, start);
  if(end >= 0) {
    val = segTryParse(t.substring(start, end + 1));
    if(val !== undefined) {
      return val;
    }
  }
  var last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if(last > start) {
    val = segTryParse(t.substring(start, last + 1));
    if(val !== undefined) {
      return val;
    }
  }
  return null;
}

function segStr(v, max) {
  if(typeof v !== 'string') {
    return '';
  }
  return segCollapse(v).substring(0, max);
}

function segEmergentPrompt(sectionText) {
  return [
    'The following excerpt of an interview transcript covers a subject that is not part of the interview guide.',
    'Propose an analytic segment for it. Reply with JSON only:',
    '{"name": "...", "description": "...", "question": "..."}',
    '- name: at most 6 words, analytic (a theme, not a quotation).',
    '- description: 1-2 sentences describing what the segment covers.',
    '- question: the question rephrased in the register of an interview script; generic, with no proper names or case details.',
    '',
    'Excerpt:',
    segTrunc(sectionText, 12000)
  ].join('\n');
}

function segParseEmergent(text) {
  var v = segParseLooseJson(text);
  if(!v || typeof v !== 'object' || Array.isArray(v)) {
    return null;
  }
  var name = segStr(v.name, 80);
  if(!name) {
    return null;
  }
  return {name: name, description: segStr(v.description, 400),
          question: segStr(v.question, 300)};
}

function segGuidePrompt(supportDocs, tags) {
  var lines = [
    'You are helping to structure the analysis of qualitative interviews.',
    'Below are the support documents of the study (typically the interview script). Derive the thematic SEGMENTS of the interview: the broad areas of the script.',
    '',
    'Rules:',
    '- Segments are ANALYTIC: broad areas of the interview, not a copy of the questions. Several questions can fall under one segment.',
    '- Follow-up and probe questions stay with their main question.',
    '- guide_questions quote the script\'s questions verbatim where possible.',
    '- name: at most 6 words. description: 1-3 sentences.',
    '- The codebook is given ONLY so that you do not confuse codes (fine-grained analytic labels applied to passages) with segments (broad areas of the interview). Segments must not just mirror the tags.',
    '',
    'Reply with JSON only, in this exact shape:',
    '{"segments":[{"name":"...","description":"...","guide_questions":["..."]}]}',
    ''
  ];
  (supportDocs || []).forEach(function(d) {
    lines.push('=== Support document: ' + (d.name || '') + (d.kind ? ' (' + d.kind + ')' : '') + ' ===');
    lines.push(d.contents || '');
    lines.push('');
  });
  if(tags && tags.length) {
    lines.push('=== Codebook (for reference only) ===');
    tags.forEach(function(t) {
      lines.push('- ' + t.path + (t.description ? ': ' + t.description : ''));
    });
  }
  return lines.join('\n');
}

function segParseGuide(text) {
  var v = segParseLooseJson(text);
  var list = Array.isArray(v) ? v : (v && Array.isArray(v.segments) ? v.segments : null);
  if(!list) {
    throw new Error('The model reply did not contain a list of segments.');
  }
  var out = [], byName = {};
  for(var i = 0; i < list.length && out.length < 100; ++i) {
    var s = list[i];
    if(!s || typeof s !== 'object') {
      continue;
    }
    var name = segStr(s.name, 120);
    if(!name) {
      continue;
    }
    var qs = s.guide_questions;
    if(typeof qs === 'string') {
      qs = [qs];
    }
    if(!Array.isArray(qs)) {
      qs = [];
    }
    var key = name.toLowerCase();
    var seg = byName[key];
    if(!seg) {
      seg = {name: name, description: segStr(s.description, 600), guide_questions: []};
      byName[key] = seg;
      out.push(seg);
    }
    for(var q = 0; q < qs.length; ++q) {
      var qt = segStr(qs[q], 500);
      if(qt && seg.guide_questions.indexOf(qt) === -1) {
        seg.guide_questions.push(qt);
      }
    }
  }
  if(!out.length) {
    throw new Error('The model reply did not contain any usable segment.');
  }
  return {segments: out};
}


/*
 * Evaluation + grid search
 */

// Sorted disjoint union of [start,end) intervals
function segUnion(ivs) {
  var a = ivs.filter(function(x) {
    return x.end > x.start;
  }).map(function(x) {
    return [x.start, x.end];
  }).sort(function(p, q) {
    return (p[0] - q[0]) || (p[1] - q[1]);
  });
  var out = [];
  for(var i = 0; i < a.length; ++i) {
    var last = out[out.length - 1];
    if(last && a[i][0] <= last[1]) {
      last[1] = Math.max(last[1], a[i][1]);
    } else {
      out.push([a[i][0], a[i][1]]);
    }
  }
  return out;
}

function segIvLength(u) {
  var s = 0;
  for(var i = 0; i < u.length; ++i) {
    s += u[i][1] - u[i][0];
  }
  return s;
}

// Overlap length of [s,e) with a sorted disjoint union
function segIvOverlap(u, s, e) {
  var lo = 0, hi = u.length - 1, first = u.length;
  while(lo <= hi) {
    var mid = (lo + hi) >> 1;
    if(u[mid][1] > s) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  var total = 0;
  for(var i = first; i < u.length && u[i][0] < e; ++i) {
    total += Math.max(0, Math.min(e, u[i][1]) - Math.max(s, u[i][0]));
  }
  return total;
}

function segIntersectLength(a, b) {
  var total = 0;
  for(var i = 0; i < a.length; ++i) {
    total += segIvOverlap(b, a[i][0], a[i][1]);
  }
  return total;
}

function segEvaluate(result, realHighlights, opts) {
  opts = opts || {};
  var units = (result.units || []).slice().sort(function(a, b) {
    return a.start - b.start;
  });
  var hls = realHighlights || [];
  var theta = opts.theta !== undefined ? opts.theta : segParams().theta;
  var uses = opts.tagUseCounts || {};
  var uUnion = segUnion(units), hUnion = segUnion(hls.map(function(h) {
    return {start: h.cStart, end: h.cEnd};
  }));
  var inter = segIntersectLength(uUnion, hUnion);
  var uLen = segIvLength(uUnion), hLen = segIvLength(hUnion);
  var i, covered = 0, valid = 0;
  for(i = 0; i < hls.length; ++i) {
    var len = hls[i].cEnd - hls[i].cStart;
    if(len <= 0) {
      continue;
    }
    ++valid;
    if(segIvOverlap(uUnion, hls[i].cStart, hls[i].cEnd) >= 0.5 * len) {
      ++covered;
    }
  }
  function overlappingUnits(s, e) {
    var lo = 0, hi = units.length - 1, first = units.length;
    // units are sorted by start; scan back a little for long units
    while(lo <= hi) {
      var mid = (lo + hi) >> 1;
      if(units[mid].end > s) {
        first = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    var out = [];
    for(var q = first; q < units.length && units[q].start < e; ++q) {
      if(units[q].end > s) {
        out.push(units[q]);
      }
    }
    return out;
  }
  // hit@k
  var hits = {1: 0, 3: 0, 5: 0}, denom = 0, tagPairs = 0, tagTicked = 0;
  for(i = 0; i < hls.length; ++i) {
    var elig = (hls[i].tagIds || []).filter(function(t) {
      return (uses[t] || 0) >= 2;
    });
    if(!elig.length) {
      continue;
    }
    ++denom;
    var cand = overlappingUnits(hls[i].cStart, hls[i].cEnd), best = null, bo = 0;
    for(var c = 0; c < cand.length; ++c) {
      var o = Math.min(cand[c].end, hls[i].cEnd) - Math.max(cand[c].start, hls[i].cStart);
      if(o > bo) {
        bo = o;
        best = cand[c];
      }
    }
    if(!best) {
      continue;
    }
    elig.forEach(function(t) {
      ++tagPairs;
      for(var q = 0; q < (best.tags || []).length; ++q) {
        if(best.tags[q].id === t && best.tags[q].conf >= theta) {
          ++tagTicked;
          break;
        }
      }
    });
    [1, 3, 5].forEach(function(k) {
      var top = (best.tags || []).slice(0, k);
      for(var q = 0; q < top.length; ++q) {
        if(elig.indexOf(top[q].id) !== -1) {
          ++hits[k];
          return;
        }
      }
    });
  }
  // IoU >= 0.5 matching (units are disjoint, so a plain scan is enough)
  var iouHl = 0, iouU = 0;
  for(i = 0; i < hls.length; ++i) {
    var hl = hls[i], hlen = hl.cEnd - hl.cStart;
    if(hlen <= 0) {
      continue;
    }
    var cu = overlappingUnits(hl.cStart, hl.cEnd);
    for(var q2 = 0; q2 < cu.length; ++q2) {
      var o2 = Math.min(cu[q2].end, hl.cEnd) - Math.max(cu[q2].start, hl.cStart);
      if(o2 / (hlen + (cu[q2].end - cu[q2].start) - o2) >= 0.5) {
        ++iouHl;
        break;
      }
    }
  }
  for(i = 0; i < units.length; ++i) {
    var ul = units[i].end - units[i].start;
    var oh = overlappingHighlightsOf(hls, units[i]);
    for(var q3 = 0; q3 < oh.length; ++q3) {
      if(oh[q3].o / (ul + (oh[q3].hl.cEnd - oh[q3].hl.cStart) - oh[q3].o) >= 0.5) {
        ++iouU;
        break;
      }
    }
  }
  var iouRecall = valid ? iouHl / valid : 0;
  var iouPrecision = units.length ? iouU / units.length : 0;
  // precision of the ticked (conf >= theta) tags
  var ticked = 0, right = 0;
  for(i = 0; i < units.length; ++i) {
    var u = units[i], ulen = u.end - u.start;
    var near = {}, any = false;
    overlappingUnits(u.start, u.end);
    var ov = overlappingHighlightsOf(hls, u);
    for(var h = 0; h < ov.length; ++h) {
      if(ov[h].o >= 0.25 * ulen) {
        any = true;
        (ov[h].hl.tagIds || []).forEach(function(t) {
          near[t] = true;
        });
      }
    }
    (u.tags || []).forEach(function(t) {
      if(t.conf >= theta) {
        ++ticked;
        if(any && near[t.id]) {
          ++right;
        }
      }
    });
  }
  var sizes = units.map(function(x) {
    return x.words;
  });
  var cov = result.coverage || {present: [], missing: []};
  var tP = ticked ? right / ticked : 0, tR = tagPairs ? tagTicked / tagPairs : 0;
  var out = {
    unitRecall: valid ? covered / valid : 0,
    charRecall: hLen ? inter / hLen : 0,
    charPrecision: uLen ? inter / uLen : 0,
    sizeMedian: segQuantile(sizes, 0.5), sizeQ1: segQuantile(sizes, 0.25),
    sizeQ3: segQuantile(sizes, 0.75),
    hitAt: {1: denom ? hits[1] / denom : 0, 3: denom ? hits[3] / denom : 0,
            5: denom ? hits[5] / denom : 0},
    iouRecall: iouRecall, iouPrecision: iouPrecision,
    iouF1: iouRecall + iouPrecision ? 2 * iouRecall * iouPrecision / (iouRecall + iouPrecision) : 0,
    thetaPrecision: ticked ? right / ticked : 0, nTicked: ticked,
    thetaRecall: tagPairs ? tagTicked / tagPairs : 0,
    thetaF1: 0,
    sections: (result.sections || []).length,
    otherWordsPct: result.stats ? (result.stats.otherWordsPct || 0) : 0,
    coveragePresent: cov.present.length, coverageMissing: cov.missing.length,
    nUnits: units.length, nHighlights: hls.length
  };
  out.thetaF1 = tP + tR ? 2 * tP * tR / (tP + tR) : 0;
  // headline metrics: precision of the ticked tags, text coverage of the
  // highlights, and their harmonic mean
  out.precision = out.thetaPrecision;
  out.recall = out.charRecall;
  out.f1 = out.precision + out.recall ? 2 * out.precision * out.recall / (out.precision + out.recall) : 0;
  return out;
}

// Highlights overlapping a unit, with overlap length (linear in highlights
// per unit is fine: highlights number in the hundreds)
function overlappingHighlightsOf(hls, unit) {
  var out = [];
  for(var i = 0; i < hls.length; ++i) {
    var o = Math.min(unit.end, hls[i].cEnd) - Math.max(unit.start, hls[i].cStart);
    if(o > 0) {
      out.push({hl: hls[i], o: o});
    }
  }
  return out;
}

// runFn(paramsOverride) -> Promise<metrics>. Theta never changes the units,
// so each (tau, kappa, lambda) is run once; other thetas are re-scored with
// `metrics.rescore(theta)` when the runner supplies it (else re-run).
function segGridSearch(runFn, grid, progress) {
  grid = grid || {};
  var g = {
    tau: grid.tau || [0.15, 0.25, 0.35], kappa: grid.kappa || [0.1, 0.2],
    lambda: grid.lambda || [1, 2, 3], theta: grid.theta || [0.5, 0.6, 0.7]
  };
  var combos = [];
  g.tau.forEach(function(tau) {
    g.kappa.forEach(function(kappa) {
      g.lambda.forEach(function(lambda) {
        combos.push({tau: tau, kappa: kappa, lambda: lambda});
      });
    });
  });
  var rows = [];
  function next(i) {
    if(i >= combos.length) {
      return Promise.resolve();
    }
    var base = combos[i];
    var first = {tau: base.tau, kappa: base.kappa, lambda: base.lambda, theta: g.theta[0]};
    return Promise.resolve(runFn(first)).then(function(m0) {
      rows.push({params: first, metrics: m0});
      var rest = g.theta.slice(1);
      return segBatched(rest, 1, function(th) {
        var p = {tau: base.tau, kappa: base.kappa, lambda: base.lambda, theta: th};
        if(m0 && typeof m0.rescore === 'function') {
          return Promise.resolve(m0.rescore(th)).then(function(m) {
            rows.push({params: p, metrics: m});
          });
        }
        return Promise.resolve(runFn(p)).then(function(m) {
          rows.push({params: p, metrics: m});
        });
      });
    }).then(function() {
      if(progress) {
        progress(i + 1, combos.length);
      }
      return next(i + 1);
    });
  }
  return next(0).then(function() {
    // best = highest metrics.f1 (harmonic mean of tick precision and text
    // recall) over ALL rows; ties go to the earliest row in grid order.
    var best = null;
    rows.forEach(function(r) {
      var f = r.metrics && typeof r.metrics.f1 === 'number' ? r.metrics.f1 : 0;
      var bf = best && best.metrics && typeof best.metrics.f1 === 'number' ? best.metrics.f1 : 0;
      if(!best || f > bf + 1e-12) {
        best = r;
      }
    });
    return {best: best, rows: rows};
  });
}


/*
 * Pipeline
 */

function segSplitVecs(raw, nW, nP, nQ) {
  var all = [];
  for(var i = 0; i < raw.length; ++i) {
    all.push(raw[i]);
  }
  return {w: all.slice(0, nW), p: all.slice(nW, nW + nP), q: all.slice(nW + nP, nW + nP + nQ)};
}

function segLastCueText(windows, w, infos) {
  for(var i = w - 1; i >= 0; --i) {
    if(windows[i].cue && windows[i].substantive && windows[i].firstOfTurn) {
      return infos[windows[i].turnIdx].text;
    }
  }
  return '';
}

function segTieBreak(windows, vecs, protos, input, deps, infos, params) {
  var guide = input.guide || [];
  var G = guide.length;
  var E = segEmissions(windows, vecs, protos, params);
  var amb = G ? segAmbiguous(E, windows) : [];
  var decisions = {}, answered = 0;
  segProgress(deps, 'decide', 0, amb.length);
  return segBatched(amb, 8, function(a) {
    var w = a.w;
    var top = segTopSegments(E[w], G, 3).map(function(k) {
      return guide[k];
    });
    var state = segWindowState(windows[w], segLastCueText(windows, w, infos),
                               w > 0 ? windows[w - 1].text : '');
    return segDepDecide(deps, segWindowQuestion(top), state).then(function(ans) {
      var parsed = ans ? segParseWindowAnswer(ans, guide) : null;
      if(parsed) {
        decisions[w] = parsed;
        ++answered;
      }
    });
  }).then(function() {
    return {decisions: decisions, ambiguous: amb.length, answered: answered};
  });
}

function segFindSection(sections, id) {
  for(var i = 0; i < sections.length; ++i) {
    if(sections[i].id === id) {
      return sections[i];
    }
  }
  return null;
}

function segOtherPct(sections) {
  var other = 0, total = 0;
  sections.forEach(function(s) {
    total += s.codableWords;
    if(s.emergent) {
      other += s.codableWords;
    }
  });
  return total ? segRound(100 * other / total, 1) : 0;
}

// Windows -> embeddings -> labels -> sections (+ manual, emergent proposals)
function segRunSections(input, deps) {
  var params = input.params || segParams();
  input = Object.create(input);
  input.params = params;
  var guide = input.guide || [];
  var infos = segTurnInfos(input);
  var windows = segBuildWindows(input, infos);
  var gt = segGuideTexts(guide);
  var texts = windows.map(function(w) {
    return w.text;
  }).concat(gt.protoTexts, gt.qTexts);
  segProgress(deps, 'embed', 0, texts.length);
  var state = {};
  return Promise.resolve(texts.length ? deps.embed(texts) : []).then(function(raw) {
    var sp = segSplitVecs(raw, windows.length, gt.protoTexts.length, gt.qTexts.length);
    state.vecs = sp.w.map(function(v) {
      return segVecNorm(v);
    });
    state.protos = segBuildProtos(guide, sp.p, sp.q, gt.qIndex, input.segPrototypeExtras);
    return segTieBreak(windows, state.vecs, state.protos, input, deps, infos, params);
  }).then(function(tb) {
    var labels = segLabel(windows, state.vecs, state.protos, params, tb.decisions);
    var sections = segBuildSections(windows, labels, input, state.vecs, state.protos, infos);
    sections = segApplyManual(sections, input.turns || [], input.manual, {
      guide: guide, windows: windows, plainText: input.plainText, infos: infos});
    var emergent = sections.filter(function(s) {
      return s.emergent && !s.manual;
    });
    segProgress(deps, 'emergent', 0, emergent.length);
    return Promise.all(emergent.map(function(s) {
      return segDepLLM(deps, segEmergentPrompt(input.plainText.slice(s.start, s.end)), 500)
        .then(function(txt) {
          var p = txt ? segParseEmergent(txt) : null;
          if(p) {
            s.emergent.name = p.name;
            s.emergent.description = p.description;
            s.emergent.question = p.question;
            s.emergent.proposed = true;
            s.name = p.name;
            s.label = segSectionLabel(s.name, s.openingQuestion);
          }
        });
    })).then(function() {
      var coverage = segCoverage(sections, guide);
      return {
        windows: windows, vecs: state.vecs, protos: state.protos, labels: labels,
        sections: sections, coverage: coverage, guideVecs: state.protos.P, infos: infos,
        units: [],
        stats: {
          windows: windows.length, ambiguousWindows: tb.ambiguous,
          decisions: tb.answered, sections: sections.length,
          emergent: sections.filter(function(s) {
            return !!s.emergent;
          }).length,
          otherWordsPct: segOtherPct(sections), units: 0, droppedSmallTalk: 0,
          segments: guide.length
        }
      };
    });
  });
}

// Units + tags on top of a segRunSections result (re-runnable when only
// tau / theta / top_k / unit sizes change)
function segRunUnits(sr, input, deps) {
  var params = input.params || segParams();
  input = Object.create(input);
  input.params = params;
  var infos = sr.infos || segTurnInfos(input);
  return segBuildUnits(sr.sections, input, deps, infos).then(function(units) {
    return segProposeTags(units, sr.sections, input, deps).then(function() {
      var stats = {};
      for(var k in sr.stats) {
        stats[k] = sr.stats[k];
      }
      stats.units = units.length;
      stats.droppedSmallTalk = units.dropped || 0;
      return {
        windows: sr.windows, labels: sr.labels, sections: sr.sections,
        units: units, coverage: sr.coverage, stats: stats,
        guideVecs: sr.guideVecs, protos: sr.protos, vecs: sr.vecs, infos: infos
      };
    });
  });
}

function segRunAll(input, deps) {
  return segRunSections(input, deps).then(function(sr) {
    return segRunUnits(sr, input, deps);
  });
}


/*
 * Self-test
 */

var SEG_TEST_VOCAB = {
  A: ['factory', 'salary', 'overtime', 'manager', 'shift', 'contract', 'employer', 'wages', 'colleagues', 'promotion'],
  B: ['hospital', 'doctor', 'medicine', 'illness', 'clinic', 'surgery', 'pain', 'nurse', 'treatment', 'insurance'],
  C: ['apartment', 'rent', 'landlord', 'neighbourhood', 'mortgage', 'eviction', 'heating', 'kitchen', 'roommates', 'lease'],
  D: ['football', 'stadium', 'tournament', 'goalkeeper', 'referee', 'supporters', 'league', 'striker', 'penalty', 'coach']
};

// Answer of ~4 sentences (about 50 words) built on one vocabulary
function segTestAnswer(voc, n, sentences) {
  var out = [];
  for(var s = 0; s < (sentences || 4); ++s) {
    var w = [];
    for(var j = 0; j < 4; ++j) {
      w.push(voc[(n * 3 + s * 2 + j) % voc.length]);
    }
    out.push('When it was the ' + w[0] + ' and the ' + w[1] + ', we had the '
             + w[2] + ' with the ' + w[3] + '.');
  }
  return out.join(' ');
}

function segTestQuestion(voc, n) {
  return 'Can you tell me more about the ' + voc[n % 10] + ' and the '
    + voc[(n + 4) % 10] + ' that you mentioned?';
}

// lines = [{sp:'I'|'P'|null, text}] -> {plainText, turns}
function segTestDoc(lines) {
  var plain = '', turns = [];
  lines.forEach(function(l, i) {
    var label = l.sp === 'I' ? 'Interviewer: ' : (l.sp === 'P' ? 'Participant: ' : '');
    var start = plain.length;
    plain += label + l.text;
    turns.push({start: start, end: plain.length, text: plain.slice(start),
                contentStart: start + label.length,
                speaker: l.sp === 'I' ? 'I' : (l.sp === 'P' ? 'P' : null)});
    if(i < lines.length - 1) {
      plain += '\n';
    }
  });
  return {plainText: plain, turns: turns};
}

function segTestGuide() {
  var names = {A: 'Work', B: 'Health', C: 'Housing'};
  var ids = {A: 11, B: 12, C: 13};
  return ['A', 'B', 'C'].map(function(k, i) {
    var v = SEG_TEST_VOCAB[k];
    return {id: ids[k], position: i, name: names[k],
            description: v.join(' '), source: 'test',
            guide_questions: [segTestQuestion(v, 0), segTestQuestion(v, 2)]};
  });
}

// plan = [['A', 3], ['B', 3], ...] -> doc with Q/A pairs
function segTestInterview(plan, opts) {
  opts = opts || {};
  var lines = [], n = 0;
  plan.forEach(function(p) {
    for(var i = 0; i < p[1]; ++i) {
      var v = SEG_TEST_VOCAB[p[0]];
      lines.push({sp: opts.noSpeakers ? null : 'I', text: segTestQuestion(v, n)});
      if(opts.backchannels && i === 0) {
        lines.push({sp: opts.noSpeakers ? null : 'I', text: 'Mm-hm.'});
      }
      lines.push({sp: opts.noSpeakers ? null : 'P', text: segTestAnswer(v, n)});
      ++n;
    }
  });
  var doc = segTestDoc(lines);
  doc.speakers = opts.noSpeakers ? [] : [
    {id: 'I', name: 'Interviewer', include: false},
    {id: 'P', name: 'Participant', include: true}];
  return doc;
}

function segTestInput(doc, over) {
  var input = {
    plainText: doc.plainText, turns: doc.turns, speakers: doc.speakers,
    guide: segTestGuide(),
    params: segParams({section_min_words: 100, emergent_min_words: 150,
                       kappa: 0.3, lambda: 2}),
    tags: [], exemplars: [], docId: 1, excludeDocId: null,
    segPrototypeExtras: null, tagSegmentCooc: null, manual: null
  };
  for(var k in over || {}) {
    input[k] = over[k];
  }
  return input;
}

function segTestDeps(over) {
  var deps = {
    embed: function(texts) {
      return segFakeEmbed(texts, 256);
    },
    decide: function() {
      return Promise.resolve(null);
    },
    llm: function() {
      return Promise.resolve(null);
    }
  };
  for(var k in over || {}) {
    deps[k] = over[k];
  }
  return deps;
}

function segSelfTest() {
  var failures = 0, count = 0;
  function assert(cond, msg) {
    ++count;
    if(!cond) {
      console.error('SEG SELFTEST FAIL:', msg);
      ++failures;
    }
  }
  function near(a, b, eps) {
    return Math.abs(a - b) <= (eps || 1e-9);
  }
  function segIds(res) {
    return res.sections.map(function(s) {
      return s.segId === null ? 'e' : s.segId;
    });
  }
  function tiles(res) {
    var secs = res.sections, ok = secs.length > 0 && secs[0].start === 0
      && secs[secs.length - 1].end === res.plainLength;
    for(var i = 1; i < secs.length; ++i) {
      ok = ok && secs[i].start === secs[i - 1].end && secs[i].end > secs[i].start;
    }
    return ok;
  }

  var tests = [];

  // params
  tests.push(function() {
    var d = segParamDefaults();
    assert(d.tau === 0.25 && d.lambda === 2 && d.unit_max_words === 150, 'param defaults');
    var p = segParams({tau: 5, top_k: -3, kappa: 'x', unit_min_words: 190, unit_max_words: 100});
    assert(p.tau === 0.9 && p.top_k === 1 && p.kappa === 0.15, 'param clamping / non-numbers ignored');
    assert(p.unit_min_words < p.unit_max_words, 'unit_min < unit_max');
    var q = segParams({band_low: 0.8, band_high: 0.3});
    assert(q.band_low <= q.band_high, 'band ordering');
    var g = (function() {
      return this;
    })();
    var old = g.taguConfig, oldSave = g.taguConfigSave, saved = null;
    g.taguConfig = function() {
      return {segmentation_params: {tau: 0.5, window_max_words: 999}};
    };
    g.taguConfigSave = function(cfg) {
      saved = cfg;
    };
    try {
      var s = segParams();
      assert(s.tau === 0.5 && s.window_max_words === 400, 'overrides from stored config, clamped');
      assert(segParams({tau: 0.1}).tau === 0.1, 'explicit overrides win');
      var diff = segSaveParams({tau: 0.25, theta: 0.8});
      assert(diff.theta === 0.8 && diff.tau === undefined && saved
             && saved.segmentation_params.theta === 0.8, 'segSaveParams stores only changed keys');
    } finally {
      g.taguConfig = old;
      g.taguConfigSave = oldSave;
      if(old === undefined) {
        delete g.taguConfig;
      }
      if(oldSave === undefined) {
        delete g.taguConfigSave;
      }
    }
  });

  // windows
  tests.push(function() {
    var long = segTestAnswer(SEG_TEST_VOCAB.A, 1, 12);
    var doc = segTestDoc([{sp: 'I', text: segTestQuestion(SEG_TEST_VOCAB.A, 0)},
                          {sp: 'P', text: long}, {sp: 'P', text: 'Yeah.'},
                          {sp: 'I', text: 'Okay.'}]);
    var input = segTestInput(doc, {speakers: [{id: 'I', name: 'I', include: false},
                                              {id: 'P', name: 'P', include: true}]});
    input.params = segParams({window_max_words: 60});
    var ws = segBuildWindows(input);
    var pw = ws.filter(function(w) {
      return !w.cue;
    });
    var total = 0;
    pw.forEach(function(w) {
      total += w.words;
    });
    assert(pw.length >= 2 && pw.every(function(w) {
      return w.words <= 60;
    }), 'long turn split into windows <= max');
    var mx = Math.max.apply(null, pw.map(function(w) {
      return w.words;
    })), mn = Math.min.apply(null, pw.map(function(w) {
      return w.words;
    }));
    assert(mx - mn <= 15, 'windows balanced');
    assert(ws.every(function(w) {
      return w.turnIdx < 2;
    }), 'backchannel turns produce no window');
    assert(ws[0].cue && ws[0].substantive && ws[0].weight === 1.5 && ws[0].firstOfTurn, 'substantive cue window');
    assert(pw[0].weight === 1 && pw[0].firstOfTurn && !pw[1].firstOfTurn, 'content weight / firstOfTurn');
    assert(total > 100, 'window words counted');
    var ns = segTestInput(doc, {speakers: []});
    var wn = segBuildWindows(ns);
    assert(wn.every(function(w) {
      return !w.cue;
    }) && wn.length === ws.length, 'no speakers -> all content');
    assert(segBuildWindows(segTestInput(segTestDoc([{sp: null, text: 'Hello there my friend, how are you today?'}]), {speakers: []})).length === 1,
           'single-turn doc');
    assert(segBuildWindows(segTestInput(segTestDoc([{sp: null, text: ''}]), {speakers: []})).length === 0, 'empty doc has no windows');
  });

  // Viterbi / sections on the synthetic interview
  var plan = [['A', 3], ['B', 3], ['C', 3], ['D', 3], ['A', 2]];
  var doc = segTestInterview(plan);
  var baseInput = segTestInput(doc);
  var baseRes = null;

  tests.push(function() {
    return segRunSections(baseInput, segTestDeps()).then(function(res) {
      baseRes = res;
      res.plainLength = doc.plainText.length;
      assert(segIds(res).join() === '11,12,13,e,11', 'sections follow segments incl. tangent and return: ' + segIds(res).join());
      assert(tiles(res), 'sections tile the whole text');
      var emer = res.sections[3];
      assert(emer.emergent && emer.emergent.key === 'e1' && emer.emergent.name === 'Emergent 1', 'emergent section named Emergent 1');
      assert(res.sections[0].openingQuestion && res.sections[0].openingQuestion.indexOf('Can you tell me') === 0,
             'opening question extracted');
      assert(res.sections[0].label.indexOf('Work — “Can you') === 0, 'label format');
      assert(res.sections[4].segId === 11 && res.sections[0].segId === 11, 'segment 1 appears twice');
      assert(res.coverage.present.length === 3 && res.coverage.missing.length === 0, 'coverage');
      assert(res.stats.emergent === 1 && res.stats.otherWordsPct > 10, 'stats other pct');
      return segRunSections(segTestInput(doc, {params: segParams({section_min_words: 100,
        emergent_min_words: 150, kappa: 0.3, lambda: 0.25})}), segTestDeps());
    }).then(function(lo) {
      return segRunSections(segTestInput(doc, {params: segParams({section_min_words: 0,
        emergent_min_words: 0, kappa: 0.3, lambda: 0.25})}), segTestDeps()).then(function(lo0) {
        return segRunSections(segTestInput(doc, {params: segParams({section_min_words: 0,
          emergent_min_words: 0, kappa: 0.3, lambda: 10})}), segTestDeps()).then(function(hi0) {
          assert(hi0.sections.length <= lo0.sections.length, 'higher lambda -> fewer sections');
          assert(lo.sections.length >= 5, 'low lambda keeps sections');
        });
      });
    }).then(function() {
      return segRunSections(segTestInput(doc, {params: segParams({section_min_words: 0,
        emergent_min_words: 0, kappa: 0.05, lambda: 1})}), segTestDeps()).then(function(a) {
        return segRunSections(segTestInput(doc, {params: segParams({section_min_words: 0,
          emergent_min_words: 0, kappa: 0.8, lambda: 1})}), segTestDeps()).then(function(b) {
          assert(b.stats.otherWordsPct >= a.stats.otherWordsPct && b.stats.otherWordsPct > 0,
                 'high kappa -> more other (' + a.stats.otherWordsPct + ' vs ' + b.stats.otherWordsPct + ')');
        });
      });
    });
  });

  // short tangent absorbed; long tangent emergent; G = 0; no speakers; single turn
  tests.push(function() {
    var d2 = segTestInterview([['A', 3], ['B', 3], ['D', 1], ['C', 3]]);
    return segRunSections(segTestInput(d2), segTestDeps()).then(function(r) {
      assert(r.sections.every(function(s) {
        return !s.emergent;
      }), 'short other run absorbed (' + segIds(r).join() + ')');
      assert(r.sections.every(function(s) {
        return s.codableWords >= 100;
      }), 'absorption below section_min_words');
      r.plainLength = d2.plainText.length;
      assert(tiles(r), 'tiling after absorption');
      return segRunSections(segTestInput(doc, {guide: []}), segTestDeps());
    }).then(function(r) {
      assert(r.sections.length === 1 && r.sections[0].segId === null && !r.sections[0].emergent
             && r.sections[0].start === 0 && r.sections[0].end === doc.plainText.length, 'empty guide -> one section');
      assert(r.coverage.present.length === 0, 'empty guide coverage');
      var ns = segTestInterview(plan, {noSpeakers: true});
      return segRunSections(segTestInput(ns), segTestDeps());
    }).then(function(r) {
      assert(r.sections.length >= 3, 'no speakers still segments (' + r.sections.length + ')');
      var one = segTestDoc([{sp: null, text: segTestAnswer(SEG_TEST_VOCAB.A, 0)}]);
      return segRunAll(segTestInput(one, {speakers: []}), segTestDeps());
    }).then(function(r) {
      assert(r.sections.length === 1 && r.units.length >= 1, 'single-turn doc end to end');
      return segRunSections(segTestInput(doc, {}), segTestDeps({
        embed: function(t) {
          return segFakeEmbed(t, 256, true);
        }}));
    }).then(function(r) {
      assert(segIds(r).join() === '11,12,13,e,11', 'Float32Array embeddings');
      return segRunSections(segTestInput(doc, {}), segTestDeps({
        embed: function(t) {
          return Promise.resolve(t.map(function() {
            return new Array(8).fill(0);
          }));
        }}));
    }).then(function(r) {
      assert(r.sections.length >= 1, 'zero vectors do not crash');
    });
  });

  // decision tie-break
  tests.push(function() {
    var d3 = segTestInterview([['A', 2], ['B', 2]]);
    var inp = segTestInput(d3, {params: segParams({section_min_words: 0,
      emergent_min_words: 0, kappa: 0.3, lambda: 2})});
    var asked = 0;
    return segRunSections(inp, segTestDeps()).then(function(plain) {
      return segRunSections(inp, segTestDeps({decide: function() {
        return Promise.resolve(null);
      }})).then(function(nul) {
        assert(JSON.stringify(nul.labels) === JSON.stringify(plain.labels), 'decide null leaves labels identical');
        // ambiguous: build one by hand through the emissions API
        var win = plain.windows, protos = plain.protos;
        var E = segEmissions(win, plain.vecs, protos, inp.params);
        var amb = segAmbiguous(E, win);
        assert(Array.isArray(amb), 'ambiguous list');
        // force the decision for the first content window onto `other`
        var w0 = 0;
        while(win[w0].cue) {
          ++w0;
        }
        var forced = {};
        var G = inp.guide.length;
        forced[w0] = {probs: {}};
        forced[w0].probs[G] = 1;
        forced[w0].probs[0] = 0;
        var changed = segLabel(win, plain.vecs, protos, inp.params, forced);
        var unchanged = segLabel(win, plain.vecs, protos, inp.params, null);
        assert(JSON.stringify(unchanged) === JSON.stringify(plain.labels), 'segLabel without decisions matches pipeline');
        var strong = {};
        win.forEach(function(w, i) {
          if(!w.cue) {
            strong[i] = {probs: {}};
            strong[i].probs[G] = 1;
            strong[i].probs[0] = 0;
            strong[i].probs[1] = 0;
          }
        });
        var all = segLabel(win, plain.vecs, protos, inp.params, strong);
        assert(all.some(function(l) {
          return l === G;
        }) && JSON.stringify(all) !== JSON.stringify(plain.labels), 'forced decisions change labels');
        assert(changed.length === win.length, 'labels per window');
      });
    }).then(function() {
      var q = segWindowQuestion([{id: 3, name: 'N', description: 'D'}]);
      assert(q.segment.criteria.s3 === 'N: D' && q.segment.criteria.other_topic, 'window question shape');
      var parsed = segParseWindowAnswer({segment: {choice: 's11', probabilities: {s11: 0.7, other_topic: 0.3, bogus: 1}}}, segTestGuide());
      assert(parsed && parsed.probs[0] === 0.7 && parsed.probs[3] === 0.3 && parsed.probs.bogus === undefined, 'window answer parser');
      assert(segParseWindowAnswer(null, segTestGuide()) === null, 'window answer null');
      var st = segWindowState({text: 'abc'}, 'Q?', '');
      assert(st === 'Interviewer\'s latest question: Q?\n\nPassage: abc', 'window state format');
      // end-to-end: a decide that is always called does not break; counts asked windows
      return segRunSections(inp, segTestDeps({decide: function(qs) {
        ++asked;
        return Promise.resolve({segment: {choice: 'other_topic', probabilities: {other_topic: 1}}});
      }})).then(function(r) {
        assert(r.stats.decisions === r.stats.ambiguousWindows && r.stats.ambiguousWindows === asked, 'decide asked once per ambiguous window');
      });
    });
  });

  // manual inheritance
  tests.push(function() {
    var sections = baseRes.sections;
    var turns = doc.turns;
    var ctx = {guide: baseInput.guide, windows: baseRes.windows, plainText: doc.plainText, infos: baseRes.infos};
    var mid = turns[3]; // an interviewee turn inside section 0
    var manual = {assign: {}, starts: [segTurnKey(mid)]};
    var out = segApplyManual(sections, turns, manual, ctx);
    assert(out.length === sections.length + 1, 'manual start splits a section');
    assert(out.some(function(s) {
      return s.start === mid.start && s.manual;
    }), 'split at the turn start');
    manual.assign[segTurnKey(mid)] = {segId: 13, emergentKey: null};
    out = segApplyManual(sections, turns, manual, ctx);
    var piece = out.filter(function(s) {
      return s.start === mid.start;
    })[0];
    assert(piece.segId === 13 && piece.name === 'Housing' && piece.manual, 'assignment applied');
    var changed = turns.map(function(t, i) {
      return i === 3 ? {start: t.start, end: t.end, text: t.text + ' edited', contentStart: t.contentStart, speaker: t.speaker} : t;
    });
    out = segApplyManual(sections, changed, manual, ctx);
    assert(out.length === sections.length, 'edits dropped when the turn text changed');
    out = segApplyManual(sections, turns, null, ctx);
    assert(out === sections, 'no manual edits -> unchanged');
    var tl = out.length && out[out.length - 1].end === doc.plainText.length;
    assert(tl, 'tiling kept');
    // inheritance end to end
    return segRunSections(segTestInput(doc, {manual: {assign: (function() {
      var a = {};
      a[segTurnKey(turns[0])] = {segId: 12, emergentKey: null};
      return a;
    })(), starts: []}}), segTestDeps()).then(function(r) {
      assert(r.sections[0].segId === 12 && r.sections[0].manual, 'pipeline applies manual assignment');
    });
  });

  // units
  tests.push(function() {
    var res = baseRes;
    return segBuildUnits(res.sections, baseInput, segTestDeps()).then(function(units) {
      assert(units.length > 0, 'units built');
      var ok = true, secOk = true;
      units.forEach(function(u) {
        var s = segFindSection(res.sections, u.sectionId);
        secOk = secOk && s && u.start >= s.start && u.end <= s.end;
        ok = ok && u.words <= baseInput.params.unit_max_words * 1.25 && u.text === doc.plainText.slice(u.start, u.end);
        ok = ok && u.text.indexOf('Interviewer:') === -1;
      });
      assert(secOk, 'units inside sections');
      assert(units.every(function(u) {
        return doc.turns.every(function(t) {
          return u.end <= t.start || u.start >= t.contentStart;
        }) && doc.turns.filter(function(t) {
          return u.start >= t.contentStart && u.end <= t.end;
        }).length === 1;
      }), 'units never contain a turn label nor span turns');
      assert(ok, 'unit text excludes interviewer questions, sizes respect max');
      // one unit per answer (hard cut at each question)
      var answers = doc.turns.filter(function(t) {
        return t.speaker === 'P';
      }).length;
      assert(units.length >= answers, 'cut at every substantive interviewer turn (' + units.length + ' >= ' + answers + ')');
      assert(units[0].vec.length === 256 && near(Math.sqrt(units[0].vec.reduce(function(a, b) {
        return a + b * b;
      }, 0)), 1, 1e-6), 'unit vec normalized');
      // word limits from params
      var small = segTestInput(doc, {params: segParams({unit_max_words: 20, unit_min_words: 5, section_min_words: 100, emergent_min_words: 150, kappa: 0.3})});
      return segBuildUnits(res.sections, small, segTestDeps()).then(function(u2) {
        assert(u2.length > units.length, 'smaller unit_max_words -> more units');
        assert(u2.every(function(u) {
          return u.words <= 25 || u.words === 20 || u.words <= 1.25 * 20;
        }) , 'max words respected (single sentences may exceed)');
      });
    }).then(function() {
      // backchannel turns yield no units and (like every turn boundary) cut
      var d = segTestInterview([['A', 2]], {backchannels: true});
      var r0 = {sections: [{id: 's0', start: 0, end: d.plainText.length, label: 'L', name: 'L'}]};
      var inp = segTestInput(d);
      return segBuildUnits(r0.sections, inp, segTestDeps()).then(function(u) {
        assert(u.every(function(x) {
          return x.text.indexOf('Mm-hm') === -1;
        }), 'backchannel turns never become units');
        assert(u.length === 2, 'backchannel does not add units (' + u.length + ')');
      });
    }).then(function() {
      // inline labels: labelEnd is respected, units never span a turn and
      // never contain a label; small units are not merged across turns
      var plain = '', turns = [], labels = [];
      for(var k = 0; k < 4; ++k) {
        var lab = k === 1 ? '0:38 - Huw Evans: ' : 'Huw: ';
        var st = plain.length;
        plain += lab + segTestAnswer(SEG_TEST_VOCAB.A, k, 2);
        turns.push({start: st, end: plain.length, text: plain.slice(st),
                    contentStart: st, labelEnd: st + lab.length, speaker: 'P'});
        labels.push([st, st + lab.length]);
        plain += '\n';
      }
      var d = {plainText: plain, turns: turns,
               speakers: [{id: 'P', name: 'Huw', include: true}]};
      var secs = [{id: 's0', start: 0, end: plain.length, label: 'L', name: 'L'}];
      var inp = segTestInput(d, {params: segParams({tau: 0.9, unit_min_words: 60, unit_max_words: 300})});
      return segBuildUnits(secs, inp, segTestDeps()).then(function(u) {
        assert(u.length >= turns.length, 'no merging across turns (' + u.length + ' units)');
        var clean = u.every(function(x) {
          return labels.every(function(l) {
            return x.end <= l[0] || x.start >= l[1];
          });
        });
        assert(clean, 'no unit intersects a speaker label');
        var oneTurn = u.every(function(x) {
          return turns.filter(function(t) {
            return x.start >= t.start && x.end <= t.end;
          }).length === 1;
        });
        assert(oneTurn, 'every unit lies inside a single turn');
        assert(u.every(function(x) {
          return /^[A-Za-z]/.test(x.text) && x.text.indexOf('Huw') === -1;
        }), 'unit text starts at spoken content');
      });
    }).then(function() {
      // short units merged: two short same-point sentences in one answer
      var d = segTestDoc([{sp: null, text: segTestAnswer(SEG_TEST_VOCAB.B, 0, 6)}]);
      var secs = [{id: 's0', start: 0, end: d.plainText.length, label: 'L', name: 'L'}];
      var inp = segTestInput(d, {speakers: [], params: segParams({tau: 0.9, unit_min_words: 30, unit_max_words: 150})});
      return segBuildUnits(secs, inp, segTestDeps()).then(function(u) {
        assert(u.length >= 1 && u.every(function(x) {
          return x.words >= 30 || u.length === 1;
        }), 'short units merged (' + u.map(function(x) {
          return x.words;
        }).join() + ')');
      });
    }).then(function() {
      // small talk dropped at p >= 0.7 and continuity null leaves threshold decision
      var calls = 0;
      var deps = segTestDeps({decide: function(qs) {
        if(qs.content) {
          ++calls;
          return Promise.resolve({content: {choice: 'small_talk', probabilities: {small_talk: calls === 1 ? 0.9 : 0.5, substantive: 0.1}}});
        }
        return Promise.resolve(null);
      }});
      return segBuildUnits(baseRes.sections, baseInput, deps).then(function(u) {
        assert(u.dropped === 1, 'small talk >= 0.7 dropped');
        assert(u.some(function(x) {
          return x.smallTalk === 0.5;
        }), 'smallTalk probability kept below threshold');
      });
    });
  });

  // continuity questions are rationed: cap and narrow band
  tests.push(function() {
    var items = [], vecs = [], n = 400;
    for(var i = 0; i < n; ++i) {
      items.push({text: 's' + i, words: 3, start: i * 4, end: i * 4 + 3, sec: 0, cut: false});
      var a = (i * 0.37) % 3.1416;
      vecs.push(segVecNorm([Math.cos(a), Math.sin(a)]));
    }
    var secs = [{label: 'L'}];
    var P = segParams({unit_max_words: 100000});
    var asked = 0;
    var deps = {decide: function() {
      ++asked;
      return Promise.resolve({continuity: {choice: 'continues', probabilities: {continues: 0.8, new_point: 0.2}}});
    }};
    function run(iqr) {
      asked = 0;
      return segGreedyUnits(items, vecs, secs, P, 0.5, iqr, deps).then(function() {
        return asked;
      });
    }
    var saved = [SEG_CONTINUITY_MAX, SEG_CONTINUITY_FRACTION];
    return run(2).then(function(capped) {
      assert(capped === Math.ceil(0.05 * n), 'continuity cap respected (' + capped + ')');
      SEG_CONTINUITY_MAX = 1e9;
      SEG_CONTINUITY_FRACTION = 1;
      return run(2).then(function(wide) {
        return run(0.4).then(function(narrow) {
          SEG_CONTINUITY_MAX = saved[0];
          SEG_CONTINUITY_FRACTION = saved[1];
          assert(wide > capped && narrow < wide, 'narrower band -> fewer questions (' + narrow + ' < ' + wide + ')');
        });
      });
    }).then(null, function(e) {
      SEG_CONTINUITY_MAX = saved[0];
      SEG_CONTINUITY_FRACTION = saved[1];
      throw e;
    });
  });

  // tags
  tests.push(function() {
    var unitsDoc = baseInput;
    var tags = [{id: 1, path: 'Work', description: 'factory salary overtime manager'},
                {id: 2, path: 'Health', description: 'hospital doctor medicine illness'},
                {id: 3, path: 'Sports', description: ''},
                {id: 4, path: 'Housing', description: 'apartment rent landlord'}];
    var exemplars = [
      {tagIds: [1], text: 'The factory salary and overtime were decided by the manager.', docId: 5, hlId: 1},
      {tagIds: [1], text: 'Another factory shift with wages and colleagues.', docId: 6, hlId: 2},
      {tagIds: [2], text: 'The hospital doctor gave medicine for the illness.', docId: 5, hlId: 3},
      {tagIds: [2], text: 'excluded doctor hospital clinic surgery', docId: 99, hlId: 4}
    ];
    var inp = segTestInput(doc, {tags: tags, exemplars: exemplars, excludeDocId: 99,
      params: segParams({section_min_words: 100, emergent_min_words: 150, kappa: 0.3, top_k: 2})});
    var embedded = [];
    var deps = segTestDeps({embed: function(t) {
      embedded.push(t);
      return segFakeEmbed(t, 256);
    }});
    return segRunAll(inp, deps).then(function(res) {
      var u0 = res.units[0];
      assert(u0.tags.length === 2, 'top_k limits tags');
      assert(u0.tags[0].name === 'Work' && u0.tags[0].source === 'sim', 'work unit ranks Work first, sim fallback (' + JSON.stringify(u0.tags) + ')');
      assert(res.units.every(function(u) {
        for(var i = 1; i < u.tags.length; ++i) {
          if(u.tags[i].conf > u.tags[i - 1].conf) {
            return false;
          }
        }
        return true;
      }), 'tags sorted by conf desc');
      var flat = [];
      embedded.forEach(function(a) {
        flat = flat.concat(a);
      });
      assert(!flat.some(function(t) {
        return t.indexOf('excluded doctor') === 0;
      }), 'excludeDocId exemplars never embedded');
      assert(u0.tags[0].conf >= 0 && u0.tags[0].conf <= 1 && u0.tags[0].conf === segRound(u0.tags[0].conf, 2), 'conf rounded 0..1');
      // s1 decisions
      var secs = res.sections, units = res.units.slice(0, 2).map(function(u) {
        var c = {};
        for(var k in u) {
          c[k] = u[k];
        }
        return c;
      });
      var deps1 = segTestDeps({decide: function(qs) {
        var out = {};
        Object.keys(qs).forEach(function(k) {
          out[k] = {choice: 'applies', probabilities: {applies: k === 't1' ? 0.95 : 0.2, does_not_apply: 0.05}};
        });
        return Promise.resolve(out);
      }});
      return segProposeTags(units, secs, inp, deps1).then(function() {
        var t1 = units[0].tags.filter(function(t) {
          return t.id === 1;
        })[0];
        assert(t1 && t1.conf === 0.95 && t1.source === 's1', 's1 confidence from decide');
        assert(units[0].tags[0].id === 1, 'sorted by s1 conf');
        // band recheck
        var llmCalls = 0;
        var deps2 = segTestDeps({
          decide: function(qs) {
            var out = {};
            Object.keys(qs).forEach(function(k) {
              out[k] = {probabilities: {applies: 0.5}};
            });
            return Promise.resolve(out);
          },
          llm: function(prompt) {
            ++llmCalls;
            return Promise.resolve('<think>x</think>```json\n{"results":[{"unit":1,"tag":1,"applies":true},{"unit":1,"tag":2,"applies":false}]}\n```');
          }});
        var u2 = res.units.slice(0, 1).map(function(u) {
          var c = {};
          for(var k in u) {
            c[k] = u[k];
          }
          return c;
        });
        return segProposeTags(u2, secs, inp, deps2).then(function() {
          var a = u2[0].tags.filter(function(t) {
            return t.id === 1;
          })[0], b = u2[0].tags.filter(function(t) {
            return t.id === 2;
          })[0];
          assert(llmCalls === 1 && a && a.conf === 0.9 && a.source === 'llm', 'band recheck applies true -> 0.9');
          assert(b && b.conf === 0.1 && b.source === 'llm', 'band recheck applies false -> 0.1');
          assert(u2[0].tags[0].id === 1, 'resorted after recheck');
        });
      }).then(function() {
        // cooc bonus + exclusion of own highlight
        var u3 = [{id: 'u0', sectionId: secs[0].id, start: 0, end: 50, text: 'x', words: 5, vec: segVecNorm(new Array(256).fill(0).map(function(_, i) {
          return i === 0 ? 1 : 0;
        })), tags: []}];
        var vecs = [segVecNorm(u3[0].vec), segVecNorm(u3[0].vec)];
        var candA = segTagCandidates(u3, [secs[0]], {tags: [tags[0]], tagSegmentCooc: null, docId: 1}, [new Array(256).fill(0)], [], [], {top_k: 1});
        var candB = segTagCandidates(u3, [secs[0]], {tags: [tags[0]], tagSegmentCooc: {1: {11: 2}}, docId: 1}, [new Array(256).fill(0)], [], [], {top_k: 1});
        assert(near(candB[0][0].score - candA[0][0].score, 0.02), 'cooc bonus 0.02');
        var ex = [{tagIds: [1], text: 't', docId: 1, cStart: 10, cEnd: 20}];
        var withEx = segTagCandidates(u3, [secs[0]], {tags: [tags[0]], docId: 1}, [new Array(256).fill(0)], [vecs[0]], ex, {top_k: 1});
        assert(withEx[0][0].score === 0 && withEx[0][0].ex === -1, 'exemplar overlapping the unit is excluded');
        u3[0].start = 30;
        var noOv = segTagCandidates(u3, [secs[0]], {tags: [tags[0]], docId: 1}, [new Array(256).fill(0)], [vecs[0]], ex, {top_k: 1});
        assert(near(noOv[0][0].score, 1), 'non-overlapping exemplar votes');
        // no tags / no exemplars
        var u4 = [{id: 'u0', sectionId: 's', start: 0, end: 5, text: 'a b', words: 2, vec: [1, 0], tags: [1]}];
        return segProposeTags(u4, [], segTestInput(doc, {tags: []}), segTestDeps()).then(function() {
          assert(u4[0].tags.length === 0, 'no tags -> empty tags');
        });
      });
    });
  });

  // parsers
  tests.push(function() {
    var g = segParseGuide('<think>hmm {not json}</think>\n```json\n{"segments":[{"name":" Work ","description":"d","guide_questions":["q1","q1","q2"]},{"name":"work","guide_questions":["q3"]},{"name":"","description":"x"},{"description":"no name"}]} \nThanks!');
    assert(g.segments.length === 1 && g.segments[0].name === 'Work' && g.segments[0].guide_questions.join() === 'q1,q2,q3', 'guide: think/fences/trailing text/dedupe');
    var arr = segParseGuide('[{"name":"A","description":"x","guide_questions":["a?"]},{"name":"B"}]');
    assert(arr.segments.length === 2 && arr.segments[1].guide_questions.length === 0 && arr.segments[1].description === '', 'guide: top-level array, missing fields');
    var thrown = 0;
    try {
      segParseGuide('');
    } catch(e) {
      ++thrown;
    }
    try {
      segParseGuide('{"segments":[]}');
    } catch(e) {
      ++thrown;
    }
    try {
      segParseGuide('no json here');
    } catch(e) {
      ++thrown;
    }
    assert(thrown === 3, 'guide: empty/unusable throws');
    assert(segParseGuide('{"segments":[{"name":"A","guide_questions":["x"],}],}').segments.length === 1, 'guide: trailing commas');
    var many = [];
    for(var i = 0; i < 150; ++i) {
      many.push({name: 'S' + i});
    }
    assert(segParseGuide(JSON.stringify(many)).segments.length === 100, 'guide capped at 100');
    var em = segParseEmergent('Sure!\n```\n{"name":"Football fandom","description":"Talk about sport.","question":"What do you do in your free time?"} trailing {oops}');
    assert(em && em.name === 'Football fandom' && em.question.indexOf('free time') > 0, 'emergent parse tolerant');
    assert(segParseEmergent('') === null && segParseEmergent('{"name":""}') === null && segParseEmergent('{"description":"x"}') === null && segParseEmergent('[1]') === null, 'emergent null cases');
    var long = segParseEmergent(JSON.stringify({name: new Array(200).join('a'), description: 'x'}));
    assert(long && long.name.length <= 80 && long.question === '', 'emergent limits / defaults');
    var rc = segParseTagRecheck('<think>a</think>{"results":[{"unit":1,"tag":"7","applies":"yes"},{"unit":2,"tag":8,"applies":false},{"unit":"x"}]}');
    assert(rc && rc.length === 2 && rc[0].tag === 7 && rc[0].applies === true && rc[1].applies === false, 'recheck parse');
    assert(segParseTagRecheck('') === null && segParseTagRecheck('{"results":[]}') === null && segParseTagRecheck('[{"unit":1,"tag":2,"applies":true}]').length === 1, 'recheck null / top-level array');
    var gp = segGuidePrompt([{name: 'script.txt', kind: 'script', contents: 'Q1: Tell me about work.'}], [{path: 'Work', description: 'jobs'}]);
    assert(gp.indexOf('Tell me about work') > 0 && gp.indexOf('Codebook') > 0 && gp.indexOf('"segments"') > 0, 'guide prompt content');
    assert(segEmergentPrompt(new Array(20000).join('x')).length < 13000, 'emergent prompt truncates section text');
    assert(segTagRecheckPrompt('Sec', [{unit: 1, text: 'abc', tags: [{id: 4, path: 'P', description: ''}]}]).indexOf('tag 4') > 0, 'recheck prompt');
    var tq = segTagQuestion({path: 'P', description: ''}, 'ex');
    assert(tq.criteria.applies === 'P: (no definition). Example: "ex"', 'tag question text');
    assert(segSmallTalkQuestion().content.criteria.small_talk && segContinuityQuestion().continuity.criteria.new_point, 'question builders');
    assert(segParseSmallTalk({content: {probabilities: {small_talk: 0.8}}}) === 0.8 && segParseContinuity({}) === null, 'answer parsers');
    // emergent proposals in the pipeline
    return segRunSections(baseInput, segTestDeps({llm: function() {
      return Promise.resolve('{"name":"Football","description":"Sports talk.","question":"Do you follow sports?"}');
    }})).then(function(r) {
      var e = r.sections[3];
      assert(e.emergent.proposed && e.emergent.name === 'Football' && e.label.indexOf('Football') === 0, 'emergent proposal applied');
    });
  });

  // dedup
  tests.push(function() {
    var guide = segTestGuide();
    return segFakeEmbed(guide.map(segGuideProtoText), 256).then(function(gv) {
      var a = gv[1].slice();
      var hit = segSimilarSegment(a, guide, gv, 0.85);
      assert(hit && hit.segId === 12 && hit.cos > 0.99, 'similar segment found');
      assert(segSimilarSegment(gv[0], [guide[1]], [gv[1]], 0.85) === null, 'dissimilar -> null');
      assert(segSimilarSegment(new Array(256).fill(0), guide, gv) === null, 'zero vector -> null');
    });
  });

  // evaluation
  tests.push(function() {
    var res = {
      units: [
        {start: 0, end: 100, words: 20, tags: [{id: 1, conf: 0.9}, {id: 2, conf: 0.5}]},
        {start: 100, end: 200, words: 30, tags: [{id: 2, conf: 0.8}, {id: 1, conf: 0.3}]},
        {start: 300, end: 400, words: 50, tags: [{id: 1, conf: 0.7}]}
      ],
      sections: [{}, {}], coverage: {present: [1, 2], missing: [3]}, stats: {otherWordsPct: 12}
    };
    var hl = [{id: 1, cStart: 10, cEnd: 60, tagIds: [1]}, {id: 2, cStart: 150, cEnd: 250, tagIds: [1, 2]},
              {id: 3, cStart: 500, cEnd: 550, tagIds: [3]}];
    var m = segEvaluate(res, hl, {tagUseCounts: {1: 3, 2: 1, 3: 1}, theta: 0.6});
    assert(near(m.unitRecall, 2 / 3), 'unitRecall');
    assert(near(m.charRecall, 0.5) && near(m.charPrecision, 1 / 3), 'char recall/precision');
    assert(m.sizeMedian === 30 && m.sizeQ1 === 25 && m.sizeQ3 === 40, 'size quartiles');
    assert(near(m.hitAt[1], 0.5) && m.hitAt[3] === 1 && m.hitAt[5] === 1, 'hit@k');
    assert(near(m.thetaPrecision, 2 / 3) && m.nTicked === 3, 'thetaPrecision');
    assert(m.sections === 2 && m.otherWordsPct === 12 && m.coveragePresent === 2 && m.coverageMissing === 1
           && m.nUnits === 3 && m.nHighlights === 3, 'evaluation counts');
    var m2 = segEvaluate(res, hl, {tagUseCounts: {}, theta: 0.85});
    assert(m2.nTicked === 1 && m2.thetaPrecision === 1 && m2.hitAt[1] === 0, 'theta re-score, no eligible tags');
    var e = segEvaluate({units: []}, [], {});
    assert(e.unitRecall === 0 && e.nUnits === 0 && e.sizeMedian === 0, 'empty evaluation');

    assert(near(m.precision, m.thetaPrecision) && near(m.recall, m.charRecall)
           && near(m.f1, 2 * m.precision * m.recall / (m.precision + m.recall)), 'precision/recall/f1');
    assert(e.f1 === 0 && e.precision === 0 && e.recall === 0, 'empty evaluation f1 = 0');

    var runs = 0;
    function metricsFor(p) {
      var f1 = (p.tau === 0.25 ? 0.6 : 0.4) + (p.kappa === 0.2 ? 0.05 : 0) + (p.theta === 0.7 ? 0.1 : 0);
      var mm = {f1: f1};
      mm.rescore = function(th) {
        return {f1: f1 - (p.theta === 0.7 ? 0.1 : 0) + (th === 0.7 ? 0.1 : 0)};
      };
      return mm;
    }
    return segGridSearch(function(p) {
      ++runs;
      return Promise.resolve(metricsFor(p));
    }, null).then(function(g) {
      assert(g.best.params.tau === 0.25 && g.best.params.kappa === 0.2 && g.best.params.lambda === 1
             && g.best.params.theta === 0.7 && g.fallback === undefined,
             'grid best by f1 over all rows, ties in grid order ' + JSON.stringify(g.best.params));
      assert(runs === 18 && g.rows.length === 54, 'theta-only re-scoring avoids re-runs (' + runs + ' runs)');
      var runs2 = 0;
      return segGridSearch(function(p) {
        ++runs2;
        return Promise.resolve({f1: p.lambda === 2 ? 0.9 : 0.4});
      }, {tau: [0.25], kappa: [0.1], lambda: [1, 2], theta: [0.5, 0.6]}).then(function(g2) {
        assert(g2.best.params.lambda === 2 && g2.best.params.theta === 0.5, 'tie -> earliest row');
        assert(runs2 === 4, 'no rescore -> re-run per theta');
      });
    });
  });

  // IoU / theta-recall metrics, mid-turn switch cost, ambiguous cap, merged request
  tests.push(function() {
    var units = [{start: 0, end: 100, words: 20, tags: [{id: 1, conf: 0.7}]},
                 {start: 100, end: 300, words: 40, tags: []}];
    var hl = [{id: 1, cStart: 0, cEnd: 80, tagIds: [1]}, {id: 2, cStart: 150, cEnd: 210, tagIds: [1]}];
    var m = segEvaluate({units: units}, hl, {tagUseCounts: {1: 2}, theta: 0.6});
    assert(near(m.iouRecall, 0.5) && near(m.iouPrecision, 0.5) && near(m.iouF1, 0.5), 'IoU recall/precision/F1');
    assert(near(m.thetaRecall, 0.5) && near(m.thetaPrecision, 1) && near(m.thetaF1, 2 / 3), 'theta recall/F1');
    var win = function(first) {
      return {cue: false, substantive: false, firstOfTurn: first, weight: 1};
    };
    var E = [[1, -5], [0, 1.2]];
    assert(segViterbi(E, [win(true), win(false)], {lambda: 1}).join() === '0,0', 'mid-turn switch costs 1.5 lambda');
    assert(segViterbi(E, [win(true), win(true)], {lambda: 1}).join() === '0,1', 'turn-start switch costs lambda');
    function many(n) {
      var w = [], e = [];
      for(var i = 0; i < n; ++i) {
        w.push(win(true));
        e.push([0, 0, 0]);
      }
      return segAmbiguous(e, w).length;
    }
    assert(many(1000) === 120 && many(100) === 20, 'ambiguous cap = min(120, 20% of content windows)');
    var doc = segTestDoc([{sp: 'I', text: segTestQuestion(SEG_TEST_VOCAB.A, 0)},
                          {sp: 'P', text: segTestAnswer(SEG_TEST_VOCAB.A, 0)}]);
    var inp = segTestInput(doc, {speakers: [{id: 'I', name: 'I', include: false}, {id: 'P', name: 'P', include: true}],
      tags: [{id: 1, path: 'Work', description: 'jobs'}]});
    var reqs = [];
    return segRunAll(inp, segTestDeps({decide: function(qs) {
      reqs.push(Object.keys(qs));
      return Promise.resolve(qs.content ? {content: {choice: 'small_talk', probabilities: {small_talk: 0.9, substantive: 0.1}}} : null);
    }})).then(function(res) {
      var withContent = reqs.filter(function(k) {
        return k.indexOf('content') >= 0;
      });
      assert(withContent.length > 0 && withContent.every(function(k) {
        return k.indexOf('t1') >= 0;
      }), 'small-talk question rides with the tag question');
      assert(res.units.length === 0 && res.stats.droppedSmallTalk > 0, 'small-talk units dropped after the merged request');
      var reqs2 = [];
      return segRunAll(segTestInput(doc, {speakers: inp.speakers, tags: []}), segTestDeps({decide: function(qs) {
        reqs2.push(Object.keys(qs));
        return Promise.resolve(null);
      }})).then(function() {
        assert(reqs2.some(function(k) {
          return k.length === 1 && k[0] === 'content';
        }), 'standalone small-talk question without a codebook');
      });
    });
  });

  // end to end
  tests.push(function() {
    var tags = [{id: 1, path: 'Work', description: 'factory salary'}, {id: 2, path: 'Health', description: 'hospital'}];
    var inp = segTestInput(doc, {tags: tags, exemplars: [{tagIds: [1], text: 'factory wages', docId: 3, hlId: 1}]});
    var progress = [];
    return segRunAll(inp, segTestDeps({progress: function(s) {
      progress.push(s);
    }})).then(function(res) {
      assert(res.windows.length > 0 && res.labels.length === res.windows.length, 'windows/labels shapes');
      assert(res.units.length > 0 && res.stats.units === res.units.length && res.stats.sections === res.sections.length, 'stats consistent');
      var ids = {};
      res.sections.forEach(function(s) {
        ids[s.id] = s;
      });
      assert(res.units.every(function(u) {
        var s = ids[u.sectionId];
        return s && u.start >= s.start && u.end <= s.end;
      }), 'units inside sections');
      assert(res.units.every(function(u) {
        return u.tags.length === 2 && u.tags.every(function(t, i) {
          return i === 0 || u.tags[i - 1].conf >= t.conf;
        });
      }), 'unit.tags sorted by conf desc');
      assert(progress.indexOf('embed') >= 0 && progress.indexOf('tags') >= 0, 'progress reported');
      return segRunUnits(Object.assign({}, res), segTestInput(doc, {tags: tags, params: segParams({tau: 0.8, section_min_words: 100, emergent_min_words: 150, kappa: 0.3})}), segTestDeps());
    }).then(function(r2) {
      assert(r2.units.length > 0 && r2.sections.length === baseRes.sections.length, 'segRunUnits re-runs units only');
      // performance sanity: ~220 turns / 20k words
      var big = [], plan2 = [];
      for(var i = 0; i < 40; ++i) {
        plan2.push([['A', 'B', 'C', 'D'][i % 4], 3]);
      }
      var bd = segTestInterview(plan2);
      var t0 = Date.now();
      return segRunSections(segTestInput(bd), segTestDeps()).then(function(r) {
        assert(r.sections.length >= 4, 'large document sections');
        assert(Date.now() - t0 < 15000, 'large document runs quickly (' + (Date.now() - t0) + ' ms)');
      });
    });
  });

  function run(i) {
    if(i >= tests.length) {
      return Promise.resolve();
    }
    var r;
    try {
      r = tests[i]();
    } catch(e) {
      assert(false, 'test ' + i + ' threw: ' + (e && e.stack || e));
      return run(i + 1);
    }
    return Promise.resolve(r).then(null, function(e) {
      assert(false, 'test ' + i + ' rejected: ' + (e && e.stack || e));
    }).then(function() {
      return run(i + 1);
    });
  }
  return run(0).then(function() {
    if(failures === 0) {
      console.log('SEG SELFTEST OK (' + count + ' assertions)');
    } else {
      console.log('SEG SELFTEST: ' + failures + ' failure(s)');
    }
    return failures;
  });
}
