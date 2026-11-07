/*
 * Thematic segments UI: panels, persistence, session orchestration (see
 * THEMATIC_SEGMENTS_PLAN.md).
 *
 * - State and small pure helpers
 * - Persistence (IndexedDB)
 * - Session hooks + analysis orchestration (called by suggest.js)
 * - Manual edits (pure helpers + commit)
 * - Sections panel and separators
 * - Emergent segments confirmation + prototype recording
 * - Script & segments modal
 * - Evaluation panel (settings, Segmentation tab)
 * - Wiring
 * - Self-test
 *
 * Nothing here touches the DOM at load time except registering listeners
 * (guarded by typeof document). All user / model text goes through
 * textContent; strings go through gettext().
 */


/*
 * State and small pure helpers
 */

var SEG_UI_RECORD_TIMEOUT = 5000;  // ms: wait for the saved record at most this long
var SEG_UI_EXEMPLAR_TTL = 60000;   // ms: refetch exemplars at most this often

var SEG_UI = {
  doc: null,           // state of the open document, see segUiNewDoc()
  gen: 0,              // run generation: bumped whenever the inputs of an async
                       // run change (session start/end, rebuild, manual edits,
                       // guide/params changes, a new analysis result); see
                       // segUiToken()
  unitsSeq: 0,         // latest-wins counter among units-only refreshes
  active: 0,           // analysis/evaluation runs in flight (AI breakers)
  indexChain: null,    // serialises the 'seg|index' read-modify-write
  recomputeTimer: null,
  cacheToken: 0,
  resultCache: {},     // docId -> {key, result, savedAt, unitOverrides}
  resultTimer: null,   // debounce of the IndexedDB write of the result cache
  resultDirty: {},     // docIds whose cached result is not yet in IndexedDB
  resultLogged: false,
  version: 0,          // bumped whenever doc.result changes
  exemplars: null,
  exemplarsAt: 0,
  extrasRaw: null,     // {embKey, protos, cooc}
  running: null,       // {key, promise}
  busy: false,
  splitting: null,     // section id awaiting a click in the text
  drag: null,
  keyCounter: 0,
  wired: false,
  script: {rows: [], dirty: false, docs: [], index: {}, open: false,
           busy: false, generating: false, allowClose: false},
  emergent: {proceed: null, groups: [], working: false},
  evalState: {metrics: null, grid: null, running: false},
  evalSections: null
};

function segUiNewDoc(docId, textHash) {
  return {
    docId: docId, textHash: textHash || null, speakersHash: null,
    sections: null, manual: segUiEmptyManual(), emergent: {},
    result: null, resultKey: null, unitOverrides: null
  };
}

function segUiEmptyManual() {
  return {assign: {}, starts: []};
}

/*
 * Run generation. Every async producer (analysis, units refresh, section
 * refinement, evaluation) captures segUiToken() before its first await and
 * drops its result when segUiTokenOk() is false afterwards: the session or
 * the transcript changed (sug_session / editGen) or SEG_UI.gen was bumped
 * (segUiInvalidate). Units-only refreshes additionally use SEG_UI.unitsSeq so
 * that the latest request wins.
 */
function segUiToken() {
  return {sess: sug_session || null,
          edit: sug_session ? (sug_session.editGen || 0) : 0,
          gen: SEG_UI.gen};
}

function segUiTokenOk(tok) {
  return !!tok.sess && sug_session === tok.sess
    && (tok.sess.editGen || 0) === tok.edit && SEG_UI.gen === tok.gen;
}

function segUiInvalidate() {
  ++SEG_UI.gen;
}

function segUiStaleError() {
  var e = new Error(gettext('The suggestion session has ended.'));
  e.stale = true;
  return e;
}

function segUiGuide() {
  var g = (typeof window !== 'undefined') ? window.taguette_thematic_segments : null;
  return g || [];
}

// Only project administrators can edit project metadata (database.py,
// Privileges.can_edit_project_meta)
function segCanEditMeta() {
  try {
    var m = (typeof members !== 'undefined') ? members : null;
    var login = (typeof user_login !== 'undefined') ? user_login : null;
    if(!m || login === null || !m[login]) {
      return false;
    }
    return m[login].privileges === 'ADMIN';
  } catch(e) {
    return false;
  }
}

function segUiGuideHash(guide) {
  return sugTextKey('g', JSON.stringify((guide || []).map(function(g) {
    return [g.id, g.name, g.description || '', g.guide_questions || []];
  })));
}

function segUiParamsHash(params) {
  var keys = Object.keys(params).sort();
  return sugTextKey('p', JSON.stringify(keys.map(function(k) {
    return [k, params[k]];
  })));
}

function segUiManualHash(manual) {
  manual = manual || segUiEmptyManual();
  var ak = Object.keys(manual.assign || {}).sort();
  return sugTextKey('m', JSON.stringify([
    ak.map(function(k) {
      var e = manual.assign[k];
      return [k, e.segId === undefined ? null : e.segId, e.emergentKey || null];
    }),
    (manual.starts || []).slice().sort()]));
}

function segUiSpeakersHash(speakers, turns) {
  return sugTextKey('s', JSON.stringify([
    (speakers || []).map(function(s) {
      return [s.id, s.include !== false];
    }),
    (turns || []).map(function(t) {
      return t.speaker || '';
    })]));
}

function segUiTurns() {
  if(!sug_session) {
    return [];
  }
  if(!sug_session.turns) {
    sug_session.turns = sugSpeakerTurns();
  }
  return sug_session.turns || [];
}

// Copies of the turns carrying labelEnd (where the spoken text starts), for
// the pipeline: speaker labels are never part of a section's content
function segUiTurnsWithLabels() {
  return segUiTurns().map(function(t) {
    var o = {};
    for(var k in t) {
      o[k] = t[k];
    }
    o.labelEnd = (typeof sugTurnLabelEnd === 'function')
      ? sugTurnLabelEnd(t) : Math.max(t.contentStart || t.start, t.start);
    return o;
  });
}

function segUiTagList() {
  var out = [];
  var all = (typeof tags !== 'undefined' && tags) ? tags : {};
  for(var k in all) {
    out.push({id: parseInt(all[k].id !== undefined ? all[k].id : k, 10),
              path: all[k].path, description: all[k].description || ''});
  }
  return out;
}

function segUiErrText(err) {
  return (err && err.message) ? err.message : String(err);
}

function segUiStatus(msg) {
  try {
    if(typeof sugSetStatus === 'function' && typeof document !== 'undefined'
       && document.getElementById('sug-status')) {
      sugSetStatus(msg);
    }
  } catch(e) { /* status line is best effort */ }
}

// Pipeline stages in order, with the share of the overall cost each one is
// assumed to take (the percent estimate is monotonic and only approximate)
var SEG_UI_STAGE_PLAN = [
  {id: 'embed', weight: 0.15, label: 'embedding windows'},
  {id: 'decide', weight: 0.20, label: 'checking ambiguous passages'},
  {id: 'emergent', weight: 0.05, label: 'naming new topics'},
  {id: 'units', weight: 0.15, label: 'cutting suggested highlights'},
  // segments.js reports tag verification and LLM rechecks under 'tags'
  {id: 'tags', weight: 0.45, label: 'proposing and checking tags'}
];

function segUiStageIndex(stage) {
  for(var i = 0; i < SEG_UI_STAGE_PLAN.length; ++i) {
    if(SEG_UI_STAGE_PLAN[i].id === stage) {
      return i;
    }
  }
  return -1;
}

// Overall fraction [0, 1] reached at (stage, done, total); null if unknown
function segUiOverallFraction(stage, done, total) {
  var idx = segUiStageIndex(stage);
  if(idx < 0) {
    return null;
  }
  var before = 0;
  for(var i = 0; i < idx; ++i) {
    before += SEG_UI_STAGE_PLAN[i].weight;
  }
  var frac = total ? Math.max(0, Math.min(1, done / total)) : 0;
  return before + SEG_UI_STAGE_PLAN[idx].weight * frac;
}

function segUiProgressText(stage, done, total) {
  var idx = segUiStageIndex(stage);
  var label = gettext(idx >= 0 ? SEG_UI_STAGE_PLAN[idx].label : stage);
  if(total) {
    return gettext('Segmenting: %(stage)s %(done)s/%(total)s',
                   {stage: label, done: done, total: total});
  }
  return gettext('Segmenting: %(stage)s', {stage: label});
}

function segUiFmtElapsed(secs) {
  var m = Math.floor(secs / 60), r = secs % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

// A progress meter: text + percent + elapsed seconds, re-rendered every
// second, with a spinner shown while it runs. sink = {text(str), busy(bool),
// alive() -> bool, current() -> str}. Reference counted: nested start()s share
// one clock; the meter stops when every start() has a stop().
function segUiMeterNew(sink) {
  var m = {users: 0, t0: 0, timer: null, text: '', pct: null, shown: ''};
  function show() {
    var parts = [m.text];
    if(m.pct !== null) {
      parts.push(Math.min(99, Math.round(100 * m.pct)) + '%');
    }
    parts.push(segUiFmtElapsed(Math.floor((Date.now() - m.t0) / 1000)));
    m.shown = parts.join(' · ');
    sink.text(m.shown);
  }
  function finish() {
    m.users = 0;
    if(m.timer !== null) {
      clearInterval(m.timer);
      m.timer = null;
    }
    sink.busy(false);
    var was = m.shown;
    m.shown = '';
    if(was && sink.current() === was) {
      sink.text('');
    }
  }
  m.start = function(text) {
    if(m.users++ === 0) {
      m.t0 = Date.now();
      m.pct = 0;
      m.text = text || gettext('Segmenting…');
      sink.busy(true);
      m.timer = setInterval(function() {
        if(!sink.alive()) {
          finish();
          return;
        }
        show();
      }, 1000);
    }
    show();
  };
  m.stop = function() {
    if(m.users > 0 && --m.users === 0) {
      finish();
    }
  };
  m.abort = function() {
    if(m.users > 0) {
      finish();
    }
  };
  // Set the text and (optionally) a fraction; never goes backwards
  m.set = function(text, frac) {
    if(!m.users) {
      return;
    }
    m.text = text;
    if(typeof frac === 'number') {
      m.pct = Math.max(m.pct || 0, Math.min(1, frac));
    }
    show();
  };
  m.progress = function(stage, done, total) {
    m.set(segUiProgressText(stage, done, total),
          segUiOverallFraction(stage, done, total) === null
            ? undefined : segUiOverallFraction(stage, done, total));
  };
  m.running = function() {
    return m.users > 0;
  };
  return m;
}

// The suggestion toolbar's status line (#sug-status) with its spinner
var SEG_UI_STATUS_METER = segUiMeterNew({
  text: function(str) {
    segUiStatus(str);
  },
  busy: function(on) {
    try {
      var sp = document.getElementById('sug-spinner');
      if(sp) {
        sp.classList.toggle('d-none', !on);
      }
    } catch(e) { /* best effort */ }
  },
  alive: function() {
    return !!sug_session;
  },
  current: function() {
    try {
      var el = document.getElementById('sug-status');
      return el ? el.textContent : '';
    } catch(e) {
      return '';
    }
  }
});

// Keep the status meter running while `promise` is pending
function segUiMetered(promise) {
  SEG_UI_STATUS_METER.start();
  return promise.then(function(v) {
    SEG_UI_STATUS_METER.stop();
    return v;
  }, function(e) {
    SEG_UI_STATUS_METER.stop();
    throw e;
  });
}

function segUiProgress(stage, done, total) {
  if(SEG_UI_STATUS_METER.running()) {
    SEG_UI_STATUS_METER.progress(stage, done, total);
  } else {
    segUiStatus(segUiProgressText(stage, done, total));
  }
}

function segUiAssignmentOf(sec) {
  return {
    segId: (sec.segId !== null && sec.segId !== undefined) ? sec.segId : null,
    emergentKey: sec.emergent ? sec.emergent.key : null
  };
}

function segUiSameAssignment(a, b) {
  var sa = segUiAssignmentOf(a), sb = segUiAssignmentOf(b);
  if(sa.segId !== null || sb.segId !== null) {
    return sa.segId === sb.segId;
  }
  return sa.emergentKey !== null && sa.emergentKey === sb.emergentKey;
}

// Key of the turn containing `pos`, or null when the turn text is not unique
function segUiUniqueKey(turns, pos) {
  var i = segTurnAt(turns, pos);
  if(i < 0) {
    return null;
  }
  var key = segTurnKey(turns[i]), n = 0;
  for(var t = 0; t < turns.length; ++t) {
    if(segTurnKey(turns[t]) === key) {
      ++n;
    }
  }
  return n === 1 ? key : null;
}

// Start of the turn nearest to a char index (turn start or next turn start)
function segUiNearestTurnStart(turns, ch) {
  if(!turns.length) {
    return null;
  }
  var i = Math.max(0, segTurnAt(turns, ch));
  var best = turns[i].start;
  if(i + 1 < turns.length
     && Math.abs(turns[i + 1].start - ch) < Math.abs(best - ch)) {
    best = turns[i + 1].start;
  }
  return best;
}

// Record that the section starting at `pos` has this assignment (and, with
// pin, that its start is a user-made boundary). false: turn text not unique.
function segUiRecordAssign(manual, turns, pos, assignment, pin) {
  var key = segUiUniqueKey(turns, pos);
  if(key === null) {
    return false;
  }
  manual.assign[key] = {segId: assignment.segId, emergentKey: assignment.emergentKey};
  if(pin && manual.starts.indexOf(key) === -1) {
    manual.starts.push(key);
  }
  return true;
}

function segUiForgetKey(manual, key) {
  if(key === null) {
    return;
  }
  delete manual.assign[key];
  var at = manual.starts.indexOf(key);
  if(at !== -1) {
    manual.starts.splice(at, 1);
  }
}

// Char positions of the user's section starts that still exist
function segUiStartPositions(turns, manual) {
  var out = {}, count = {}, at = {}, i;
  for(i = 0; i < turns.length; ++i) {
    var k = segTurnKey(turns[i]);
    count[k] = (count[k] || 0) + 1;
    at[k] = i;
  }
  var starts = (manual && manual.starts) || [];
  for(i = 0; i < starts.length; ++i) {
    if(count[starts[i]] === 1) {
      out[turns[at[starts[i]]].start] = true;
    }
  }
  return out;
}

// Merge sections[i] with sections[i+1]; the result keeps the label of
// sections[keepIdx] (i or i+1)
function segUiMergePair(sections, i, keepIdx) {
  var merged = segCloneSection(sections[keepIdx]);
  merged.start = sections[i].start;
  merged.end = sections[i + 1].end;
  merged.manual = true;
  if(keepIdx !== i) {
    merged.openingQuestion = sections[i].openingQuestion;
  }
  var out = sections.slice(0, i);
  out.push(merged);
  return out.concat(sections.slice(i + 2));
}

// Move the start of sections[i] (i >= 1) to char `pos`; null when invalid
function segUiMoveStart(sections, i, pos) {
  if(i < 1 || i >= sections.length) {
    return null;
  }
  var prev = sections[i - 1], cur = sections[i];
  if(pos <= prev.start || pos >= cur.end || pos === cur.start) {
    return null;
  }
  var out = sections.slice();
  var p = segCloneSection(prev), c = segCloneSection(cur);
  p.end = pos;
  c.start = pos;
  c.manual = true;
  c.openingQuestion = null;
  out[i - 1] = p;
  out[i] = c;
  return out;
}

// Adjacent sections with the same assignment are one section, unless the
// user made a boundary between them
function segUiCoalesce(sections, startPositions) {
  var out = [];
  for(var i = 0; i < sections.length; ++i) {
    var cur = sections[i], prev = out.length ? out[out.length - 1] : null;
    if(prev && prev.end === cur.start && !startPositions[cur.start]
       && segUiSameAssignment(prev, cur)) {
      var merged = segCloneSection(prev);
      merged.end = cur.end;
      merged.manual = prev.manual || cur.manual;
      out[out.length - 1] = merged;
    } else {
      out.push(cur);
    }
  }
  return out;
}

// Coalesce, apply the user's edits to emergent names, refresh derived fields.
// ctx = {guide, windows, plainText, infos, turns}
function segUiFinalize(sections, ctx, manual, emergentDict) {
  var out = segUiCoalesce(sections, segUiStartPositions(ctx.turns || [], manual));
  for(var i = 0; i < out.length; ++i) {
    var e = out[i].emergent;
    if(e && emergentDict && emergentDict[e.key]) {
      var d = emergentDict[e.key];
      e.name = d.name;
      e.description = d.description || '';
      e.question = d.question || '';
      e.proposed = !!d.proposed;
    }
  }
  segRefreshSections(out, ctx);
  var known = {};
  (ctx.guide || []).forEach(function(g) {
    known[g.id] = true;
  });
  out.forEach(function(sec) {
    if(sec.segId !== null && sec.segId !== undefined && !known[sec.segId]) {
      // The segment was removed from the guide (for example merged away)
      sec.name = gettext('(removed topic)');
      sec.label = segSectionLabel(sec.name, sec.openingQuestion);
    }
  });
  return out;
}

// Emergent info per key, kept across runs when the user edited it
function segUiCollectEmergent(sections, old) {
  var out = {}, k;
  old = old || {};
  for(k in old) {
    if(old[k].user) {
      out[k] = old[k];
    }
  }
  for(var i = 0; i < sections.length; ++i) {
    var e = sections[i].emergent;
    if(!e || out[e.key]) {
      continue;
    }
    if(old[e.key] && old[e.key].edited) {
      out[e.key] = old[e.key];
    } else {
      out[e.key] = {name: e.name, description: e.description || '',
                    question: e.question || '', proposed: !!e.proposed};
    }
  }
  return out;
}

// Sections not backed by a guide segment (emergent or user created), grouped
// by emergent key; "Whole document" / unassigned sections are not pending
function segUiPendingGroups(sections, dict) {
  var groups = [], by = {};
  dict = dict || {};
  for(var i = 0; i < (sections || []).length; ++i) {
    var s = sections[i];
    if((s.segId !== null && s.segId !== undefined) || !s.emergent) {
      continue;
    }
    var key = s.emergent.key, g = by[key];
    if(!g) {
      var d = dict[key] || s.emergent;
      g = by[key] = {
        key: key, sectionIds: [], name: d.name || '',
        description: d.description || '', question: d.question || '',
        user: key.charAt(0) === 'u', merge: null, choice: 'new'
      };
      groups.push(g);
    }
    g.sectionIds.push(s.id);
  }
  return groups;
}

// After the guide was saved: sections of each group become guide segments.
// mapping = {emergentKey: {segId, name}}
function segUiRemap(sections, manual, dict, mapping) {
  var changed = 0, i, k;
  for(i = 0; i < sections.length; ++i) {
    var s = sections[i];
    if(s.emergent && mapping[s.emergent.key]) {
      var m = mapping[s.emergent.key];
      s.segId = m.segId;
      s.emergent = null;
      s.name = m.name;
      s.label = segSectionLabel(s.name, s.openingQuestion);
      ++changed;
    }
  }
  for(k in manual.assign) {
    var ek = manual.assign[k].emergentKey;
    if(ek && mapping[ek]) {
      manual.assign[k] = {segId: mapping[ek].segId, emergentKey: null};
    }
  }
  for(k in mapping) {
    delete dict[k];
  }
  return changed;
}

function segUiFindByName(list, name) {
  var n = String(name || '').trim().toLowerCase();
  for(var i = 0; i < list.length; ++i) {
    if(String(list[i].name).trim().toLowerCase() === n) {
      return list[i];
    }
  }
  return null;
}

function segUiFindById(list, id) {
  for(var i = 0; i < list.length; ++i) {
    if(list[i].id === id) {
      return list[i];
    }
  }
  return null;
}

// Units -> candidates for the suggestion panes (CHAR offsets)
function segUnitsAsCandidates(result, theta) {
  if(theta === undefined || theta === null) {
    theta = segParams().theta;
  }
  var out = [];
  var units = (result && result.units) || [];
  for(var i = 0; i < units.length; ++i) {
    var u = units[i], ts = [], best = -1;
    var utags = u.tags || [];
    for(var t = 0; t < utags.length; ++t) {
      ts.push({id: utags[t].id, name: utags[t].name, conf: utags[t].conf,
               source: utags[t].source});
      best = Math.max(best, utags[t].conf);
    }
    out.push({
      start: u.start, end: u.end,
      raw: (best >= 0 ? best : 0) * (1 - 0.5 * (u.smallTalk || 0)),
      tags: ts, section_id: u.sectionId,
      ticked: ts.filter(function(x) {
        return x.conf >= theta;
      }).map(function(x) {
        return x.id;
      })
    });
  }
  return out;
}

function segSectionAt(charIdx) {
  var secs = null;
  if(SEG_UI.doc) {
    secs = (SEG_UI.doc.result && SEG_UI.doc.result.sections) || SEG_UI.doc.sections;
  }
  if(!secs || !secs.length) {
    return null;
  }
  for(var i = 0; i < secs.length; ++i) {
    if(charIdx >= secs[i].start && (charIdx < secs[i].end
       || (i === secs.length - 1 && charIdx <= secs[i].end))) {
      return secs[i];
    }
  }
  return null;
}

function segResultVersion() {
  return SEG_UI.version;
}

function segUiMergeIntervals(ivs) {
  var a = ivs.slice().sort(function(x, y) {
    return x[0] - y[0];
  });
  var out = [];
  for(var i = 0; i < a.length; ++i) {
    if(a[i][1] <= a[i][0]) {
      continue;
    }
    if(out.length && a[i][0] <= out[out.length - 1][1]) {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], a[i][1]);
    } else {
      out.push([a[i][0], a[i][1]]);
    }
  }
  return out;
}

// {count, covered, codable}: suggestions/staged inside a section and the share
// of its codable characters they cover. spans = [{cStart, cEnd}]
function segUiSectionStats(sec, turns, speakers, spans) {
  var include = {}, i;
  for(i = 0; i < (speakers || []).length; ++i) {
    include[speakers[i].id] = speakers[i].include !== false;
  }
  var codable = [];
  if(!turns || !turns.length) {
    codable.push([sec.start, sec.end]);
  } else {
    for(i = 0; i < turns.length; ++i) {
      var t = turns[i];
      if(t.end <= sec.start || t.start >= sec.end) {
        continue;
      }
      if(t.speaker && include[t.speaker] === false) {
        continue;
      }
      codable.push([Math.max(t.start, sec.start), Math.min(t.end, sec.end)]);
    }
  }
  codable = segUiMergeIntervals(codable);
  var clipped = [], count = 0;
  for(i = 0; i < spans.length; ++i) {
    var s = spans[i];
    if(s.cStart >= sec.start && s.cStart < sec.end) {
      ++count;
    }
    clipped.push([Math.max(s.cStart, sec.start), Math.min(s.cEnd, sec.end)]);
  }
  clipped = segUiMergeIntervals(clipped);
  var total = 0, covered = 0;
  codable.forEach(function(c) {
    total += c[1] - c[0];
    clipped.forEach(function(k) {
      covered += Math.max(0, Math.min(c[1], k[1]) - Math.max(c[0], k[0]));
    });
  });
  return {count: count, covered: covered, codable: total};
}

// Prototype / co-occurrence extras (stored per document) -> core inputs
function segUiExtrasFrom(protosRaw, coocRaw, excludeDocId) {
  var protos = {}, cooc = {}, seg, doc, tag;
  function excluded(d) {
    return excludeDocId !== null && excludeDocId !== undefined
      && String(d) === String(excludeDocId);
  }
  for(seg in (protosRaw || {})) {
    for(doc in protosRaw[seg]) {
      if(excluded(doc)) {
        continue;
      }
      var e = protosRaw[seg][doc];
      if(!e || !e.n || !e.sum) {
        continue;
      }
      (protos[seg] = protos[seg] || []).push(e.sum.map(function(x) {
        return x / e.n;
      }));
    }
  }
  for(tag in (coocRaw || {})) {
    for(seg in coocRaw[tag]) {
      for(doc in coocRaw[tag][seg]) {
        if(excluded(doc)) {
          continue;
        }
        cooc[tag] = cooc[tag] || {};
        cooc[tag][seg] = (cooc[tag][seg] || 0) + coocRaw[tag][seg][doc];
      }
    }
  }
  return {protos: protos, cooc: cooc};
}

// Add one saved unit to the per-document prototype sums and tag counts
function segUiAddPrototype(protos, cooc, segId, docId, vec, tagIds) {
  var v = Array.prototype.slice.call(vec);
  var bySeg = (protos[segId] = protos[segId] || {});
  var slot = (bySeg[docId] = bySeg[docId] || {sum: v.map(function() {
    return 0;
  }), n: 0});
  for(var i = 0; i < v.length; ++i) {
    slot.sum[i] += v[i];
  }
  slot.n += 1;
  tagIds.forEach(function(t) {
    var by = (cooc[t] = cooc[t] || {});
    var per = (by[segId] = by[segId] || {});
    per[docId] = (per[docId] || 0) + 1;
  });
}


/*
 * Persistence
 */

function segUiDocKey(docId) {
  return 'seg|doc|' + docId;
}

function segUiEmbKey() {
  try {
    var cfg = sugLoadConfig();
    return cfg ? sugEmbKey(cfg) : null;
  } catch(e) {
    return null;
  }
}

function segUiStripSections(sections) {
  return (sections || []).map(function(s) {
    var c = segCloneSection(s);
    delete c.vec;
    return c;
  });
}

function segUiPersist() {
  var doc = SEG_UI.doc;
  if(!doc || doc.docId === null || doc.docId === undefined) {
    return;
  }
  var secs = (doc.result && doc.result.sections) || doc.sections;
  segIdbPut(segUiDocKey(doc.docId), {
    version: 1, textHash: doc.textHash, guideHash: segUiGuideHash(segUiGuide()),
    paramsHash: segUiParamsHash(segParams()), sections: segUiStripSections(secs),
    manual: doc.manual, emergent: doc.emergent
  });
  var ids = [];
  (secs || []).forEach(function(s) {
    if(s.segId !== null && s.segId !== undefined && ids.indexOf(s.segId) === -1) {
      ids.push(s.segId);
    }
  });
  var docId = doc.docId;
  // Read-modify-write of the shared index, one update at a time
  var step = function() {
    return Promise.resolve(segIdbGet('seg|index')).then(function(index) {
      index = index || {};
      index[docId] = ids;
      return segIdbPut('seg|index', index);
    });
  };
  var prev = SEG_UI.indexChain || Promise.resolve();
  SEG_UI.indexChain = prev.then(step, step).then(null, function(err) {
    console.warn('Could not update the segment index:', segUiErrText(err));
  });
}

// Adopt the saved record of the document, unless an analysis already produced
// a result (then the result's own key decides whether anything is re-run).
// Returns true when something was adopted.
function segUiAdoptRecord(rec) {
  var doc = SEG_UI.doc;
  if(!doc || !rec || rec.version !== 1 || doc.result) {
    return false;
  }
  doc.manual = rec.manual || segUiEmptyManual();
  doc.manual.assign = doc.manual.assign || {};
  doc.manual.starts = doc.manual.starts || [];
  doc.emergent = rec.emergent || {};
  if(rec.textHash === doc.textHash && rec.sections && rec.sections.length) {
    doc.sections = rec.sections;
  }
  return true;
}


/*
 * Result cache. The full analysis of a document (sections, units with their
 * tags) is kept in memory (survives the end of a suggestion session within
 * the page) and in IndexedDB ('seg|result|<docId>'), under segResultKey(): a
 * hit skips the whole pipeline. Exemplars are not part of the key, so saving
 * or discarding highlights does not invalidate it ("Re-run analysis" does).
 *
 * Stored: sections (without their vectors), units (vectors as Float32Array),
 * coverage, stats and the guide vectors. Windows and turn infos are cheap and
 * deterministic, so they are recomputed on load; the window vectors, labels
 * and prototypes are only needed by the sections stage and are not kept.
 * Approximate size: 4 * dim * (units + guide segments) bytes plus about 1 KB
 * of JSON per unit (e.g. dim 1536, 220 units: ~1.4 MB + ~0.3 MB).
 */

var SEG_UI_RESULT_VERSION = 1;
var SEG_UI_RESULT_MAX_BYTES = 25 * 1024 * 1024;
var SEG_UI_RESULT_DELAY = 1000;     // ms: debounce of the IndexedDB write
var SEG_UI_RESULT_MEM_DOCS = 3;     // documents kept in memory

function segUiResultIdbKey(docId) {
  return 'seg|result|' + docId;
}

function segUiToF32(v) {
  return (v && typeof v.length === 'number') ? Float32Array.from(v) : null;
}

function segUiFromF32(v) {
  return v ? Array.from(v) : null;
}

// {version, key, savedAt, unitOverrides, result} (structured-clonable) or null
function segUiSerializeResult(key, result, savedAt, unitOverrides) {
  if(!result || !result.sections || !result.units) {
    return null;
  }
  var units = result.units.map(function(u) {
    var o = {};
    for(var k in u) {
      o[k] = u[k];
    }
    o.vec = segUiToF32(u.vec);
    return o;
  });
  return {
    version: SEG_UI_RESULT_VERSION, key: key, savedAt: savedAt,
    unitOverrides: unitOverrides || null,
    result: {
      sections: segUiStripSections(result.sections), units: units,
      coverage: result.coverage || null, stats: result.stats || null,
      guideVecs: result.guideVecs ? Array.prototype.map.call(
        result.guideVecs, segUiToF32) : null
    }
  };
}

// Approximate stored size in bytes
function segUiResultBytes(rec) {
  var r = rec.result, n = 0;
  r.units.forEach(function(u) {
    n += u.vec ? u.vec.byteLength : 0;
  });
  (r.guideVecs || []).forEach(function(v) {
    n += v ? v.byteLength : 0;
  });
  var rest = {sections: r.sections, coverage: r.coverage, stats: r.stats,
              units: r.units.map(function(u) {
                var o = {};
                for(var k in u) {
                  if(k !== 'vec') {
                    o[k] = u[k];
                  }
                }
                return o;
              })};
  return n + JSON.stringify(rest).length;
}

// Rebuild a result from a stored record for the open session: the cheap pure
// parts (turn infos, windows) are recomputed. Returns null when it does not fit.
function segUiHydrateResult(rec) {
  if(!rec || rec.version !== SEG_UI_RESULT_VERSION || !rec.result || !sug_session) {
    return null;
  }
  var r = rec.result;
  if(!r.sections || !r.sections.length || !r.units) {
    return null;
  }
  var input = {plainText: sug_session.plainText, turns: segUiTurnsWithLabels(),
               speakers: sug_session.speakers || [], guide: segUiGuide(),
               params: segParams()};
  var infos = segTurnInfos(input);
  var windows = segBuildWindows(input, infos);
  if(r.stats && typeof r.stats.windows === 'number'
     && r.stats.windows !== windows.length) {
    return null;   // the pipeline changed since: do not mix generations
  }
  var units = r.units.map(function(u) {
    var o = {};
    for(var k in u) {
      o[k] = u[k];
    }
    o.vec = segUiFromF32(u.vec);
    return o;
  });
  return {
    windows: windows, infos: infos, sections: r.sections.map(segCloneSection),
    units: units, coverage: r.coverage, stats: r.stats,
    guideVecs: r.guideVecs ? r.guideVecs.map(segUiFromF32) : null,
    labels: [], vecs: [], protos: null
  };
}

function segUiCacheDrop(docId) {
  delete SEG_UI.resultCache[docId];
  delete SEG_UI.resultDirty[docId];
}

// Remember `res` (computed for `key`) in memory now and in IndexedDB soon
function segUiCacheStore(doc, key, res, over) {
  if(!doc || doc.docId === null || doc.docId === undefined || !key || !res) {
    return;
  }
  SEG_UI.resultCache[doc.docId] = {key: key, result: res, savedAt: Date.now(),
                                   unitOverrides: over || null};
  var ids = Object.keys(SEG_UI.resultCache);
  if(ids.length > SEG_UI_RESULT_MEM_DOCS) {
    ids.sort(function(a, b) {
      return SEG_UI.resultCache[a].savedAt - SEG_UI.resultCache[b].savedAt;
    });
    segUiCacheDrop(ids[0]);
  }
  SEG_UI.resultDirty[doc.docId] = true;
  if(SEG_UI.resultTimer) {
    clearTimeout(SEG_UI.resultTimer);
  }
  SEG_UI.resultTimer = setTimeout(segUiCacheFlush, SEG_UI_RESULT_DELAY);
}

// Store the current result of the open document, if it is up to date
function segUiCacheCurrent() {
  var doc = SEG_UI.doc;
  if(doc && doc.result && doc.resultKey && doc.resultKey === segResultKey()) {
    segUiCacheStore(doc, doc.resultKey, doc.result, doc.unitOverrides);
  }
}

// Write the pending entries to IndexedDB (works after the session ended)
function segUiCacheFlush() {
  SEG_UI.resultTimer = null;
  var dirty = SEG_UI.resultDirty;
  SEG_UI.resultDirty = {};
  Object.keys(dirty).forEach(function(docId) {
    var ent = SEG_UI.resultCache[docId];
    if(!ent) {
      return;
    }
    try {
      var rec = segUiSerializeResult(ent.key, ent.result, ent.savedAt,
                                     ent.unitOverrides);
      if(!rec) {
        return;
      }
      var bytes = segUiResultBytes(rec);
      if(!SEG_UI.resultLogged) {
        SEG_UI.resultLogged = true;
        console.debug('Segmentation result cache: ' + (bytes / 1048576).toFixed(2)
                      + ' MB' + (bytes > SEG_UI_RESULT_MAX_BYTES
                                 ? ' (too large: kept in memory only)' : ''));
      }
      if(bytes <= SEG_UI_RESULT_MAX_BYTES) {
        segIdbPut(segUiResultIdbKey(docId), rec);
      }
    } catch(err) {
      console.warn('Could not store the segmentation result:', segUiErrText(err));
    }
  });
}

// Resolves with {result, savedAt, unitOverrides} when a valid result for
// (doc, key) is cached (memory first, then IndexedDB), else null. Never rejects.
function segUiCacheLoad(doc, key) {
  var ent = SEG_UI.resultCache[doc.docId];
  if(ent && ent.key === key) {
    return Promise.resolve(ent);
  }
  if(ent) {
    segUiCacheDrop(doc.docId);   // stale
  }
  return Promise.resolve().then(function() {
    return segUiTimeout(segIdbGet(segUiResultIdbKey(doc.docId)),
                        SEG_UI_RECORD_TIMEOUT, null);
  }).then(function(rec) {
    if(!rec || rec.key !== key) {
      return null;
    }
    var result = segUiHydrateResult(rec);
    return result && {result: result, savedAt: rec.savedAt || 0,
                      unitOverrides: rec.unitOverrides || null,
                      key: key, fromIdb: true};
  }).then(null, function(err) {
    console.warn('Could not load the saved segmentation:', segUiErrText(err));
    return null;
  });
}

function segUiAgoText(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  if(s < 60) {
    return gettext('a few seconds ago');
  }
  var m = Math.round(s / 60);
  if(m < 60) {
    return gettext('%(n)s minutes ago', {n: m});
  }
  var h = Math.round(m / 60);
  if(h < 48) {
    return gettext('%(n)s hours ago', {n: h});
  }
  return gettext('%(n)s days ago', {n: Math.round(h / 24)});
}


/*
 * Session hooks + analysis
 */

function segOnSessionStart() {
  segUiInvalidate();
  SEG_UI.exemplars = null;
  SEG_UI.running = null;
  SEG_UI.splitting = null;
  SEG_UI.busy = false;
  if(!sug_session) {
    return;
  }
  var gen = SEG_UI.gen, docId = current_document;
  SEG_UI.doc = segUiNewDoc(docId, sugTextKey('doc', sug_session.plainText));
  segRenderSections();
  var startDoc = SEG_UI.doc;
  startDoc.recordPending = true;
  // The analysis waits for this (see segAnalyzeDocument): the saved manual
  // edits are part of the result key
  startDoc.recordPromise = segUiTimeout(segIdbGet(segUiDocKey(docId)),
                                        SEG_UI_RECORD_TIMEOUT, null).then(function(rec) {
    startDoc.recordPending = false;
    if(gen !== SEG_UI.gen || !sug_session) {
      return;
    }
    var adopted = segUiAdoptRecord(rec);
    segRenderSections();
    segRenderSeparators();
    if(adopted && typeof sugHasSegmentedPane === 'function'
       && sugHasSegmentedPane()) {
      // The user's saved edits change the sections: recompute
      segUiScheduleRecompute();
    }
  }, function() {
    startDoc.recordPending = false;
  });
}

function segOnSessionEnd() {
  SEG_UI_STATUS_METER.abort();
  segUiInvalidate();
  SEG_UI.busy = false;
  SEG_UI.doc = null;
  SEG_UI.running = null;
  SEG_UI.exemplars = null;
  segUiSetSplitting(null);
  segRemoveSeparators();
  segRenderSections();
}

// The text changed: results are stale, the user's edits are inherited
function segOnRebuild() {
  var doc = SEG_UI.doc;
  if(!doc || !sug_session) {
    return;
  }
  doc.textHash = sugTextKey('doc', sug_session.plainText);
  segUiCacheDrop(doc.docId);
  doc.result = null;
  doc.resultKey = null;
  doc.sections = null;
  doc.unitOverrides = null;
  segUiInvalidate();
  SEG_UI.busy = false;
  SEG_UI.exemplars = null;
  SEG_UI.running = null;
  ++SEG_UI.version;
  segRemoveSeparators();
  segRenderSections();
}

// Key of everything the SECTIONS depend on (tau/theta are not included)
function segUiResultKey() {
  var doc = SEG_UI.doc;
  return [doc.textHash, doc.speakersHash, segUiGuideHash(segUiGuide()),
          segUiParamsHash(segParams()), segUiManualHash(doc.manual)].join('|');
}

// Cheap key of everything the sections depend on (text, speakers, guide,
// section parameters, manual edits; not tau/theta). Used by the suggestion
// cache and to decide whether the stored result is still valid.
function segResultKey() {
  var doc = SEG_UI.doc;
  if(!doc || !sug_session) {
    return '';
  }
  doc.speakersHash = segUiSpeakersHash(sug_session.speakers, segUiTurns());
  return segUiResultKey();
}

function segUiEnsureDoc() {
  if(!SEG_UI.doc && sug_session) {
    SEG_UI.doc = segUiNewDoc(current_document, sugTextKey('doc', sug_session.plainText));
  }
  return SEG_UI.doc;
}

// {tau, theta} given by the caller (slider), or null
function segUiUnitOverrides(opts) {
  if(!opts) {
    return null;
  }
  var o = {}, any = false;
  ['tau', 'theta'].forEach(function(k) {
    if(typeof opts[k] === 'number' && isFinite(opts[k])) {
      o[k] = opts[k];
      any = true;
    }
  });
  return any ? o : null;
}

function segUiSameOverrides(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function segUiExemplars() {
  var now = Date.now();
  if(SEG_UI.exemplars && now - SEG_UI.exemplarsAt < SEG_UI_EXEMPLAR_TTL) {
    return Promise.resolve(SEG_UI.exemplars);
  }
  return Promise.resolve().then(function() {
    return segFetchExemplars();
  }).then(function(ex) {
    SEG_UI.exemplars = ex;
    SEG_UI.exemplarsAt = Date.now();
    return ex;
  }, function(err) {
    // Without exemplars tags are still scored from their definitions
    console.warn('Could not fetch the tag exemplars:', segUiErrText(err));
    return SEG_UI.exemplars || [];
  });
}

function segUiExtras(excludeDocId) {
  var embKey = segUiEmbKey();
  if(!embKey) {
    return Promise.resolve({protos: {}, cooc: {}});
  }
  var raw = SEG_UI.extrasRaw;
  if(raw && raw.embKey === embKey) {
    return Promise.resolve(segUiExtrasFrom(raw.protos, raw.cooc, excludeDocId));
  }
  return Promise.all([segIdbGet('seg|protos|' + embKey), segIdbGet('seg|cooc')])
    .then(function(r) {
      SEG_UI.extrasRaw = {embKey: embKey, protos: r[0] || {}, cooc: r[1] || {}};
      return segUiExtrasFrom(r[0], r[1], excludeDocId);
    });
}

var SEG_UI_INPUT_TIMEOUT = 20000;

// Resolves with `fallback` when `promise` has not settled after ms (a hung
// request or IndexedDB must not stall a run forever)
function segUiTimeout(promise, ms, fallback) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var timer = setTimeout(function() {
      if(!done) {
        done = true;
        console.warn('Segmentation: input preparation timed out, continuing without it');
        resolve(fallback);
      }
    }, ms);
    Promise.resolve(promise).then(function(v) {
      if(!done) { done = true; clearTimeout(timer); resolve(v); }
    }, function(e) {
      if(!done) { done = true; clearTimeout(timer); reject(e); }
    });
  });
}

// opts: {overrides, excludeDocId, manual (null = none; default: the user's)}
function segUiMakeInput(opts) {
  opts = opts || {};
  var excl = (opts.excludeDocId === undefined) ? null : opts.excludeDocId;
  return Promise.all([
    segUiTimeout(segUiExemplars(), SEG_UI_INPUT_TIMEOUT, []),
    segUiTimeout(segUiExtras(excl), SEG_UI_INPUT_TIMEOUT, {protos: {}, cooc: {}})
  ]).then(function(r) {
    if(!sug_session) {
      throw new Error(gettext('The suggestion session has ended.'));
    }
    var doc = SEG_UI.doc;
    var manual = opts.manual !== undefined ? opts.manual
      : (doc ? doc.manual : null);
    return {
      plainText: sug_session.plainText, turns: segUiTurnsWithLabels(),
      speakers: sug_session.speakers || [], guide: segUiGuide(),
      params: segParams(opts.overrides), tags: segUiTagList(),
      exemplars: r[0], docId: current_document, excludeDocId: excl,
      segPrototypeExtras: r[1].protos, tagSegmentCooc: r[1].cooc,
      manual: manual
    };
  });
}

function segUiCtx(r, input) {
  return {guide: segUiGuide(), windows: r.windows, plainText: input.plainText,
          infos: r.infos, turns: input.turns};
}

function segUiRefreshStats(r) {
  r.coverage = segCoverage(r.sections, segUiGuide());
  if(r.stats) {
    r.stats.sections = r.sections.length;
    r.stats.emergent = r.sections.filter(function(s) {
      return !!s.emergent;
    }).length;
  }
}

// AI circuit breakers are reset when a run starts, but never while another
// analysis/evaluation is in flight
function segUiRunBegin() {
  if(!SEG_UI.active) {
    segAiReset();
  }
  ++SEG_UI.active;
}

function segUiRunEnd() {
  SEG_UI.active = Math.max(0, SEG_UI.active - 1);
}

// Run (or reuse) windows -> sections -> units -> tags for the open session.
// opts {force, excludeDocId, tau, theta}: tau/theta only change the units
// stage (the sections cache is not invalidated). Concurrent callers share the
// sections stage; a caller whose tau/theta differ from the shared run's gets
// its units re-run afterwards. Rejects with a readable Error (e.stale is set
// when the run was superseded).
function segAnalyzeDocument(opts) {
  opts = opts || {};
  if(!sug_session) {
    return Promise.reject(new Error(gettext('Start a suggestion session first.')));
  }
  var doc = segUiEnsureDoc();
  if(doc.recordPending && doc.recordPromise && !doc.result) {
    // The saved manual edits are part of the key: wait for them
    return doc.recordPromise.then(function() {
      return segAnalyzeDocument(opts);
    });
  }
  var key = segResultKey();
  var over = segUiUnitOverrides(opts);
  var uncached = opts.excludeDocId !== undefined && opts.excludeDocId !== null;
  var useCache = !uncached && !opts.force;
  if(useCache && doc.result && doc.resultKey === key) {
    if(over && !segUiSameOverrides(over, doc.unitOverrides)) {
      return segRefreshUnits(over);
    }
    return Promise.resolve(doc.result);
  }
  if(useCache && SEG_UI.running && SEG_UI.running.key === key) {
    var shared = SEG_UI.running;
    return shared.promise.then(function(res) {
      if(over && !segUiSameOverrides(over, shared.over)) {
        return segRefreshUnits(over);
      }
      return res;
    });
  }
  var tok = segUiToken();
  var used = over || (uncached ? null : doc.unitOverrides);
  // The pipeline proper: windows -> sections -> units -> tags
  function pipeline() {
    if(opts.force) {
      SEG_UI.exemplars = null;   // coded highlights since: refetch them
    }
    segUiRunBegin();
    var deps = segMakeDeps({progress: segUiProgress});
    var input = null;
    function end(v) {
      segUiRunEnd();
      return v;
    }
    return segUiMetered(segUiMakeInput({excludeDocId: opts.excludeDocId}).then(function(inp) {
      if(!segUiTokenOk(tok)) {
        throw segUiStaleError();
      }
      input = inp;
      return segRunSections(inp, deps);
    }).then(function(sr) {
      if(!segUiTokenOk(tok)) {
        throw segUiStaleError();
      }
      sr.sections = segUiFinalize(sr.sections, segUiCtx(sr, input), input.manual,
                                  doc.emergent);
      segUiRefreshStats(sr);
      var uin = Object.create(input);
      uin.params = segParams(used);
      return segRunUnits(sr, uin, deps);
    }).then(function(res) {
      if(!segUiTokenOk(tok)) {
        throw segUiStaleError();
      }
      if(!uncached) {
        doc.emergent = segUiCollectEmergent(res.sections, doc.emergent);
        doc.result = res;
        doc.sections = res.sections;
        doc.resultKey = key;
        doc.unitOverrides = used || doc.unitOverrides;
        doc.cachedAt = 0;
        segUiInvalidate();   // refreshes started on the previous result drop
        ++SEG_UI.version;
        segUiPersist();
        segUiCacheStore(doc, key, res, doc.unitOverrides);
        segRenderSections();
        segRenderSeparators();
      }
      return res;
    }).then(end, function(err) {
      end();
      throw err;
    }));
  }
  var p = (useCache ? segUiCacheLoad(doc, key) : Promise.resolve(null)).then(function(hit) {
    if(!hit) {
      return pipeline();
    }
    // A saved analysis for exactly these inputs: no model or network calls
    if(!segUiTokenOk(tok) || segResultKey() !== key) {
      throw segUiStaleError();
    }
    var res = hit.result;
    doc.emergent = segUiCollectEmergent(res.sections, doc.emergent);
    doc.result = res;
    doc.sections = res.sections;
    doc.resultKey = key;
    doc.unitOverrides = hit.unitOverrides || doc.unitOverrides;
    doc.cachedAt = hit.savedAt || 0;
    if(hit.fromIdb) {
      SEG_UI.resultCache[doc.docId] = {key: key, result: res, savedAt: hit.savedAt,
                                       unitOverrides: doc.unitOverrides};
    }
    segUiInvalidate();
    ++SEG_UI.version;
    segRenderSections();
    segRenderSeparators();
    if(hit.savedAt) {
      segUiStatus(gettext('Loaded the saved segmentation (from %(when)s)', {
        when: segUiAgoText(Date.now() - hit.savedAt)}));
    }
    if(over && !segUiSameOverrides(over, doc.unitOverrides)) {
      return segRefreshUnits(over);
    }
    return res;
  });
  if(!uncached) {
    SEG_UI.running = {key: key, promise: p, over: used};
  }
  function clear() {
    if(SEG_UI.running && SEG_UI.running.promise === p) {
      SEG_UI.running = null;
    }
  }
  return p.then(function(res) {
    clear();
    return res;
  }, function(err) {
    clear();
    throw err;
  });
}

// Re-run only units + tags (sections reused); overrides {tau, theta, ...}.
// Falls back to a full analysis when there is no result or its inputs
// (speakers, guide, params, manual edits, text) changed. The latest request
// wins: older ones (and any that outlive an edit or the session) reject with
// a stale error and write nothing.
function segRefreshUnits(overrides) {
  var doc = SEG_UI.doc;
  if(!doc || !sug_session) {
    return Promise.reject(segUiStaleError());
  }
  if(!doc.result || doc.resultKey !== segResultKey()) {
    return segAnalyzeDocument(segUiUnitOverrides(overrides) || {});
  }
  var tok = segUiToken(), seq = ++SEG_UI.unitsSeq, r = doc.result;
  function stale() {
    return !segUiTokenOk(tok) || seq !== SEG_UI.unitsSeq
      || SEG_UI.doc !== doc || doc.result !== r;
  }
  var deps = segMakeDeps({progress: segUiProgress});
  return segUiMetered(segUiMakeInput({overrides: overrides}).then(function(input) {
    if(stale()) {
      throw segUiStaleError();
    }
    return segRunUnits(r, input, deps);
  }).then(function(res) {
    if(stale()) {
      throw segUiStaleError();
    }
    doc.result = res;
    doc.sections = res.sections;
    doc.unitOverrides = overrides || null;
    ++SEG_UI.version;
    segUiCacheCurrent();
    return res;
  }));
}


/*
 * Manual edits (commit + operations)
 */

// Rebuild sections after the user's edits were recorded, redo units, notify
function segUiCommit() {
  var doc = SEG_UI.doc, r = doc && doc.result;
  if(!r || !sug_session) {
    return Promise.resolve();
  }
  // The sections of the cached result are about to change in place; the
  // units refresh below stores the new result
  segUiCacheDrop(doc.docId);
  segUiInvalidate();   // in-flight analyses/refreshes predate this edit
  var turns = segUiTurns();
  var ctx = {guide: segUiGuide(), windows: r.windows,
             plainText: sug_session.plainText, infos: r.infos, turns: turns};
  var secs = segApplyManual(r.sections, turns, doc.manual, ctx);
  secs = segUiFinalize(secs, ctx, doc.manual, doc.emergent);
  doc.emergent = segUiCollectEmergent(secs, doc.emergent);
  r.sections = secs;
  doc.sections = secs;
  segUiRefreshStats(r);
  doc.resultKey = segResultKey();
  ++SEG_UI.version;
  segUiPersist();
  segRenderSections();
  segRenderSeparators();
  SEG_UI.busy = true;
  segUiStatus(gettext('Updating suggestions…'));
  var tok = segUiToken();
  return segRefreshUnits(doc.unitOverrides).then(function() {
    if(!segUiTokenOk(tok)) {
      return;   // superseded: the newer change owns the busy flag
    }
    SEG_UI.busy = false;
    segUiStatus('');
    segRenderSections();
    if(typeof sugRecomputeSegmented === 'function') {
      sugRecomputeSegmented();
    }
  }, function(err) {
    if(err && err.stale) {
      if(!segUiTokenOk(tok)) {
        return;   // superseded by a newer change, which owns the busy flag
      }
      err = null;   // only a newer units refresh took over: not an error
    }
    SEG_UI.busy = false;
    segUiStatus(err ? segUiErrText(err) : '');
    segRenderSections();
  });
}

function segUiEditable() {
  return !!(sug_session && SEG_UI.doc && SEG_UI.doc.result && !SEG_UI.busy);
}

function segUiSectionIndex(id) {
  var secs = SEG_UI.doc.result.sections;
  for(var i = 0; i < secs.length; ++i) {
    if(secs[i].id === id) {
      return i;
    }
  }
  return -1;
}

function segUiNewEmergentKey() {
  return 'u' + Date.now().toString(36) + (++SEG_UI.keyCounter);
}

function segUiNotUnique() {
  segUiStatus(gettext('This segment starts at a turn whose text appears more than once, so the change cannot be remembered.'));
}

function segUiAssignSection(secId, value) {
  if(!segUiEditable()) {
    return;
  }
  var doc = SEG_UI.doc, i = segUiSectionIndex(secId);
  if(i < 0) {
    return;
  }
  var sec = doc.result.sections[i], assignment;
  if(value === 'new') {
    var name = window.prompt(gettext('Name of the new topic'), '');
    if(!name || !name.trim()) {
      segRenderSections();
      return;
    }
    var key = segUiNewEmergentKey();
    doc.emergent[key] = {name: name.trim(), description: '', question: '',
                         proposed: false, user: true, edited: true};
    assignment = {segId: null, emergentKey: key};
  } else if(value.indexOf('s:') === 0) {
    assignment = {segId: parseInt(value.substring(2), 10), emergentKey: null};
  } else if(value.indexOf('e:') === 0) {
    assignment = {segId: null, emergentKey: value.substring(2)};
  } else {
    assignment = {segId: null, emergentKey: null};
  }
  if(!segUiRecordAssign(doc.manual, segUiTurns(), sec.start, assignment, true)) {
    segUiNotUnique();
    segRenderSections();
    return;
  }
  segUiCommit();
}

// Merge sections[i] with its next neighbour: keepIdx = which label survives
function segUiMergeSections(i, keepIdx) {
  var doc = SEG_UI.doc, secs = doc.result.sections;
  if(i < 0 || i + 1 >= secs.length) {
    return;
  }
  var turns = segUiTurns();
  var merged = segUiMergePair(secs, i, keepIdx);
  var m = merged[i];
  var boundaryKey = segUiUniqueKey(turns, secs[i + 1].start);
  // The dropped boundary is no longer a user boundary; the merged section's
  // assignment is recorded on both turns so it survives a re-run. Nothing is
  // pinned: merging must not turn an algorithmic boundary into a user one.
  segUiForgetKey(doc.manual, boundaryKey);
  if(boundaryKey !== null) {
    doc.manual.assign[boundaryKey] = segUiAssignmentOf(m);
  }
  segUiRecordAssign(doc.manual, turns, m.start, segUiAssignmentOf(m), false);
  doc.result.sections = merged;
  segUiCommit();
}

function segUiSplitAt(secId, pos) {
  var doc = SEG_UI.doc, i = segUiSectionIndex(secId);
  if(i < 0) {
    return;
  }
  var sec = doc.result.sections[i];
  if(pos <= sec.start || pos >= sec.end) {
    segUiStatus(gettext('Click inside the segment, away from its first turn.'));
    return;
  }
  if(!segUiRecordAssign(doc.manual, segUiTurns(), pos, segUiAssignmentOf(sec), true)) {
    segUiNotUnique();
    return;
  }
  segUiCommit();
}

function segUiMoveBoundary(secId, pos) {
  var doc = SEG_UI.doc, i = segUiSectionIndex(secId);
  if(i < 1) {
    return;
  }
  var secs = doc.result.sections, turns = segUiTurns();
  if(pos === secs[i].start) {
    return;   // dropped where it was: nothing to do, nothing to say
  }
  var moved = segUiMoveStart(secs, i, pos);
  if(!moved) {
    segUiStatus(gettext('A segment boundary cannot be moved past its neighbours.'));
    return;
  }
  if(segUiUniqueKey(turns, pos) === null) {
    segUiNotUnique();
    return;
  }
  segUiForgetKey(doc.manual, segUiUniqueKey(turns, secs[i].start));
  segUiRecordAssign(doc.manual, turns, pos, segUiAssignmentOf(secs[i]), true);
  doc.result.sections = moved;
  segUiCommit();
}

function segUiDiscardEmergent(secId) {
  var secs = SEG_UI.doc.result.sections, i = segUiSectionIndex(secId);
  if(i < 0 || secs.length < 2 || !secs[i].emergent) {
    return;
  }
  if(i === 0) {
    segUiMergeSections(0, 1);
  } else {
    segUiMergeSections(i - 1, i - 1);
  }
}

// Re-run the units of one section with a finer cut and a lower tick threshold
// (the cut distribution is then computed over that section alone)
function segUiRefineSection(secId) {
  var doc = SEG_UI.doc, r = doc.result, i = segUiSectionIndex(secId);
  if(i < 0) {
    return;
  }
  var sec = r.sections[i];
  var base = segParams(doc.unitOverrides);
  var over = {tau: segClamp(base.tau + 0.15, 0, 0.9),
              theta: segClamp(base.theta - 0.1, 0, 1)};
  var tok = segUiToken(), seq = SEG_UI.unitsSeq;
  function stale() {
    return !segUiTokenOk(tok) || seq !== SEG_UI.unitsSeq
      || SEG_UI.doc !== doc || doc.result !== r;
  }
  SEG_UI.busy = true;
  segUiStatus(gettext('Refining the segment…'));
  var deps = segMakeDeps({progress: segUiProgress});
  var metered = true;
  function mstop() {
    if(metered) {
      metered = false;
      SEG_UI_STATUS_METER.stop();
    }
  }
  SEG_UI_STATUS_METER.start();
  segUiMakeInput({overrides: over}).then(function(input) {
    if(stale()) {
      throw segUiStaleError();
    }
    return segBuildUnits([sec], input, deps, r.infos).then(function(units) {
      return segProposeTags(units, [sec], input, deps).then(function() {
        return units;
      });
    });
  }).then(function(units) {
    mstop();
    if(stale()) {
      throw segUiStaleError();
    }
    var kept = r.units.filter(function(u) {
      return u.sectionId !== sec.id;
    });
    var stamp = 'r' + (++SEG_UI.keyCounter) + '_';
    units.forEach(function(u, n) {
      u.id = stamp + n;
      u.sectionId = sec.id;
    });
    var res = {};
    for(var k in r) {
      res[k] = r[k];
    }
    res.units = kept.concat(units).sort(function(a, b) {
      return a.start - b.start;
    });
    doc.result = res;
    ++SEG_UI.unitsSeq;   // units refreshes started on the old result drop
    ++SEG_UI.version;
    segUiCacheCurrent();
    SEG_UI.busy = false;
    segUiStatus('');
    segRenderSections();
    if(typeof sugRecomputeSegmented === 'function') {
      sugRecomputeSegmented();
    }
  }).then(null, function(err) {
    mstop();
    if(err && err.stale && !segUiTokenOk(tok)) {
      return;   // session ended / newer edit: nothing to report
    }
    SEG_UI.busy = false;
    segUiStatus(err && err.stale ? '' : segUiErrText(err));
    segRenderSections();
  });
}


/*
 * Sections panel + separators
 */

function segUiEl(tag, cls, text) {
  var el = document.createElement(tag);
  if(cls) {
    el.className = cls;
  }
  if(text !== undefined && text !== null) {
    el.textContent = text;
  }
  return el;
}

function segUiClear(el) {
  while(el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function segUiSpans() {
  var out = [];
  if(!sug_session) {
    return out;
  }
  // Suggestions of every pane that shows segment-based coding (the same unit
  // in two panes counts once), plus the accepted highlights
  var seen = {}, panes = sug_session.panes || {};
  Object.keys(panes).forEach(function(k) {
    if(panes[k].algo !== 'segmented') {
      return;
    }
    (panes[k].suggestions || []).forEach(function(s) {
      var id = s.cStart + ':' + s.cEnd;
      if(!seen[id]) {
        seen[id] = true;
        out.push({cStart: s.cStart, cEnd: s.cEnd});
      }
    });
  });
  (sug_session.staged || []).forEach(function(s) {
    out.push({cStart: s.cStart, cEnd: s.cEnd});
  });
  return out;
}

function segUiOptionList(sections, dict) {
  var seen = {}, out = [];
  sections.forEach(function(s) {
    if(s.emergent && !seen[s.emergent.key]) {
      seen[s.emergent.key] = true;
      out.push({key: s.emergent.key,
                name: (dict[s.emergent.key] || s.emergent).name});
    }
  });
  for(var k in dict) {
    if(!seen[k] && dict[k].user) {
      out.push({key: k, name: dict[k].name});
    }
  }
  return out;
}

function segUiSelectEl(sec, sections, dict, guide) {
  var sel = segUiEl('select', 'form-control form-control-sm seg-row-select');
  sel.setAttribute('data-act', 'assign');
  var cur = segUiAssignmentOf(sec);
  function add(v, label) {
    var o = segUiEl('option', null, label);
    o.value = v;
    sel.appendChild(o);
  }
  guide.forEach(function(g) {
    add('s:' + g.id, g.name);
  });
  if(cur.segId !== null && !segUiFindById(guide, cur.segId)) {
    add('s:' + cur.segId, gettext('(removed topic)'));
  }
  segUiOptionList(sections, dict).forEach(function(e) {
    add('e:' + e.key, gettext('Emergent: %(name)s', {name: e.name}));
  });
  if(cur.segId === null && cur.emergentKey === null) {
    add('none', gettext('Unassigned'));
  }
  add('new', gettext('New topic…'));
  sel.value = cur.segId !== null ? 's:' + cur.segId
    : (cur.emergentKey !== null ? 'e:' + cur.emergentKey : 'none');
  return sel;
}

function segUiButton(act, text, title) {
  var b = segUiEl('button', 'btn btn-outline-secondary btn-sm', text);
  b.type = 'button';
  b.setAttribute('data-act', act);
  b.title = title;
  return b;
}

function segUiNamesOf(ids, guide) {
  return ids.map(function(id) {
    var g = segUiFindById(guide, id);
    return g ? g.name : gettext('(removed topic)');
  }).join(', ');
}

function segUiRenderList(box, sections, editable) {
  var doc = SEG_UI.doc, guide = segUiGuide();
  var dict = doc ? doc.emergent : {};
  var cov = segCoverage(sections, guide);
  if(sug_session && doc && doc.result) {
    var head = segUiEl('div', 'seg-header mb-2');
    var rerun = segUiButton('rerun', gettext('Re-run analysis'), gettext(
      'Run the segmentation again, e.g. after coding more highlights, to refresh the proposed tags'));
    rerun.disabled = !!SEG_UI.busy;
    head.appendChild(rerun);
    if(doc.cachedAt) {
      head.appendChild(segUiEl('span', 'text-muted small ml-2', gettext(
        'Saved analysis from %(when)s', {when: segUiAgoText(Date.now() - doc.cachedAt)})));
    }
    box.appendChild(head);
  }
  var line = segUiEl('div', 'seg-coverage');
  if(guide.length) {
    line.appendChild(segUiEl('span', null, gettext('In the script: %(present)s', {
      present: cov.present.length ? segUiNamesOf(cov.present, guide) : gettext('none')})));
    if(cov.missing.length) {
      line.appendChild(document.createElement('br'));
      line.appendChild(segUiEl('span', 'seg-missing', gettext('Missing: %(missing)s', {
        missing: segUiNamesOf(cov.missing, guide)})));
    }
  }
  box.appendChild(line);
  var turns = sug_session ? segUiTurns() : [];
  var spans = segUiSpans();
  var speakers = sug_session ? sug_session.speakers : [];
  sections.forEach(function(sec, idx) {
    var row = segUiEl('div', 'seg-section-row'
      + (sec.emergent ? ' seg-emergent' : '') + (editable ? '' : ' seg-readonly'));
    row.setAttribute('data-section-id', sec.id);
    var label = segUiEl('div', 'seg-row-label');
    if(sec.emergent) {
      label.appendChild(segUiEl('span', 'seg-badge-emergent', gettext('emergent')));
    }
    label.appendChild(document.createTextNode(sec.label || sec.name || ''));
    label.title = sec.label || sec.name || '';
    row.appendChild(label);
    if(editable) {
      var ctl = segUiEl('div', 'seg-row-controls');
      ctl.appendChild(segUiSelectEl(sec, sections, dict, guide));
      if(idx + 1 < sections.length) {
        ctl.appendChild(segUiButton('merge', '⇣', gettext('Merge with the next segment')));
      }
      ctl.appendChild(segUiButton('split', '✂', gettext('Split this segment (then click in the text)')));
      ctl.appendChild(segUiButton('refine', '⟳', gettext('Refine this segment (shorter suggested highlights)')));
      if(sec.emergent && sections.length > 1) {
        ctl.appendChild(segUiButton('discard', '✕', gettext('Discard as emergent: merge into the neighbouring segment')));
      }
      row.appendChild(ctl);
      var st = segUiSectionStats(sec, turns, speakers, spans);
      var meta = segUiEl('div', 'seg-row-meta');
      var bar = segUiEl('div', 'seg-cov');
      var fill = segUiEl('div', 'seg-cov-fill');
      fill.style.width = (st.codable ? Math.round(100 * st.covered / st.codable) : 0) + '%';
      bar.appendChild(fill);
      meta.appendChild(bar);
      meta.appendChild(segUiEl('span', null, gettext('%(n)s suggestions', {n: st.count})));
      row.appendChild(meta);
    }
    box.appendChild(row);
  });
}

function segRenderSections() {
  if(typeof document === 'undefined') {
    return;
  }
  var box = document.getElementById('seg-sections-box');
  if(!box) {
    return;
  }
  segUiClear(box);
  var hint = gettext('Start a suggestion session with Segment-based coding to segment this document.');
  var doc = SEG_UI.doc;
  if(sug_session && doc) {
    var secs = (doc.result && doc.result.sections) || doc.sections;
    if(!secs || !secs.length) {
      box.appendChild(segUiEl('p', 'text-muted small', hint));
      return;
    }
    if(!doc.result) {
      box.appendChild(segUiEl('p', 'text-muted small', gettext(
        'Saved segments from an earlier analysis. Run Segment-based coding to update them.')));
    }
    segUiRenderList(box, secs, segUiEditable());
    return;
  }
  box.appendChild(segUiEl('p', 'text-muted small', hint));
  if(typeof current_document !== 'undefined' && current_document) {
    var token = ++SEG_UI.cacheToken;
    segIdbGet(segUiDocKey(current_document)).then(function(rec) {
      if(token !== SEG_UI.cacheToken || SEG_UI.doc || !rec || !rec.sections
         || !rec.sections.length) {
        return;
      }
      segUiRenderList(box, rec.sections, false);
    });
  }
}

function segRemoveSeparators() {
  if(typeof document === 'undefined') {
    return;
  }
  var old = document.querySelectorAll('i.seg-separator');
  for(var i = 0; i < old.length; ++i) {
    if(old[i].parentNode) {
      old[i].parentNode.removeChild(old[i]);
    }
  }
}

// Mirrors sugInsertBracket for a zero-text separator element
function segUiInsertSeparator(prefix, byte, attrs) {
  var el = document.createElement('i');
  el.className = 'seg-separator';
  for(var k in attrs) {
    el.setAttribute('data-' + k, attrs[k]);
  }
  var pos = locatePos(byte, prefix);
  var node = (pos && pos[0]) ? splitAtPos(pos, false) : null;
  if(node && node.parentNode) {
    node.parentNode.insertBefore(el, node);
  } else {
    var root = prefix === 'R'
      ? document.getElementById('document-contents-b')
      : document.getElementById('document-contents');
    if(!root) {
      return null;
    }
    root.appendChild(el);
  }
  return el;
}

// (Re)insert one separator per section; idempotent. Also called by
// suggest.js at the end of sugSetSplit.
function segRenderSeparators() {
  if(typeof document === 'undefined') {
    return;
  }
  segRemoveSeparators();
  var doc = SEG_UI.doc;
  if(!sug_session || !doc) {
    return;
  }
  var secs = (doc.result && doc.result.sections) || doc.sections;
  if(!secs || !secs.length || (secs.length === 1 && !secs[0].segId
     && !secs[0].emergent)) {
    return;
  }
  var prefixes = [''];
  if(sug_session.split && document.getElementById('document-contents-b')) {
    prefixes.push('R');
  }
  var boc = sug_session.byteOfChar;
  prefixes.forEach(function(prefix) {
    for(var i = secs.length - 1; i >= 0; --i) {
      var s = secs[i];
      var el = segUiInsertSeparator(prefix, boc[Math.min(s.start, boc.length - 1)], {
        'seg-label': s.name || s.label || '', 'section-id': s.id,
        'first': i === 0 ? '1' : '0', 'emergent': s.emergent ? '1' : '0'});
      if(el) {
        el.setAttribute('title', s.label || '');
      }
    }
  });
}

function segUiScrollToSection(secId) {
  var el = document.querySelector('i.seg-separator[data-section-id="' + secId + '"]');
  if(el && el.scrollIntoView) {
    el.scrollIntoView({block: 'center', behavior: 'smooth'});
  }
}

function segUiSetSplitting(secId) {
  SEG_UI.splitting = secId;
  if(typeof document === 'undefined' || !document.body || !document.body.classList) {
    return;
  }
  if(secId) {
    document.body.classList.add('seg-splitting');
    segUiStatus(gettext('Click in the text where the new segment should start (Esc cancels).'));
  } else {
    document.body.classList.remove('seg-splitting');
  }
}

// Char index under a viewport point, or null
function segUiCharAtPoint(x, y) {
  var byte = sugCaretByte(x, y);
  if(byte === null || byte === undefined || !sug_session) {
    return null;
  }
  return segByteToChar(sug_session.byteOfChar, byte);
}

// Run the whole analysis again (ignoring the saved one) and refresh the
// segmented panes. Manual edits are part of the key and are re-applied.
function segUiRerun() {
  var doc = SEG_UI.doc;
  if(!sug_session || !doc || SEG_UI.busy) {
    return Promise.resolve();
  }
  SEG_UI.busy = true;
  segRenderSections();
  return segAnalyzeDocument({force: true}).then(function() {
    if(SEG_UI.doc !== doc || !sug_session) {
      return;
    }
    SEG_UI.busy = false;
    segUiStatus('');
    segRenderSections();
    if(typeof sugRecomputeSegmented === 'function') {
      sugRecomputeSegmented();
    }
  }, function(err) {
    if(SEG_UI.doc !== doc || !sug_session) {
      return;   // the session ended: nothing to report
    }
    SEG_UI.busy = false;
    segUiStatus(err && err.stale ? '' : segUiErrText(err));
    segRenderSections();
  });
}

function segUiOnSectionsClick(e) {
  var target = e.target;
  if(target.closest && target.closest('[data-act="rerun"]')) {
    segUiRerun();
    return;
  }
  var actEl = target.closest ? target.closest('[data-act]') : null;
  var row = target.closest ? target.closest('.seg-section-row') : null;
  if(!row) {
    return;
  }
  var id = row.getAttribute('data-section-id');
  if(!actEl) {
    segUiScrollToSection(id);
    return;
  }
  if(actEl.tagName === 'SELECT' || !segUiEditable()) {
    return;
  }
  var act = actEl.getAttribute('data-act'), i = segUiSectionIndex(id);
  if(act === 'merge') {
    segUiMergeSections(i, i);
  } else if(act === 'split') {
    segUiSetSplitting(id);
  } else if(act === 'refine') {
    segUiRefineSection(id);
  } else if(act === 'discard') {
    segUiDiscardEmergent(id);
  }
}

function segUiOnSectionsChange(e) {
  var sel = e.target;
  if(!sel || sel.getAttribute('data-act') !== 'assign') {
    return;
  }
  var row = sel.closest('.seg-section-row');
  if(row) {
    segUiAssignSection(row.getAttribute('data-section-id'), sel.value);
  }
}

// Capturing click while "split" is armed
function segUiOnDocumentClick(e) {
  if(!SEG_UI.splitting) {
    return;
  }
  var inside = e.target.closest && e.target.closest('#document-contents');
  if(!inside) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  var secId = SEG_UI.splitting;
  segUiSetSplitting(null);
  segUiStatus('');
  var ch = segUiCharAtPoint(e.clientX, e.clientY);
  if(ch === null || !segUiEditable()) {
    return;
  }
  var pos = segUiNearestTurnStart(segUiTurns(), ch);
  if(pos !== null) {
    segUiSplitAt(secId, pos);
  }
}

function segUiOnMouseDown(e) {
  var sep = e.target.closest ? e.target.closest('i.seg-separator') : null;
  if(!sep || e.button !== 0 || sep.getAttribute('data-first') === '1'
     || !segUiEditable()) {
    return;
  }
  e.preventDefault();
  SEG_UI.drag = {id: sep.getAttribute('data-section-id'), x: e.clientX, y: e.clientY};
  document.body.classList.add('seg-dragging');
}

function segUiOnMouseUp(e) {
  var drag = SEG_UI.drag;
  if(!drag) {
    return;
  }
  SEG_UI.drag = null;
  document.body.classList.remove('seg-dragging');
  if(Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 4
     || !segUiEditable()) {
    return;
  }
  var ch = segUiCharAtPoint(e.clientX, e.clientY);
  if(ch === null) {
    return;
  }
  var pos = segUiNearestTurnStart(segUiTurns(), ch);
  if(pos !== null) {
    segUiMoveBoundary(drag.id, pos);
  }
}


/*
 * Emergent segments: confirmation before saving highlights, and recording
 * of saved highlights as prototypes
 */

function segBeforeSave(proceed) {
  var doc = SEG_UI.doc;
  if(!doc || !doc.result || !segCanEditMeta()) {
    proceed();
    return;
  }
  if(!sug_session || !sug_session.staged || !sug_session.staged.length) {
    proceed();   // nothing to save: nothing to confirm
    return;
  }
  var groups = segUiPendingGroups(doc.result.sections, doc.emergent);
  if(!groups.length) {
    proceed();
    return;
  }
  segUiStatus(gettext('Checking for similar topics…'));
  segUiFindMerges(groups, doc.result).then(function() {
    segUiStatus('');
    segUiOpenEmergentModal(groups, proceed);
  }).then(null, function(err) {
    // Never leave the stop dialog dead: report and carry on without asking
    console.error('Emergent segments confirmation failed:', err);
    segUiStatus(segUiErrText(err));
    proceed();
  });
}

// Default names of the new segments must be unique (case-insensitive): the
// later ones get " (2)", " (3)"...
function segUiUniqueNames(groups) {
  var used = {};
  groups.forEach(function(g) {
    var base = g.name || '', name = base, n = 1;
    while(name && used[name.toLowerCase()]) {
      name = base + ' (' + (++n) + ')';
    }
    g.name = name;
    if(name) {
      used[name.toLowerCase()] = true;
    }
  });
  return groups;
}

// Pre-select "merge into Y" when a similar guide segment exists (embeddings
// are optional here: failures just mean no suggestion)
function segUiFindMerges(groups, result) {
  var guide = segUiGuide();
  if(!guide.length || !result.guideVecs) {
    return Promise.resolve();
  }
  var texts = groups.map(function(g) {
    return [g.name, g.description, g.question].filter(Boolean).join('. ');
  });
  return Promise.resolve().then(function() {
    return segMakeDeps().embed(texts);
  }).then(function(vecs) {
    groups.forEach(function(g, i) {
      var m = segSimilarSegment(segVecNorm(vecs[i]), guide, result.guideVecs, 0.85);
      if(m) {
        g.merge = m;
        g.choice = 'merge';
      }
    });
  }).then(null, function(err) {
    console.warn('Similar segment check failed:', segUiErrText(err));
  });
}

function segUiOpenEmergentModal(groups, proceed) {
  var E = SEG_UI.emergent, guide = segUiGuide();
  segUiUniqueNames(groups);
  E.groups = groups;
  E.proceed = proceed;
  E.working = false;
  document.getElementById('seg-emergent-title').textContent = gettext(
    '%(n)s new emergent topics will be created in the project guide. Confirm?',
    {n: groups.length});
  var rows = document.getElementById('seg-emergent-rows');
  segUiClear(rows);
  groups.forEach(function(g, idx) {
    var row = segUiEl('div', 'seg-emergent-row');
    row.setAttribute('data-idx', idx);
    function field(labelText, tag, f, value) {
      row.appendChild(segUiEl('label', null, labelText));
      var input = segUiEl(tag, 'form-control form-control-sm');
      if(tag === 'textarea') {
        input.rows = 2;
      }
      input.value = value;
      input.setAttribute('data-f', f);
      row.appendChild(input);
    }
    field(gettext('Name'), 'input', 'name', g.name);
    field(gettext('Description'), 'textarea', 'description', g.description);
    field(gettext('Question'), 'input', 'question', g.question);
    if(g.merge) {
      var target = segUiFindById(guide, g.merge.segId);
      var box = segUiEl('div', 'seg-merge-choice');
      [['new', gettext('Create a new topic')],
       ['merge', gettext('Merge into «%(name)s»', {name: target ? target.name : ''})]
      ].forEach(function(opt) {
        var lab = segUiEl('label', 'mr-3');
        var radio = segUiEl('input');
        radio.type = 'radio';
        radio.name = 'seg-em-choice-' + idx;
        radio.value = opt[0];
        radio.checked = g.choice === opt[0];
        radio.setAttribute('data-f', 'choice');
        lab.appendChild(radio);
        lab.appendChild(document.createTextNode(' ' + opt[1]));
        box.appendChild(lab);
      });
      row.appendChild(box);
    }
    rows.appendChild(row);
  });
  segUiEmergentError('');
  segUiEmergentSetBusy(false);
  $('#seg-emergent-modal').modal('show');
}

function segUiEmergentError(msg) {
  var el = document.getElementById('seg-emergent-error');
  el.textContent = msg || '';
  el.style.display = msg ? '' : 'none';
}

function segUiEmergentSetBusy(busy) {
  SEG_UI.emergent.working = busy;
  ['seg-emergent-yes', 'seg-emergent-discard', 'seg-emergent-back'].forEach(function(id) {
    document.getElementById(id).disabled = busy;
  });
}

// Read the rows back into the groups; returns an error message or null
function segUiReadEmergentRows() {
  var E = SEG_UI.emergent;
  var rows = document.getElementById('seg-emergent-rows').children;
  var seen = {};
  for(var i = 0; i < E.groups.length; ++i) {
    var g = E.groups[i], row = rows[i];
    g.name = row.querySelector('[data-f="name"]').value.trim();
    g.description = row.querySelector('[data-f="description"]').value.trim();
    g.question = row.querySelector('[data-f="question"]').value.trim();
    var checked = row.querySelector('[data-f="choice"]:checked');
    g.choice = checked ? checked.value : 'new';
    if(g.choice === 'new') {
      if(!g.name) {
        return gettext('Every new topic needs a name.');
      }
      if(seen[g.name.toLowerCase()]) {
        return gettext('Two new topics have the same name: %(name)s', {name: g.name});
      }
      seen[g.name.toLowerCase()] = true;
    }
  }
  return null;
}

function segUiEmergentYes() {
  var E = SEG_UI.emergent, doc = SEG_UI.doc;
  if(E.working || !doc || !doc.result) {
    return;
  }
  var problem = segUiReadEmergentRows();
  if(problem) {
    segUiEmergentError(problem);
    return;
  }
  segUiEmergentError('');
  segUiEmergentSetBusy(true);
  segApiGuide().then(function(current) {
    var list = current.map(function(s) {
      return {id: s.id, name: s.name, description: s.description,
              guide_questions: s.guide_questions, source: s.source};
    });
    E.groups.forEach(function(g) {
      if(g.choice !== 'new' || segUiFindByName(list, g.name)) {
        return;   // same name as an existing segment: merged into it
      }
      list.push({name: g.name, description: g.description,
                 guide_questions: g.question ? [g.question] : [],
                 source: g.user ? 'manual' : 'emergent'});
    });
    return segApiSaveGuide(list);
  }).then(function(saved) {
    window.taguette_thematic_segments = saved;
    var failure = null;
    try {
      var mapping = {};
      E.groups.forEach(function(g) {
        var target = null;
        if(g.choice === 'merge' && g.merge) {
          target = segUiFindById(saved, g.merge.segId);
        }
        target = target || segUiFindByName(saved, g.name);
        if(target) {
          mapping[g.key] = {segId: target.id, name: target.name};
        }
      });
      segUiRemap(doc.result.sections, doc.manual, doc.emergent, mapping);
      doc.sections = doc.result.sections;
      segUiRefreshStats(doc.result);
      // The guide changed: the analysis is rebuilt on the next run
      segUiCacheDrop(doc.docId);
      doc.resultKey = null;
      segUiPersist();
      segRenderSections();
      segRenderSeparators();
    } catch(err) {
      console.error('Updating the sections after saving the guide failed:', err);
      failure = err;
    }
    // The guide was saved: whatever happened locally, the save goes on
    segUiEmergentSetBusy(false);
    if(failure) {
      segUiEmergentError(segUiErrText(failure));
      segUiStatus(segUiErrText(failure));
    }
    var proceed = E.proceed;
    E.proceed = null;
    $('#seg-emergent-modal').modal('hide');
    if(proceed) {
      proceed();
    }
  }, function(err) {
    segUiEmergentSetBusy(false);
    segUiEmergentError(segUiErrText(err));
  });
}

function segUiEmergentBack() {
  var E = SEG_UI.emergent;
  if(E.working) {
    return;
  }
  E.proceed = null;
  $('#seg-emergent-modal').modal('hide');
}

function segUiEmergentDiscard() {
  var E = SEG_UI.emergent;
  if(E.working) {
    return;
  }
  var proceed = E.proceed;
  E.proceed = null;
  $('#seg-emergent-modal').modal('hide');
  if(proceed) {
    proceed();
  }
}

// Record the vectors and tag co-occurrences of saved suggestions, to improve
// later documents (prototype extras + tag/segment co-occurrence)
function segRecordSaved(stagedList) {
  var doc = SEG_UI.doc, embKey = segUiEmbKey();
  if(!doc || !doc.result || !embKey || !stagedList || !stagedList.length) {
    return Promise.resolve();
  }
  // Everything that depends on the open document is captured NOW: by the time
  // the IndexedDB reads settle, the session may have ended (save-and-navigate)
  var units = doc.result.units || [], docId = doc.docId;
  var items = [];
  stagedList.forEach(function(st) {
    var sec = segSectionAt(st.cStart);
    if(!sec || sec.segId === null || sec.segId === undefined) {
      return;
    }
    var best = null, bo = 0;
    units.forEach(function(u) {
      var o = Math.min(u.end, st.cEnd) - Math.max(u.start, st.cStart);
      if(o > bo && u.vec) {
        bo = o;
        best = u;
      }
    });
    if(best) {
      items.push({segId: sec.segId, vec: best.vec,
                  tagIds: (st.tags || []).map(function(t) {
                    return parseInt(t, 10);
                  })});
    }
  });
  if(!items.length) {
    return Promise.resolve();
  }
  return Promise.all([segIdbGet('seg|protos|' + embKey), segIdbGet('seg|cooc')])
    .then(function(r) {
      var protos = r[0] || {}, cooc = r[1] || {};
      items.forEach(function(it) {
        segUiAddPrototype(protos, cooc, it.segId, docId, it.vec, it.tagIds);
      });
      SEG_UI.extrasRaw = {embKey: embKey, protos: protos, cooc: cooc};
      segIdbPut('seg|protos|' + embKey, protos);
      segIdbPut('seg|cooc', cooc);
    });
}


/*
 * Script & segments modal
 */

var SEG_UI_KINDS = {
  script: 'Script', research_questions: 'Research questions',
  hypotheses: 'Hypotheses', other: 'Other'
};

function segUiScriptError(msg) {
  var el = document.getElementById('seg-script-error');
  el.textContent = msg || '';
  el.style.display = msg ? '' : 'none';
}

function segUiScriptStatus(msg) {
  document.getElementById('seg-script-status').textContent = msg || '';
}

function segUiGuideToRows(guide) {
  return guide.map(function(g) {
    return {id: g.id, name: g.name, description: g.description || '',
            questions: (g.guide_questions || []).join('\n'),
            source: g.source || 'guide'};
  });
}

function segUiRowsToGuide(rows) {
  return rows.map(function(r) {
    var out = {name: r.name.trim(), description: r.description,
               guide_questions: r.questions.split('\n').map(function(q) {
                 return q.trim();
               }).filter(Boolean), source: r.source || 'guide'};
    if(r.id !== null && r.id !== undefined) {
      out.id = r.id;
    }
    return out;
  });
}

// Client-side check mirroring the server's rules; returns a message or null
function segUiValidateRows(rows) {
  var seen = {};
  for(var i = 0; i < rows.length; ++i) {
    var name = rows[i].name.trim();
    if(!name) {
      return gettext('Topic %(n)s: the name cannot be empty.', {n: i + 1});
    }
    if(seen[name.toLowerCase()]) {
      return gettext('Duplicate topic name: %(name)s', {name: name});
    }
    seen[name.toLowerCase()] = true;
  }
  return null;
}

function segUiDocCount(segId) {
  var n = 0, idx = SEG_UI.script.index || {};
  for(var d in idx) {
    if(idx[d].indexOf(segId) !== -1) {
      ++n;
    }
  }
  return n;
}

function segUiRenderSupport() {
  var list = document.getElementById('seg-support-list');
  segUiClear(list);
  var docs = window.taguette_support_documents || [];
  var editable = segCanEditMeta();
  if(!docs.length) {
    list.appendChild(segUiEl('li', 'list-group-item text-muted small',
                             gettext('No support documents yet.')));
  }
  docs.forEach(function(d) {
    var li = segUiEl('li', 'list-group-item d-flex align-items-center py-1');
    li.appendChild(segUiEl('span', 'mr-auto', d.name));
    li.appendChild(segUiEl('span', 'badge badge-light mr-2',
                           gettext(SEG_UI_KINDS[d.kind] || d.kind)));
    li.appendChild(segUiEl('span', 'text-muted small mr-2',
                           Math.max(1, Math.round((d.size || 0) / 1024)) + ' KB'));
    if(editable) {
      var del = segUiEl('button', 'btn btn-outline-danger btn-sm py-0', '✕');
      del.type = 'button';
      del.title = gettext('Delete this document');
      del.setAttribute('data-act', 'delete-doc');
      del.setAttribute('data-id', d.id);
      li.appendChild(del);
    }
    list.appendChild(li);
  });
}

function segUiRenderGuideRows() {
  var box = document.getElementById('seg-guide-rows');
  segUiClear(box);
  var rows = SEG_UI.script.rows, editable = segCanEditMeta();
  if(!rows.length) {
    box.appendChild(segUiEl('p', 'text-muted small',
      gettext('No topics yet. Add them by hand or generate them from a support document.')));
  }
  rows.forEach(function(r, idx) {
    var el = segUiEl('div', 'seg-guide-row');
    el.setAttribute('data-idx', idx);
    var head = segUiEl('div', 'seg-guide-head');
    head.appendChild(segUiEl('span', 'badge badge-secondary mr-2', r.source));
    if(r.source === 'emergent' && r.id !== null && r.id !== undefined) {
      head.appendChild(segUiEl('span', 'text-muted small', gettext(
        'in %(n)s documents', {n: segUiDocCount(r.id)})));
    }
    head.appendChild(segUiEl('span', 'seg-guide-spacer'));
    if(editable) {
      [['up', '↑', gettext('Move up')], ['down', '↓', gettext('Move down')],
       ['merge', gettext('Merge with next'), gettext('Merge with the next topic')],
       ['delete', '✕', gettext('Delete this topic')]
      ].forEach(function(b) {
        var btn = segUiEl('button', 'btn btn-outline-secondary btn-sm', b[1]);
        btn.type = 'button';
        btn.setAttribute('data-act', b[0]);
        btn.title = b[2];
        if((b[0] === 'up' && idx === 0)
           || ((b[0] === 'down' || b[0] === 'merge') && idx === rows.length - 1)) {
          btn.disabled = true;
        }
        head.appendChild(btn);
      });
    }
    el.appendChild(head);
    function field(tag, f, value, placeholder, nrows) {
      var input = segUiEl(tag, 'form-control form-control-sm mb-1');
      if(nrows) {
        input.rows = nrows;
      }
      input.value = value;
      input.placeholder = placeholder;
      input.setAttribute('data-f', f);
      input.disabled = !editable;
      el.appendChild(input);
    }
    field('input', 'name', r.name, gettext('Topic name'));
    field('textarea', 'description', r.description, gettext('Description'), 2);
    field('textarea', 'questions', r.questions,
          gettext('Questions of the script, one per line'), 3);
    box.appendChild(el);
  });
}

function segOpenScriptModal() {
  var S = SEG_UI.script;
  var editable = segCanEditMeta();
  S.rows = segUiGuideToRows(segUiGuide());
  S.dirty = false;
  S.allowClose = false;
  S.open = true;
  segUiScriptError('');
  segUiScriptStatus('');
  document.getElementById('seg-script-notice').style.display = 'none';
  document.getElementById('seg-guide-gen-status').textContent = '';
  document.getElementById('seg-script-modal').classList.toggle('seg-readonly', !editable);
  document.getElementById('seg-script-readonly-note').style.display = editable ? 'none' : '';
  segUiRenderSupport();
  segUiRenderGuideRows();
  segIdbGet('seg|index').then(function(index) {
    S.index = index || {};
    if(S.open) {
      segUiRenderGuideRows();
    }
  });
  $('#seg-script-modal').modal({backdrop: 'static'});
  segApiSupportDocs().then(function(docs) {
    window.taguette_support_documents = docs;
    if(S.open) {
      segUiRenderSupport();
    }
  }, function() { /* the page's copy is shown */ });
}

function segUiScriptCloseGuard(e) {
  var S = SEG_UI.script;
  if(S.dirty && !S.allowClose && !window.confirm(gettext(
       'You have unsaved changes in the topic guide. Close without saving?'))) {
    e.preventDefault();
    return;
  }
  S.allowClose = false;
}

function segUiScriptClosed() {
  SEG_UI.script.open = false;
  SEG_UI.script.dirty = false;
}

function segUiRefreshSupportDocs() {
  return segApiSupportDocs().then(function(docs) {
    window.taguette_support_documents = docs;
    segUiRenderSupport();
  });
}

function segUiSupportAction(promise, okMsg, onOk) {
  var S = SEG_UI.script;
  if(S.busy) {
    return;
  }
  S.busy = true;
  segUiScriptError('');
  segUiScriptStatus(gettext('Working…'));
  promise().then(function() {
    if(onOk) {
      onOk();   // clear the form only once the server accepted it
    }
    return segUiRefreshSupportDocs();
  }).then(function() {
    S.busy = false;
    segUiScriptStatus(okMsg);
  }, function(err) {
    S.busy = false;
    segUiScriptStatus('');
    segUiScriptError(segUiErrText(err));
  });
}

function segUiUploadSupport() {
  var input = document.getElementById('seg-support-file');
  var file = input.files && input.files[0];
  if(!file) {
    segUiScriptError(gettext('Choose a file to upload.'));
    return;
  }
  var kind = document.getElementById('seg-upload-kind').value;
  segUiSupportAction(function() {
    return segApiUploadSupportFile(file, file.name, kind);
  }, gettext('Document uploaded.'), function() {
    input.value = '';
  });
}

function segUiPasteSupport() {
  var name = document.getElementById('seg-paste-name').value.trim();
  var text = document.getElementById('seg-paste-text').value;
  var kind = document.getElementById('seg-paste-kind').value;
  if(!name || !text.trim()) {
    segUiScriptError(gettext('Give the pasted document a name and some text.'));
    return;
  }
  segUiSupportAction(function() {
    return segApiAddSupportText(name, kind, text);
  }, gettext('Document added.'), function() {
    document.getElementById('seg-paste-name').value = '';
    document.getElementById('seg-paste-text').value = '';
  });
}

function segUiScriptSave() {
  var S = SEG_UI.script;
  if(S.busy || !segCanEditMeta()) {
    return;
  }
  var problem = segUiValidateRows(S.rows);
  if(problem) {
    segUiScriptError(problem);
    return;
  }
  S.busy = true;
  segUiScriptError('');
  segUiScriptStatus(gettext('Saving…'));
  segApiSaveGuide(segUiRowsToGuide(S.rows)).then(function(saved) {
    window.taguette_thematic_segments = saved;
    S.rows = segUiGuideToRows(saved);
    S.dirty = false;
    S.busy = false;
    document.getElementById('seg-script-notice').style.display = 'none';
    segUiScriptStatus(gettext('Saved.'));
    segUiRenderGuideRows();
    segRenderSections();
  }, function(err) {
    S.busy = false;
    segUiScriptStatus('');
    segUiScriptError(segUiErrText(err));
  });
}

function segUiScriptGenerate() {
  var S = SEG_UI.script;
  if(S.generating || !segCanEditMeta()) {
    return;
  }
  var status = document.getElementById('seg-guide-gen-status');
  var button = document.getElementById('seg-guide-generate');
  S.generating = true;
  segUiScriptError('');
  status.textContent = gettext('Generating…');
  button.disabled = true;
  function done() {
    S.generating = false;
    status.textContent = '';
    button.disabled = false;
  }
  segApiSupportDocs().then(function(docs) {
    if(!docs.length) {
      throw new Error(gettext('Add a support document (for example the interview script) first.'));
    }
    return segGenerateGuide(docs, segUiTagList());
  }).then(function(res) {
    done();
    if(S.rows.length && !window.confirm(gettext(
         'Replace the topics in the editor with the generated ones?'))) {
      return;
    }
    var old = S.rows;
    S.rows = res.segments.map(function(g) {
      var match = segUiFindByName(old, g.name);
      return {id: match ? match.id : null, name: g.name,
              description: g.description || '',
              questions: (g.guide_questions || []).join('\n'), source: 'guide'};
    });
    S.dirty = true;
    segUiRenderGuideRows();
  }, function(err) {
    done();
    segUiScriptError(segUiErrText(err));
  });
}

function segUiOnGuideRowsClick(e) {
  var btn = e.target.closest ? e.target.closest('[data-act]') : null;
  var rowEl = e.target.closest ? e.target.closest('.seg-guide-row') : null;
  if(!btn || !rowEl || !segCanEditMeta()) {
    return;
  }
  var rows = SEG_UI.script.rows, i = parseInt(rowEl.getAttribute('data-idx'), 10);
  var act = btn.getAttribute('data-act'), tmp;
  if(act === 'up' && i > 0) {
    tmp = rows[i - 1]; rows[i - 1] = rows[i]; rows[i] = tmp;
  } else if(act === 'down' && i + 1 < rows.length) {
    tmp = rows[i + 1]; rows[i + 1] = rows[i]; rows[i] = tmp;
  } else if(act === 'delete') {
    rows.splice(i, 1);
  } else if(act === 'merge' && i + 1 < rows.length) {
    var a = rows[i], b = rows[i + 1];
    if(b.id !== null && b.id !== undefined && !window.confirm(gettext(
         'Merge «%(b)s» into «%(a)s»? Segments of documents that were assigned to «%(b)s» will be reassigned.',
         {a: a.name || '', b: b.name || ''}))) {
      return;
    }
    a.description = [a.description, b.description].filter(Boolean).join(' ');
    a.questions = [a.questions, b.questions].filter(Boolean).join('\n');
    rows.splice(i + 1, 1);
  } else {
    return;
  }
  SEG_UI.script.dirty = true;
  segUiRenderGuideRows();
}

function segUiOnGuideRowsInput(e) {
  var f = e.target.getAttribute && e.target.getAttribute('data-f');
  var rowEl = e.target.closest ? e.target.closest('.seg-guide-row') : null;
  if(!f || !rowEl) {
    return;
  }
  SEG_UI.script.rows[parseInt(rowEl.getAttribute('data-idx'), 10)][f] = e.target.value;
  SEG_UI.script.dirty = true;
}

function segUiOnSupportClick(e) {
  var btn = e.target.closest ? e.target.closest('[data-act="delete-doc"]') : null;
  if(!btn || !segCanEditMeta()) {
    return;
  }
  if(!window.confirm(gettext('Delete this support document?'))) {
    return;
  }
  var id = btn.getAttribute('data-id');
  segUiSupportAction(function() {
    return segApiDeleteSupportDoc(id);
  }, gettext('Document deleted.'));
}

// Recompute the segmented panes (debounced) when the guide or the section
// parameters changed under an open session: the cached suggestions are keyed
// on segResultKey(), so this is a cache miss only when something changed.
function segUiScheduleRecompute() {
  if(typeof setTimeout !== 'function') {
    return;
  }
  if(SEG_UI.recomputeTimer) {
    clearTimeout(SEG_UI.recomputeTimer);
  }
  SEG_UI.recomputeTimer = setTimeout(function() {
    SEG_UI.recomputeTimer = null;
    var doc = SEG_UI.doc;
    if(!sug_session || !doc || typeof sugRecomputeSegmented !== 'function'
       || typeof sugHasSegmentedPane !== 'function' || !sugHasSegmentedPane()) {
      return;
    }
    if(doc.result && doc.resultKey === segResultKey()) {
      return;   // nothing the sections depend on changed
    }
    sugRecomputeSegmented();
  }, 800);
}

// The guide or the section parameters changed: in-flight runs used the old
// ones, so drop them (and the busy flag they held) and recompute
function segUiInputsChanged() {
  if(!SEG_UI.doc) {
    return;
  }
  segUiInvalidate();
  SEG_UI.running = null;
  if(SEG_UI.busy) {
    SEG_UI.busy = false;
    segUiStatus('');
  }
  segUiScheduleRecompute();
}

function segUiOnGuideEvent() {
  var S = SEG_UI.script;
  segUiInputsChanged();
  if(S.open) {
    if(S.dirty) {
      var n = document.getElementById('seg-script-notice');
      n.textContent = gettext('The topic guide was changed by someone else. Your edits are kept; saving will overwrite their changes.');
      n.style.display = '';
    } else {
      S.rows = segUiGuideToRows(segUiGuide());
      segUiRenderGuideRows();
    }
  }
  segRenderSections();
}

function segUiOnSupportEvent() {
  if(SEG_UI.script.open) {
    segUiRenderSupport();
  }
}


/*
 * Evaluation (settings, Segmentation tab)
 */

// Rows of the metrics table: precision and recall only
function segUiPct(v) {
  return Math.round(100 * v) + '%';
}

// Rows of the metrics table: one per level, with precision and recall
function segUiMetricRows(m) {
  var seg = m.segments || {}, hl = m.highlights || {};
  return [
    {label: gettext('Segments'), precision: segUiPct(seg.precision || 0),
     recall: segUiPct(seg.recall || 0)},
    {label: gettext('Suggested highlights'), precision: segUiPct(hl.precision || 0),
     recall: segUiPct(hl.recall || 0)}
  ];
}

function segUiHasHighlights() {
  return typeof highlights !== 'undefined' && !!highlights
    && Object.keys(highlights).length > 0;
}

// Why an evaluation cannot start right now (null when it can)
function segUiEvalBlocker() {
  if(!sug_session) {
    return gettext('Start a suggestion session on a document first.');
  }
  if(!segUiHasHighlights()) {
    return gettext('This document has no highlights to compare with.');
  }
  if(!segUiEnsureDoc()) {
    return gettext('The segmentation data isn\'t ready yet; start a session again.');
  }
  return null;
}

function segUiRealHighlights() {
  var boc = sug_session.byteOfChar, out = [];
  for(var id in highlights) {
    var h = highlights[id];
    out.push({id: h.id, cStart: segByteToChar(boc, h.start_offset),
              cEnd: segByteToChar(boc, h.end_offset),
              tagIds: (h.tags || []).map(function(t) {
                return parseInt(t, 10);
              })});
  }
  return out;
}

// One evaluation run on the open document with its own highlights hidden
// from the pipeline; the session's suggestions are not touched
function segUiEvalRun(overrides, progress) {
  var deps = segMakeDeps({progress: progress});
  var sess = sug_session, edit = sess ? (sess.editGen || 0) : 0;
  function ended() {
    return !sug_session || sug_session !== sess
      || (sess.editGen || 0) !== edit;
  }
  if(ended()) {
    return Promise.reject(segUiStaleError());
  }
  var hls;
  try {
    hls = segUiRealHighlights();
  } catch(err) {
    return Promise.reject(err);
  }
  segUiRunBegin();   // breakers reset only when no analysis is in flight
  var p;
  try {
    p = segUiMakeInput({overrides: overrides, excludeDocId: current_document,
                        manual: null});
  } catch(err) {
    segUiRunEnd();
    return Promise.reject(err);
  }
  p = p.then(function(input) {
    if(ended()) {
      throw segUiStaleError();
    }
    // segmentation only: no tag calls at all
    // within one grid run the sections stage is shared by every tau
    var cache = SEG_UI.evalSections, key = null, srP;
    if(cache) {
      var kp = {};
      for(var pk in input.params) {
        if(pk !== 'tau' && pk !== 'theta') {
          kp[pk] = input.params[pk];
        }
      }
      key = JSON.stringify(kp);
    }
    if(cache && cache[key]) {
      srP = Promise.resolve(cache[key]);
    } else {
      srP = segRunSections(input, deps).then(function(sr) {
        if(cache) {
          cache[key] = sr;
        }
        return sr;
      });
    }
    return srP.then(function(sr) {
      return segRunUnits(sr, input, deps, {tags: false});
    }).then(function(res) {
      if(ended()) {
        throw segUiStaleError();
      }
      return segEvaluate(res, hls, {plainText: sess.plainText,
                                    turns: input.turns});
    });
  });
  return p.then(function(m) {
    segUiRunEnd();
    return m;
  }, function(err) {
    segUiRunEnd();
    throw err;
  });
}

function segUiEvalRenderMetrics(host, m) {
  var table = segUiEl('table', 'table table-sm seg-eval-table');
  var head = segUiEl('tr');
  ['', gettext('Precision'), gettext('Recall')].forEach(function(h) {
    head.appendChild(segUiEl('th', null, h));
  });
  table.appendChild(head);
  segUiMetricRows(m).forEach(function(r) {
    var tr = segUiEl('tr');
    tr.appendChild(segUiEl('td', null, r.label));
    tr.appendChild(segUiEl('td', null, r.precision));
    tr.appendChild(segUiEl('td', null, r.recall));
    table.appendChild(tr);
  });
  host.appendChild(table);
  host.appendChild(segUiEl('p', 'text-muted small mb-1', gettext(
    'Compared with %(n)s human segments built from %(m)s highlights.',
    {n: m.nHumanSegments || 0, m: m.nHighlights || 0})));
  host.appendChild(segUiEl('p', 'text-muted small', gettext(
    'Consecutive highlights that share a tag form one human segment. A segment boundary is expected where the interviewer moves on (the turn change before the question that leads into the next segment). Precision ignores boundaries in text that has no highlights.')));
}

function segUiEvalRenderGrid(host, grid, onApply) {
  var cur = segParams();
  function same(a, b) {
    return ['tau', 'kappa', 'lambda'].every(function(k) {
      return Math.abs(a[k] - b[k]) < 1e-9;
    });
  }
  function f1Of(r, level) {
    var x = r.metrics && r.metrics[level];
    return x && typeof x.f1 === 'number' ? x.f1 : 0;
  }
  var order = grid.rows.map(function(r, i) {
    return {r: r, i: i};
  });
  order.sort(function(a, b) {
    return (f1Of(b.r, 'segments') - f1Of(a.r, 'segments'))
      || (f1Of(b.r, 'highlights') - f1Of(a.r, 'highlights')) || (a.i - b.i);
  });
  var rows = [];
  if(grid.best) {
    rows.push(grid.best);
    // rows sharing the best kappa/lambda (the tau sweep), by highlights F1
    grid.rows.map(function(r, i) {
      return {r: r, i: i};
    }).filter(function(o) {
      return o.r !== grid.best && grid.best.params
        && o.r.params.kappa === grid.best.params.kappa
        && o.r.params.lambda === grid.best.params.lambda;
    }).sort(function(a, b) {
      return (f1Of(b.r, 'highlights') - f1Of(a.r, 'highlights')) || (a.i - b.i);
    }).forEach(function(o) {
      rows.push(o.r);
    });
  }
  order.forEach(function(o) {
    if(rows.length < 6 && rows.indexOf(o.r) === -1) {
      rows.push(o.r);
    }
  });
  rows = rows.slice(0, 6);
  var table = segUiEl('table', 'table table-sm seg-eval-table');
  var head = segUiEl('tr');
  ['tau', 'kappa', 'lambda', gettext('Segments P'), gettext('Segments R'),
   gettext('Highlights P'), gettext('Highlights R'), '', ''].forEach(function(h) {
    head.appendChild(segUiEl('th', null, h));
  });
  table.appendChild(head);
  function addRow(row, isCurrent) {
    var params = row.params, m = row.metrics;
    var seg = m.segments || {}, hl = m.highlights || {};
    var tr = segUiEl('tr');
    [params.tau, params.kappa, params.lambda].forEach(function(v) {
      tr.appendChild(segUiEl('td', null, String(v)));
    });
    [seg.precision, seg.recall, hl.precision, hl.recall].forEach(function(v) {
      tr.appendChild(segUiEl('td', null, segUiPct(v || 0)));
    });
    var note = segUiEl('td');
    if(!isCurrent && row === grid.best) {
      note.appendChild(segUiEl('span', 'badge badge-success', gettext('best')));
    }
    tr.appendChild(note);
    var td = segUiEl('td');
    if(isCurrent || same(params, cur)) {
      td.appendChild(segUiEl('em', 'text-muted', gettext('current')));
    } else {
      var b = segUiEl('button', 'btn btn-outline-primary btn-sm py-0', gettext('Apply'));
      b.type = 'button';
      b.addEventListener('click', function() {
        onApply(row);
      });
      td.appendChild(b);
    }
    tr.appendChild(td);
    table.appendChild(tr);
  }
  if(SEG_UI.evalState.metrics) {
    addRow({params: cur, metrics: SEG_UI.evalState.metrics}, true);
  }
  rows.forEach(function(r) {
    addRow(r, false);
  });
  host.appendChild(table);
  (grid.edge || []).forEach(function(k) {
    host.appendChild(segUiEl('p', 'text-muted small mb-1', gettext(
      'The best %(param)s is at the edge of the tested range; the optimum may lie beyond it.',
      {param: k})));
  });
}

function segEvalPanelBuild(box, opts) {
  opts = opts || {};
  if(typeof document === 'undefined') {
    return;
  }
  segUiClear(box);
  box.appendChild(segUiEl('p', 'text-muted small', gettext(
    'Compare the segments and suggested highlights the analysis would produce with the highlights already made in this document. The document\'s own highlights are hidden from the analysis, and the current suggestions are not changed.')));
  var btn = segUiEl('button', 'btn btn-outline-primary btn-sm mr-2',
                    gettext('Evaluate against existing highlights'));
  btn.type = 'button';
  var grid = segUiEl('button', 'btn btn-outline-secondary btn-sm',
                     gettext('Test parameter combinations'));
  grid.type = 'button';
  var hint = segUiEl('p', 'text-muted small mt-2 mb-0', gettext(
    'Runs the evaluation for several parameter values; this can take a while.'));
  var line = segUiEl('div', 'text-muted small my-2');
  var spinner = segUiEl('span',
    'spinner-border spinner-border-sm text-muted mr-1 d-none seg-spinner');
  spinner.setAttribute('role', 'status');
  spinner.setAttribute('aria-hidden', 'true');
  var lineText = segUiEl('span');
  line.appendChild(spinner);
  line.appendChild(lineText);
  var out = segUiEl('div');
  var gridOut = segUiEl('div');
  box.appendChild(btn);
  box.appendChild(grid);
  box.appendChild(hint);
  box.appendChild(line);
  box.appendChild(out);
  box.appendChild(gridOut);
  function message(text, kind) {
    line.className = 'small my-2 ' + (kind === 'warn' ? 'text-warning'
      : kind === 'error' ? 'text-danger' : 'text-muted');
    lineText.textContent = text;
  }
  var meter = segUiMeterNew({
    text: function(str) { message(str); },
    busy: function(on) { spinner.classList.toggle('d-none', !on); },
    alive: function() { return true; },
    current: function() { return lineText.textContent; }
  });
  function setRunning(on) {
    SEG_UI.evalState.running = on;
    btn.disabled = on;
    grid.disabled = on;
  }
  setRunning(SEG_UI.evalState.running);
  var applied = '';
  function onApply(row) {
    var params = segParams(row.params);
    segSaveParams(params);
    SEG_UI.evalState.metrics = row.metrics;
    segUiInputsChanged();
    applied = gettext('Applied: tau %(tau)s, kappa %(kappa)s, lambda %(lambda)s. Suggestions are being recomputed.',
                      {tau: params.tau, kappa: params.kappa, lambda: params.lambda});
    renderState();
    console.info('Segmentation parameters applied', params);
    if(opts.onParamsApplied) {
      opts.onParamsApplied(params);
    }
  }
  function renderState() {
    segUiClear(out);
    segUiClear(gridOut);
    if(SEG_UI.evalState.metrics) {
      segUiEvalRenderMetrics(out, SEG_UI.evalState.metrics);
    }
    if(SEG_UI.evalState.grid) {
      gridOut.appendChild(segUiEl('h6', 'mt-3', gettext('Best parameter combinations')));
      segUiEvalRenderGrid(gridOut, SEG_UI.evalState.grid, onApply);
      if(applied) {
        gridOut.appendChild(segUiEl('p', 'small text-success', applied));
      }
    }
  }
  function fail(err) {
    meter.abort();
    setRunning(false);
    if(err && err.stale) {
      console.info('Segmentation evaluation stopped: the session ended or the text changed');
      message(gettext('Evaluation stopped: the suggestion session ended.'), 'warn');
    } else {
      console.error('Segmentation evaluation failed:', err);
      message(segUiErrText(err), 'error');
    }
  }
  function finish() {
    meter.abort();
    setRunning(false);
    message('');
    renderState();
  }
  // Checks readiness at click time; shows why it cannot start otherwise
  function begin(label) {
    if(SEG_UI.evalState.running) {
      return false;
    }
    var why;
    try {
      why = segUiEvalBlocker();
    } catch(err) {
      fail(err);
      return false;
    }
    if(why) {
      console.info('Segmentation evaluation: not started. ' + why);
      message(why, 'warn');
      return false;
    }
    console.info('Segmentation evaluation: starting' + (label ? ' (' + label + ')' : ''));
    setRunning(true);
    meter.start(gettext('Evaluating…'));
    return true;
  }
  btn.addEventListener('click', function() {
    if(!begin()) {
      return;
    }
    // Promise.resolve().then: a synchronous throw becomes a visible failure
    Promise.resolve().then(function() {
      return segUiEvalRun(undefined, function(stage, done, total) {
        meter.progress(stage, done, total);
      });
    }).then(function(m) {
      console.log('Segmentation evaluation', m);
      SEG_UI.evalState.metrics = m;
      finish();
    }).then(null, fail);
  });
  grid.addEventListener('click', function() {
    if(!begin('parameter combinations')) {
      return;
    }
    Promise.resolve().then(function() {
      meter.set(gettext('Testing parameter combinations…'), 0);
      return segUiEvalRun(undefined, null);
    }).then(function(m) {
      SEG_UI.evalState.metrics = m;
      SEG_UI.evalSections = {};
      return segGridSearch(function(over) {
        return segUiEvalRun(over, null);
      }, {currentTau: segParams().tau}, function(done, total) {
        meter.set(gettext('Testing parameter combinations: %(done)s/%(total)s',
                          {done: done, total: total}),
                  total ? (done + 1) / (total + 1) : undefined);
      });
    }).then(function(res) {
      SEG_UI.evalSections = null;
      console.log('Segmentation grid search', res);
      SEG_UI.evalState.grid = res;
      finish();
    }, function(err) {
      SEG_UI.evalSections = null;
      throw err;
    }).then(null, fail);
  });
  renderState();
}


/*
 * Wiring (listeners only; nothing runs against the DOM at load time)
 */

function segUiOn(id, ev, fn) {
  var el = document.getElementById(id);
  if(el) {
    el.addEventListener(ev, fn);
  }
}

function segUiWire() {
  if(SEG_UI.wired || typeof document === 'undefined') {
    return;
  }
  SEG_UI.wired = true;
  segUiOn('seg-script-btn', 'click', segOpenScriptModal);
  segUiOn('seg-script-save', 'click', segUiScriptSave);
  segUiOn('seg-script-close', 'click', function() {
    $('#seg-script-modal').modal('hide');
  });
  segUiOn('seg-support-upload', 'click', segUiUploadSupport);
  segUiOn('seg-paste-add', 'click', segUiPasteSupport);
  segUiOn('seg-support-list', 'click', segUiOnSupportClick);
  segUiOn('seg-guide-add', 'click', function() {
    SEG_UI.script.rows.push({id: null, name: '', description: '', questions: '',
                             source: 'guide'});
    SEG_UI.script.dirty = true;
    segUiRenderGuideRows();
  });
  segUiOn('seg-guide-generate', 'click', segUiScriptGenerate);
  segUiOn('seg-guide-rows', 'click', segUiOnGuideRowsClick);
  segUiOn('seg-guide-rows', 'input', segUiOnGuideRowsInput);
  segUiOn('seg-sections-box', 'click', segUiOnSectionsClick);
  segUiOn('seg-sections-box', 'change', segUiOnSectionsChange);
  segUiOn('seg-emergent-yes', 'click', segUiEmergentYes);
  segUiOn('seg-emergent-back', 'click', segUiEmergentBack);
  segUiOn('seg-emergent-discard', 'click', segUiEmergentDiscard);
  if(typeof $ !== 'undefined') {
    $('#seg-script-modal').on('hide.bs.modal', segUiScriptCloseGuard)
      .on('hidden.bs.modal', segUiScriptClosed);
    $('#segments-tab').on('shown.bs.tab', segRenderSections);
  }
  document.addEventListener('click', segUiOnDocumentClick, true);
  document.addEventListener('mousedown', segUiOnMouseDown);
  document.addEventListener('mouseup', segUiOnMouseUp);
  document.addEventListener('keydown', function(e) {
    if(e.key === 'Escape' && SEG_UI.splitting) {
      segUiSetSplitting(null);
      segUiStatus('');
    }
  });
  segRenderSections();
}

if(typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('tagu:thematic_segments', segUiOnGuideEvent);
  document.addEventListener('tagu:support_documents', segUiOnSupportEvent);
  if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', segUiWire);
  } else if(document.readyState !== undefined) {
    segUiWire();
  }
}


/*
 * Self-test (Node: scripts/segments_ui_selftest.js; browser: console)
 */

function segUiSelfTest() {
  var failures = 0;
  function assert(cond, msg) {
    if(!cond) {
      ++failures;
      console.error('SEG UI SELFTEST FAIL:', msg);
    }
  }
  function eq(a, b, msg) {
    assert(JSON.stringify(a) === JSON.stringify(b),
           msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');
  }
  var text = 'A: first question here\nB: first answer words\nA: second question\nB: second answer long';
  var turns = [], pos = 0;
  text.split('\n').forEach(function(line) {
    turns.push({start: pos, end: pos + line.length, text: line,
                contentStart: pos + 3, speaker: null});
    pos += line.length + 1;
  });
  function sec(id, i0, i1, segId, emergent) {
    return {id: id, start: turns[i0].start,
            end: i1 + 1 < turns.length ? turns[i1 + 1].start : turns[i1].end, segId: segId,
            emergent: emergent || null, openingQuestion: null, label: id, name: id,
            words: 1, codableWords: 1, windowRange: [0, 0], manual: false};
  }

  // permissions (mirrors Privileges.can_edit_project_meta)
  var g = (typeof window !== 'undefined') ? window : globalThis;
  var savedMembers = g.members, savedLogin = g.user_login;
  g.user_login = 'u1';
  g.members = {u1: {privileges: 'ADMIN'}};
  assert(segCanEditMeta() === true, 'admin can edit meta');
  ['MANAGE_DOCS', 'TAG', 'READ'].forEach(function(p) {
    g.members = {u1: {privileges: p}};
    assert(segCanEditMeta() === false, p + ' cannot edit meta');
  });
  g.members = {};
  assert(segCanEditMeta() === false, 'unknown member cannot edit meta');
  g.members = savedMembers;
  g.user_login = savedLogin;

  // hashes
  var guide = [{id: 1, name: 'A', description: 'd', guide_questions: ['q']},
               {id: 2, name: 'B', description: '', guide_questions: []}];
  var h1 = segUiGuideHash(guide);
  assert(h1 === segUiGuideHash(JSON.parse(JSON.stringify(guide))), 'guide hash stable');
  var guide2 = JSON.parse(JSON.stringify(guide));
  guide2[0].guide_questions.push('q2');
  assert(h1 !== segUiGuideHash(guide2), 'guide hash changes with questions');
  guide2 = JSON.parse(JSON.stringify(guide));
  guide2[1].name = 'C';
  assert(h1 !== segUiGuideHash(guide2), 'guide hash changes with names');
  assert(segUiParamsHash({a: 1, b: 2}) === segUiParamsHash({b: 2, a: 1}), 'params hash order independent');
  assert(segUiManualHash(null) === segUiManualHash(segUiEmptyManual()), 'empty manual hash');

  // slider overrides do not count as section parameters
  eq(segUiUnitOverrides({tau: 0.3, theta: 0.5, force: true}), {tau: 0.3, theta: 0.5}, 'unit overrides');
  assert(segUiUnitOverrides({force: true}) === null && segUiUnitOverrides(null) === null, 'no overrides');

  // candidates
  var result = {units: [
    {id: 'u0', sectionId: 'sec0', start: 0, end: 10, tags: [
      {id: 5, name: 'x', conf: 0.9, source: 's1'}, {id: 6, name: 'y', conf: 0.3, source: 'sim'}]},
    {id: 'u1', sectionId: 'sec1', start: 12, end: 20, tags: []}]};
  var cands = segUnitsAsCandidates(result, 0.6);
  assert(cands.length === 2, 'two candidates');
  assert(Math.abs(cands[0].raw - 0.9) < 1e-9, 'raw = max conf');
  var st = segUnitsAsCandidates({units: [{id: 'u2', sectionId: 's', start: 0, end: 5,
    smallTalk: 1, tags: [{id: 5, name: 'x', conf: 0.8}]}]}, 0.6);
  assert(Math.abs(st[0].raw - 0.4) < 1e-9, 'raw = max conf * (1 - 0.5 * smallTalk)');
  eq(cands[0].ticked, [5], 'ticked by theta');
  assert(cands[1].raw === 0 && cands[1].ticked.length === 0, 'no tags -> raw 0');
  assert(cands[0].start === 0 && cands[0].section_id === 'sec0', 'char offsets + section');
  eq(segUnitsAsCandidates(result, 0.2)[0].ticked, [5, 6], 'lower theta ticks more');

  // manual edit recording
  var manual = segUiEmptyManual();
  var key1 = segTurnKey(turns[2]);
  assert(segUiRecordAssign(manual, turns, turns[2].start + 3, {segId: 2, emergentKey: null}, true),
         'assign recorded');
  eq(manual.assign[key1], {segId: 2, emergentKey: null}, 'assign keyed by turn text hash');
  eq(manual.starts, [key1], 'start pinned');
  segUiRecordAssign(manual, turns, turns[2].start, {segId: 2, emergentKey: null}, true);
  assert(manual.starts.length === 1, 'start not duplicated');
  var dup = turns.concat([turns[0]]);
  assert(segUiRecordAssign(segUiEmptyManual(), dup, turns[0].start, {segId: 1, emergentKey: null}, true) === false,
         'non-unique turn text refused');
  var sp0 = {};
  sp0[turns[2].start] = true;
  eq(segUiStartPositions(turns, manual), sp0, 'start positions');
  segUiForgetKey(manual, key1);
  assert(!manual.assign[key1] && !manual.starts.length, 'forget key');

  // nearest turn start
  assert(segUiNearestTurnStart(turns, turns[1].start + 2) === turns[1].start, 'nearest start (inside)');
  assert(segUiNearestTurnStart(turns, turns[1].end - 1) === turns[2].start, 'nearest start (end)');

  // merge / move / coalesce on plain arrays
  var secs = [sec('s0', 0, 1, 1), sec('s1', 2, 3, 2)];
  var merged = segUiMergePair(secs, 0, 1);
  assert(merged.length === 1 && merged[0].segId === 2 && merged[0].start === 0
         && merged[0].end === secs[1].end, 'merge keeps chosen label and tiles');
  var moved = segUiMoveStart(secs, 1, turns[1].start);
  assert(moved && moved[0].end === turns[1].start && moved[1].start === turns[1].start
         && moved[1].end === secs[1].end, 'move start keeps tiling');
  assert(segUiMoveStart(secs, 0, 5) === null && segUiMoveStart(secs, 1, secs[1].end) === null
         && segUiMoveStart(secs, 1, 0) === null, 'invalid moves refused');
  var split = [sec('a', 0, 1, 1), sec('b', 2, 2, 1), sec('c', 3, 3, 2)];
  var co = segUiCoalesce(split, {});
  assert(co.length === 2 && co[0].end === turns[3].start, 'same segment coalesces');
  var sp = {};
  sp[turns[2].start] = true;
  assert(segUiCoalesce(split, sp).length === 3, 'user boundary keeps sections apart');
  assert(segUiCoalesce([sec('a', 0, 0, null, {key: 'e1', name: 'x'}), sec('b', 1, 1, null, {key: 'e1', name: 'x'})], {}).length === 1,
         'same emergent key coalesces');
  assert(segUiCoalesce([sec('a', 0, 0, null, {key: 'e1', name: 'x'}), sec('b', 1, 1, null, {key: 'e2', name: 'y'})], {}).length === 2,
         'different emergent keys stay apart');

  // pending groups + remap
  function em(key) {
    return {key: key, name: 'Emergent ' + key, description: '', question: '', proposed: false};
  }
  var dict = {e1: {name: 'Edited', description: 'dd', question: 'qq', edited: true}};
  var pend = [sec('p0', 0, 0, 1), sec('p1', 1, 1, null, em('e1')), sec('p2', 2, 2, null, em('e1')),
              sec('p3', 3, 3, null, em('u9')), sec('whole', 0, 3, null, null)];
  var groups = segUiPendingGroups(pend.slice(0, 4), dict);
  assert(groups.length === 2, 'two pending groups (shared emergent key grouped)');
  eq(groups[0].sectionIds, ['p1', 'p2'], 'group lists its sections');
  assert(groups[0].name === 'Edited' && groups[0].question === 'qq', 'dict overrides proposal');
  assert(groups[1].user === true && groups[0].user === false, 'user-created detected');
  assert(segUiPendingGroups([pend[4]], {}).length === 0, 'whole-document section is not pending');
  var man2 = {assign: {k1: {segId: null, emergentKey: 'e1'}, k2: {segId: 1, emergentKey: null}}, starts: []};
  var d2 = {e1: dict.e1, u9: {name: 'Mine'}};
  var n = segUiRemap(pend.slice(0, 4), man2, d2, {e1: {segId: 7, name: 'Edited'}, u9: {segId: 1, name: 'A'}});
  assert(n === 3, 'three sections remapped');
  assert(pend[1].segId === 7 && pend[1].emergent === null && pend[1].name === 'Edited', 'section remapped by name');
  assert(pend[3].segId === 1, 'merged group -> existing id');
  eq(man2.assign.k1, {segId: 7, emergentKey: null}, 'manual assignment remapped');
  assert(!d2.e1 && !d2.u9, 'emergent dict cleaned');
  var saved = [{id: 3, name: 'Alpha'}, {id: 4, name: ' beta '}];
  assert(segUiFindByName(saved, 'BETA').id === 4, 'find by name ignores case and spaces');

  // collect emergent keeps user edits
  var col = segUiCollectEmergent([sec('q', 0, 0, null, {key: 'e1', name: 'N', description: '', question: '', proposed: true})],
                                 {e1: {name: 'Mine', edited: true}, u1: {name: 'U', user: true}, e7: {name: 'gone'}});
  assert(col.e1.name === 'Mine' && col.u1.name === 'U' && !col.e7, 'collect emergent');

  // section stats
  var st = segUiSectionStats({start: 0, end: 40}, [{start: 0, end: 20, speaker: null},
    {start: 20, end: 40, speaker: 'int'}], [{id: 'int', include: false}],
    [{cStart: 0, cEnd: 10}, {cStart: 5, cEnd: 15}]);
  assert(st.codable === 20 && st.covered === 15 && st.count === 2, 'section stats ignore excluded speakers');

  // extras for the core
  var ex = segUiExtrasFrom({'1': {'10': {sum: [2, 4], n: 2}, '11': {sum: [3, 3], n: 1}}},
                           {'5': {'1': {'10': 2, '11': 1}}}, 11);
  eq(ex.protos['1'], [[1, 2]], 'extras exclude a document');
  assert(ex.cooc['5']['1'] === 2, 'cooc excludes a document');
  var pr = {}, co2 = {};
  segUiAddPrototype(pr, co2, 1, 10, new Float32Array([1, 2]), [5]);
  segUiAddPrototype(pr, co2, 1, 10, [3, 4], [5, 6]);
  eq(pr['1']['10'], {sum: [4, 6], n: 2}, 'prototype sums');
  assert(co2['5']['1']['10'] === 2, 'cooc counts');

  // progress text
  assert(segUiProgressText('embed', 3, 10) === 'Segmenting: embedding windows 3/10', 'progress text');

  // metrics rows
  var rows = segUiMetricRows({segments: {precision: 0.3, recall: 0.5},
                              highlights: {precision: 0.7, recall: 0.9}});
  assert(rows.length === 2 && rows[0].precision === '30%' && rows[0].recall === '50%'
         && rows[1].precision === '70%' && rows[1].recall === '90%'
         && rows[0].label === 'Segments' && rows[1].label === 'Suggested highlights', 'metric rows');
  assert(segUiMetricRows({})[0].precision === '0%', 'metric rows tolerate missing scores');

  // rows <-> guide
  var rws = segUiGuideToRows(guide);
  rws[0].questions = ' a \n\n b ';
  var back = segUiRowsToGuide(rws);
  eq(back[0].guide_questions, ['a', 'b'], 'questions one per line');
  assert(back[0].id === 1, 'id kept');
  assert(segUiValidateRows([{name: 'x'}, {name: 'X'}]) !== null, 'duplicate names rejected');
  assert(segUiValidateRows([{name: ' '}]) !== null, 'empty name rejected');
  assert(segUiValidateRows(rws) === null, 'valid rows accepted');

  // segApplyManual + finalize: a recorded start splits a section and tiles
  var base = [sec('s0', 0, 3, 1)];
  var man = segUiEmptyManual();
  segUiRecordAssign(man, turns, turns[2].start, {segId: 2, emergentKey: null}, true);
  var applied = segApplyManual(base, turns, man, {guide: guide, plainText: text});
  assert(applied.length === 2 && applied[0].end === turns[2].start && applied[1].segId === 2,
         'segApplyManual splits at the recorded start');
  var fin = segUiFinalize(applied, {guide: guide, plainText: text, turns: turns}, man, {});
  assert(fin.length === 2 && fin[0].name === 'A' && fin[1].name === 'B', 'finalize refreshes names');
  assert(fin[0].start === 0 && fin[0].end === fin[1].start && fin[1].end === base[0].end,
         'sections still tile the text');

  // unique default names for the emergent modal
  var un = segUiUniqueNames([{name: 'Costs'}, {name: 'costs'}, {name: 'Costs'}, {name: 'Other'}, {name: ''}]);
  eq(un.map(function(x) { return x.name; }), ['Costs', 'costs (2)', 'Costs (3)', 'Other', ''],
     'default emergent names are made unique');

  // dangling segment ids are shown as removed
  var dang = segUiFinalize([sec('d0', 0, 3, 99)], {guide: guide, plainText: text, turns: turns},
                           segUiEmptyManual(), {});
  assert(dang[0].name === '(removed topic)', 'dangling segId is named (removed topic)');

  // run generation tokens
  var savedSess = sug_session, savedDoc = SEG_UI.doc, savedRunning = SEG_UI.running;
  var savedFns = {mi: segUiMakeInput, ru: segRunUnits, ad: segAnalyzeDocument,
                  rf: segRefreshUnits, md: segMakeDeps, eb: segUiEmbKey,
                  ig: segIdbGet, ip: segIdbPut, em: segCanEditMeta};
  function restore() {
    sug_session = savedSess;
    SEG_UI.doc = savedDoc;
    SEG_UI.running = savedRunning;
    segUiMakeInput = savedFns.mi; segRunUnits = savedFns.ru;
    segAnalyzeDocument = savedFns.ad; segRefreshUnits = savedFns.rf;
    segMakeDeps = savedFns.md; segUiEmbKey = savedFns.eb;
    segIdbGet = savedFns.ig; segIdbPut = savedFns.ip; segCanEditMeta = savedFns.em;
  }
  sug_session = {editGen: 0, staged: [], speakers: [], plainText: text, turns: [], panes: {}};
  var tk = segUiToken();
  assert(segUiTokenOk(tk), 'fresh token is valid');
  segUiInvalidate();
  assert(!segUiTokenOk(tk), 'token dropped after a generation bump');
  tk = segUiToken();
  sug_session.editGen++;
  assert(!segUiTokenOk(tk), 'token dropped after a transcript edit');
  tk = segUiToken();
  sug_session = {editGen: 0, staged: [], speakers: [], plainText: text, turns: [], panes: {}};
  assert(!segUiTokenOk(tk), 'token dropped for another session');
  assert(segUiToken().sess === sug_session && segUiTokenOk(segUiToken()), 'token follows the session');

  // sections panel spans: segmented panes + staged, a shared unit counts once
  sug_session.panes = {
    '': {algo: 'segmented', suggestions: [{cStart: 0, cEnd: 5}, {cStart: 6, cEnd: 9}]},
    'b': {algo: 'segmented', suggestions: [{cStart: 0, cEnd: 5}]},
    'c': {algo: 'textrank', suggestions: [{cStart: 20, cEnd: 30}]}};
  sug_session.staged = [{cStart: 40, cEnd: 50}];
  eq(segUiSpans().map(function(x) { return x.cStart; }), [0, 6, 40], 'spans from segmented panes and staged');
  sug_session.panes = {};
  sug_session.staged = [];

  var doc = SEG_UI.doc = segUiNewDoc(1, 'h');
  doc.result = {sections: [], units: []};
  doc.resultKey = segResultKey();
  assert(doc.resultKey !== '' && segResultKey() === doc.resultKey, 'segResultKey is stable');
  doc.manual.assign['k'] = {segId: 1, emergentKey: null};
  assert(segResultKey() !== doc.resultKey, 'segResultKey follows manual edits');
  doc.manual = segUiEmptyManual();
  doc.speakersHash = null;
  var rk0 = segResultKey();
  sug_session.speakers = [{id: 'a', include: false}];
  assert(segResultKey() !== rk0, 'segResultKey follows speaker roles');
  sug_session.speakers = [];
  doc.resultKey = segResultKey();

  var seen = [];
  segMakeDeps = function() { return {}; };
  segUiMakeInput = function(o) { return Promise.resolve({overrides: o.overrides}); };
  var delays = [25, 2];
  segRunUnits = function(r, input) {
    var d = delays[seen.length];
    seen.push(input.overrides);
    return new Promise(function(res) {
      setTimeout(function() { res({sections: [], units: [], tag: input.overrides.tau}); }, d);
    });
  };
  var settle = function(p) {
    return p.then(function(v) { return {ok: v}; }, function(e) { return {err: e}; });
  };
  var t = Promise.resolve();
  t = t.then(function() {
    var a = settle(segRefreshUnits({tau: 0.1}));
    var b = settle(segRefreshUnits({tau: 0.2}));
    return Promise.all([a, b]).then(function(r) {
      assert(r[0].err && r[0].err.stale, 'older units refresh is dropped');
      assert(r[1].ok && r[1].ok.tag === 0.2 && doc.result.tag === 0.2,
             'newest units refresh wins even though it finished first');
      assert(doc.unitOverrides.tau === 0.2, 'overrides follow the winner');
    });
  }).then(function() {
    delays = [10];
    seen = [];
    var before = doc.result;
    var p = settle(segRefreshUnits({tau: 0.3}));
    segUiInvalidate();   // e.g. a manual edit while the units were computed
    return p.then(function(r) {
      assert(r.err && r.err.stale && doc.result === before, 'refresh dropped after an invalidation');
    });
  }).then(function() {
    // a changed result key (guide, speakers, params...) falls back to a full analysis
    var called = [];
    segAnalyzeDocument = function(o) { called.push(o); return Promise.resolve('full'); };
    doc.resultKey = 'old';
    return segRefreshUnits({tau: 0.4, theta: 0.5}).then(function(r) {
      assert(r === 'full' && called.length === 1 && called[0].tau === 0.4, 'key mismatch -> full analysis');
    });
  }).then(function() {
    // in-flight sharing covers the sections only: other tau/theta re-run the units
    segAnalyzeDocument = savedFns.ad;
    var refreshed = [];
    segRefreshUnits = function(o) { refreshed.push(o); return Promise.resolve('refreshed'); };
    doc.result = null;
    SEG_UI.running = {key: segResultKey(), promise: Promise.resolve('shared'),
                      over: {tau: 0.1, theta: 0.5}};
    return segAnalyzeDocument({tau: 0.1, theta: 0.5}).then(function(r) {
      assert(r === 'shared' && !refreshed.length, 'same overrides share the run');
      return segAnalyzeDocument({tau: 0.3, theta: 0.5});
    }).then(function(r) {
      assert(r === 'refreshed' && refreshed.length === 1 && refreshed[0].tau === 0.3,
             'different overrides re-run the units after the shared run');
      SEG_UI.running = null;
    });
  }).then(function() {
    // save-and-navigate: the vectors are captured before the session ends
    segRefreshUnits = savedFns.rf;
    var mem = {};
    segUiEmbKey = function() { return 'ek'; };
    segIdbGet = function(k) { return Promise.resolve(mem[k] || null); };
    segIdbPut = function(k, v) { mem[k] = v; };
    SEG_UI.doc = doc = segUiNewDoc(7, 'h');
    doc.result = {sections: [sec('x0', 0, 3, 1)], units: [{start: 0, end: 30, vec: [1, 2]}], tag: 'x'};
    var p = segRecordSaved([{cStart: 2, cEnd: 20, tags: ['5']}]);
    SEG_UI.doc = null;   // done() -> sugCleanup -> segOnSessionEnd
    return p.then(function() {
      assert(mem['seg|protos|ek'] && mem['seg|protos|ek']['1'] && mem['seg|protos|ek']['1']['7'],
             'segRecordSaved records after the session ended');
    });
  }).then(function() {
    // segBeforeSave: nothing staged -> no prompt; failures never kill the dialog
    segCanEditMeta = function() { return true; };
    SEG_UI.doc = doc = segUiNewDoc(7, 'h');
    doc.result = {sections: [sec('e0', 0, 1, null, {key: 'e1', name: 'N', description: '', question: ''}),
                             sec('e1', 2, 3, 1)], units: []};
    var n = 0;
    segBeforeSave(function() { ++n; });
    assert(n === 1, 'segBeforeSave proceeds directly when nothing is staged');
    sug_session.staged = [{aid: 1}];
    var m = 0;
    segBeforeSave(function() { ++m; });
    assert(m === 0, 'segBeforeSave asks when something is staged and emergent segments are pending');
    return new Promise(function(r) { setTimeout(r, 20); }).then(function() {
      // (the modal needs the DOM: the failure path must still proceed, once)
      assert(m === 1, 'segBeforeSave proceeds once if the confirmation cannot be shown');
    });
  });
  t = t.then(function() {
    // result cache: memory + IndexedDB, zero calls on a hit, key and force
    var iv = segTestInterview([['A', 4], ['B', 4], ['C', 4]]);
    var mem = {}, counts = {embed: 0, llm: 0, decide: 0, inputs: 0};
    var savedSep = segRenderSeparators, savedDelay = SEG_UI_RESULT_DELAY;
    var savedGuide = g.taguette_thematic_segments, savedCurDoc = g.current_document;
    g.current_document = 5;
    var savedCache = SEG_UI.resultCache;
    sug_session = {editGen: 0, staged: [], speakers: iv.speakers, plainText: iv.plainText,
                   turns: iv.turns, panes: {}};
    g.taguette_thematic_segments = segTestGuide();
    var tdeps = segTestDeps({
      embed: function(txt) { ++counts.embed; return segFakeEmbed(txt, 64); },
      llm: function() { ++counts.llm; return Promise.resolve(null); },
      decide: function() { ++counts.decide; return Promise.resolve(null); }});
    segMakeDeps = function() { return tdeps; };
    segUiMakeInput = function(o) {
      ++counts.inputs;
      return Promise.resolve({
        plainText: sug_session.plainText, turns: segUiTurnsWithLabels(),
        speakers: sug_session.speakers, guide: segUiGuide(),
        params: segParams(o.overrides), tags: [], exemplars: [], docId: 5,
        excludeDocId: null, segPrototypeExtras: null, tagSegmentCooc: null,
        manual: SEG_UI.doc ? SEG_UI.doc.manual : null});
    };
    segRunUnits = savedFns.ru;
    segAnalyzeDocument = savedFns.ad;
    segRefreshUnits = savedFns.rf;
    segIdbGet = function(k) { return Promise.resolve(mem[k] || null); };
    segIdbPut = function(k, v) { mem[k] = v; };
    segRenderSeparators = function() {};
    SEG_UI_RESULT_DELAY = 0;
    SEG_UI.resultCache = {};
    SEG_UI.resultDirty = {};
    function reset() { counts.embed = counts.llm = counts.decide = counts.inputs = 0; }
    function total() { return counts.embed + counts.llm + counts.decide + counts.inputs; }
    function newSession() {
      segOnSessionEnd();
      segOnSessionStart();
    }
    function strip(units) {
      return JSON.stringify(units.map(function(u) {
        var o = {};
        for(var k in u) { if(k !== 'vec') { o[k] = u[k]; } }
        return o;
      }));
    }
    var r1, r3;
    function finish() {
      segRenderSeparators = savedSep;
      SEG_UI_RESULT_DELAY = savedDelay;
      g.taguette_thematic_segments = savedGuide;
      g.current_document = savedCurDoc;
      SEG_UI.resultCache = savedCache;
    }
    newSession();
    return segAnalyzeDocument({}).then(function(r) {   // miss: runs the pipeline
      r1 = r;
      assert(counts.embed > 0 && r1.units.length > 0, 'cache: a miss runs the pipeline');
      segUiCacheFlush();
      var rec = mem[segUiResultIdbKey(5)];
      assert(rec && rec.version === 1 && rec.key === SEG_UI.doc.resultKey && rec.savedAt > 0,
             'cache: the miss wrote the IndexedDB record');
      assert(rec.result.units[0].vec instanceof Float32Array
             && rec.result.guideVecs[0] instanceof Float32Array, 'cache: vectors are Float32Array');
      assert(!rec.result.windows && !rec.result.vecs && !rec.result.sections[0].vec,
             'cache: window vectors and section vectors are not stored');
      assert(SEG_UI.resultCache[5] && SEG_UI.resultCache[5].result === r1, 'cache: memory entry written');
      newSession();   // Stop -> Discard, then a new session
      reset();
      return segAnalyzeDocument({});
    }).then(function(r) {
      assert(r === r1 && total() === 0, 'cache: memory hit after the session ended makes no calls');
      assert(SEG_UI.doc.result === r1 && SEG_UI.doc.cachedAt > 0, 'cache: memory hit adopted');
      SEG_UI.resultCache = {};   // a page reload
      newSession();
      reset();
      return segAnalyzeDocument({});
    }).then(function(r) {
      r3 = r;
      assert(r3 !== r1 && total() === 0, 'cache: IndexedDB hit makes no calls');
      assert(r3.sections.length === r1.sections.length
             && JSON.stringify(r3.sections.map(function(x) { return [x.id, x.start, x.end, x.segId, x.name]; }))
                === JSON.stringify(r1.sections.map(function(x) { return [x.id, x.start, x.end, x.segId, x.name]; })),
             'cache: hydrated sections match');
      assert(strip(r3.units) === strip(r1.units) && r3.units[0].vec.length === 64
             && Math.abs(r3.units[0].vec[0] - r1.units[0].vec[0]) < 1e-6
             && Array.isArray(r3.units[0].vec), 'cache: hydrated units match');
      assert(JSON.stringify(r3.windows) === JSON.stringify(r1.windows)
             && JSON.stringify(r3.infos) === JSON.stringify(r1.infos), 'cache: windows and infos recomputed identically');
      assert(SEG_UI.resultCache[5] && SEG_UI.resultCache[5].result === r3, 'cache: IndexedDB hit also fills memory');
      // a units refresh (as "Refine this section" / manual edits do) on the hydrated result
      var doc2 = SEG_UI.doc;
      doc2.result = r1;
      return segRefreshUnits({tau: 0.3, theta: 0.4}).then(function(a) {
        doc2.result = r3;
        return segRefreshUnits({tau: 0.3, theta: 0.4}).then(function(b) {
          assert(strip(a.units) === strip(b.units) && a.units.length > 0
                 && JSON.stringify(a.stats) === JSON.stringify(b.stats),
                 'cache: a units refresh on a hydrated result equals the original');
        });
      });
    }).then(function() {
      // key mismatch -> miss (speaker roles are part of the key)
      segUiCacheFlush();
      SEG_UI.resultCache = {};
      newSession();
      sug_session.speakers = [{id: 'I', name: 'Interviewer', include: true},
                              {id: 'P', name: 'Participant', include: true}];
      reset();
      return segAnalyzeDocument({}).then(function(r) {
        assert(counts.embed > 0 && r !== r1, 'cache: a changed key is a miss');
        sug_session.speakers = iv.speakers;
      });
    }).then(function() {
      // the rebuild hook drops the stale memory entry
      assert(SEG_UI.resultCache[5], 'cache: memory entry exists before the rebuild');
      segOnRebuild();
      assert(!SEG_UI.resultCache[5], 'cache: transcript rebuild drops the memory entry');
      // a stored record from another pipeline generation is ignored
      var rec = mem[segUiResultIdbKey(5)];
      rec.key = segResultKey();
      rec.result.stats.windows += 1;
      return segUiCacheLoad(SEG_UI.doc, rec.key).then(function(hit) {
        assert(hit === null, 'cache: mismatching window count -> miss');
        rec.result.stats.windows -= 1;
        return segAnalyzeDocument({});
      });
    }).then(function() {
      // force bypasses the cache and rewrites it
      var before = SEG_UI.doc.result;
      reset();
      return segAnalyzeDocument({force: true}).then(function(r) {
        assert(counts.embed > 0 && r !== before && SEG_UI.resultCache[5].result === r,
               'cache: force re-runs and refreshes the cache');
        reset();
        return segAnalyzeDocument({}).then(function(again) {
          assert(again === r && total() === 0, 'cache: afterwards the new result is reused');
        });
      });
    }).then(finish, function(err) {
      finish();
      throw err;
    });
  });
  return t.then(null, function(err) {
    assert(false, 'async self-test error: ' + (err && err.stack || err));
  }).then(function() {
    restore();
    return failures;
  }).then(function(f) {
    if(f) {
      console.error('SEG UI SELFTEST: ' + f + ' failure(s)');
    } else {
      console.log('SEG UI SELFTEST OK');
    }
    return f;
  });
}


/*
 * Segment-based candidates for any document (highlight tuning, suggest.js)
 *
 * Unlike segAnalyzeDocument() this never reads or writes the session, the
 * open document's state or the per-document result cache: that cache was
 * computed with the document's own highlights as exemplars, which a fair
 * evaluation must not use.
 */

// Copies of turns carrying labelEnd (where the spoken text starts)
function segUiLabelTurns(turns) {
  return (turns || []).map(function(t) {
    var o = {};
    for(var k in t) {
      o[k] = t[k];
    }
    o.labelEnd = (typeof sugTurnLabelEnd === 'function')
      ? sugTurnLabelEnd(t) : Math.max(t.contentStart || t.start, t.start);
    return o;
  });
}

// Pipeline input for a document that need not be the open one. o: {docId,
// plainText, turns, speakers, overrides?}. The document's own highlights are
// left out of the exemplars and prototypes (excludeDocId); no manual edits.
// Promise of the input (uses the current guide, tags and parameters).
function segUiMakeInputFor(o) {
  var docId = o.docId;
  return Promise.all([
    segUiTimeout(segUiExemplars(), SEG_UI_INPUT_TIMEOUT, []),
    segUiTimeout(segUiExtras(docId), SEG_UI_INPUT_TIMEOUT,
                 {protos: {}, cooc: {}})
  ]).then(function(r) {
    return {
      plainText: o.plainText, turns: segUiLabelTurns(o.turns),
      speakers: o.speakers || [], guide: segUiGuide(),
      params: segParams(o.overrides), tags: segUiTagList(),
      exemplars: r[0], docId: docId, excludeDocId: docId,
      segPrototypeExtras: r[1].protos, tagSegmentCooc: r[1].cooc,
      manual: null
    };
  });
}

// Segment units of a document as suggestion candidates (CHAR offsets), with
// the system-1 tag confidences only (no model rechecks)
function segUiCandidatesFor(o) {
  segUiRunBegin();
  return segUiMakeInputFor(o).then(function(input) {
    return segRunAll(input, segMakeDeps({}), {tags: 'fast'});
  }).then(function(result) {
    segUiRunEnd();
    return segUnitsAsCandidates(result);
  }, function(err) {
    segUiRunEnd();
    throw err;
  });
}
