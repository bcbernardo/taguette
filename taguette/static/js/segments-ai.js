/*
 * Thematic segments: transport layer.
 *
 * Everything that talks to the network for the segmentation pipeline
 * (segments.js stays pure and receives these functions as injected deps):
 *
 * - the systemone "decisions" endpoint (Laya local server or Jev through
 *   OpenRouter): auth, a shared request pool, a two-level cache (memory +
 *   IndexedDB) and a circuit breaker;
 * - the fast LLM ('llm' task) and the reasoning LLM ('reasoning' task);
 * - the Taguette server API for support documents, thematic segments and
 *   the project's highlight texts (tag exemplars);
 * - segMakeDeps(), which assembles the Deps object segRunAll() expects.
 *
 * No side effects at load time: nothing here fetches or touches the DOM
 * until one of the functions is called.
 */

var SEG_DEFAULT_JEV_MODEL = '~typesafe/jev-latest';
var SEG_DECISION_CONCURRENCY = 4;
var SEG_LLM_CONCURRENCY = 2;
var SEG_BREAKER_LIMIT = 5;           // consecutive failures before giving up
var SEG_EXEMPLAR_CONCURRENCY = 5;

// Counters (mutated in place by segAiReset so held references stay valid)
var segAiStats = {
  decisions: 0,          // decision requests that reached the server OK
  decisionCacheHits: 0,
  decisionErrors: 0,
  llmCalls: 0,           // LLM requests that returned text
  llmCacheHits: 0,
  llmErrors: 0,
};

var SEG_AI = {
  decPool: {limit: SEG_DECISION_CONCURRENCY, active: 0, queue: []},
  llmPool: {limit: SEG_LLM_CONCURRENCY, active: 0, queue: []},
  decFails: 0,           // consecutive failures (circuit breaker)
  llmFails: 0,
  decMem: {},            // key -> normalized answers
  llmMem: {},            // key -> text
  decInflight: {},       // key -> Promise (identical concurrent requests)
  llmInflight: {},
  embMem: {},            // embKey -> {text: vec}
};


function segT(message) {
  return (typeof gettext === 'function') ? gettext(message) : message;
}

function segErrMessage(err) {
  return (err && err.message) ? err.message : String(err);
}

// Forget breaker state and counters; with clear_cache also the memory caches
function segAiReset(clear_cache) {
  SEG_AI.decFails = 0;
  SEG_AI.llmFails = 0;
  for(var k in segAiStats) {
    if(Object.prototype.hasOwnProperty.call(segAiStats, k)) {
      segAiStats[k] = 0;
    }
  }
  if(clear_cache) {
    SEG_AI.decMem = {};
    SEG_AI.llmMem = {};
    SEG_AI.embMem = {};
  }
}


/*
 * Request pool: at most `limit` jobs in flight, FIFO. Module-level, so the
 * limit is shared by every caller (several pipeline stages run in parallel).
 */

function segPoolRun(pool, fn) {
  return new Promise(function(resolve, reject) {
    pool.queue.push({fn: fn, resolve: resolve, reject: reject});
    segPoolPump(pool);
  });
}

function segPoolPump(pool) {
  function start(job) {
    pool.active++;
    var p;
    try {
      p = Promise.resolve(job.fn());
    } catch(e) {
      p = Promise.reject(e);
    }
    p.then(function(v) {
      pool.active--;
      job.resolve(v);
      segPoolPump(pool);
    }, function(e) {
      pool.active--;
      job.reject(e);
      segPoolPump(pool);
    });
  }
  while(pool.active < pool.limit && pool.queue.length) {
    start(pool.queue.shift());
  }
}

// Persistent cache access that can never throw or reject
function segIdbGet(key) {
  try {
    if(typeof sugIdbGetMany !== 'function') {
      return Promise.resolve(null);
    }
    return Promise.resolve(sugIdbGetMany([key])).then(function(stored) {
      return (stored && stored[key]) || null;
    }, function() { return null; });
  } catch(e) {
    return Promise.resolve(null);
  }
}

function segIdbPut(key, value) {
  try {
    if(typeof sugIdbPutMany === 'function') {
      Promise.resolve(sugIdbPutMany([{key: key, vec: value}]))
        .then(null, function() {});
    }
  } catch(e) { /* persistence is best-effort */ }
}


/*
 * Decisions (Jev/Laya systemone wire protocol)
 *   request  POST {state, questions, model?}
 *   response {answers: {<qname>: {choice, answer_confidence?,
 *                                 probabilities?: {criterion: p}}}}
 */

// The Jev decisions endpoint for OpenRouter keys (absolute: it does not
// live under the OpenAI-compatible /v1 base); other providers have no known
// default, so the task's URL must be filled in
function segDecisionsDefaultPath(key) {
  return key && key.provider === 'openrouter'
    ? 'https://openrouter.ai/api/alpha/decisions'
    : '';
}

// Resolved wire config of the stored 'decisions' task, or null if off:
// {provider: 'laya'|'jev', url, key?, model?, authHeader?, authScheme?}
function segDecisionsResolved() {
  var r = taguTaskResolve('decisions', segDecisionsDefaultPath);
  if(!r || !r.url) {
    return null;
  }
  if(r.local) {
    return {provider: 'laya', url: r.url};
  }
  var cfg = {provider: 'jev', url: r.url, key: r.token,
             model: r.model || SEG_DEFAULT_JEV_MODEL};
  if(r.authHeader) {
    cfg.authHeader = r.authHeader;
    cfg.authScheme = r.authScheme;
  }
  return cfg;
}

// Cache-isolation key: decisions of different servers/models never mix
function segDecisionsBase(cfg) {
  if(cfg.provider === 'laya') {
    return 'laya|' + (cfg.url || '');
  }
  return 'jev|' + (cfg.url || '') + '|' + (cfg.model || '');
}

function segCriteriaNames(question) {
  var out = [];
  if(question && question.criteria && typeof question.criteria === 'object') {
    for(var k in question.criteria) {
      if(Object.prototype.hasOwnProperty.call(question.criteria, k)) {
        out.push(k);
      }
    }
  }
  return out;
}

// One answer -> {choice, probabilities}. A missing/empty `probabilities` is
// synthesized from the choice and answer_confidence (default 1): the chosen
// criterion gets the confidence, the rest share the remaining mass evenly.
function segNormalizeAnswer(ans, question) {
  var choice = ans.choice;
  var probs = {};
  var have = false;
  if(ans.probabilities && typeof ans.probabilities === 'object') {
    for(var k in ans.probabilities) {
      if(Object.prototype.hasOwnProperty.call(ans.probabilities, k)
         && typeof ans.probabilities[k] === 'number') {
        probs[k] = ans.probabilities[k];
        have = true;
      }
    }
  }
  if(!have) {
    var conf = (typeof ans.answer_confidence === 'number')
      ? Math.max(0, Math.min(1, ans.answer_confidence)) : 1;
    var names = segCriteriaNames(question);
    var others = [];
    for(var i = 0; i < names.length; ++i) {
      if(names[i] !== choice) {
        others.push(names[i]);
      }
    }
    probs[choice] = conf;
    for(var j = 0; j < others.length; ++j) {
      probs[others[j]] = (1 - conf) / others.length;
    }
  }
  return {choice: choice, probabilities: probs};
}

// Plain request, no cache/pool/breaker; throws on HTTP and shape errors.
// Resolves to {qname: {choice, probabilities}}.
function segDecideRaw(cfg, questions, state) {
  var headers = {'Content-Type': 'application/json'};
  var body = {state: state, questions: questions};
  if(cfg.provider !== 'laya') {
    if(cfg.key) {
      headers[cfg.authHeader || 'Authorization'] =
        (cfg.authScheme != null ? cfg.authScheme : 'Bearer ') + cfg.key;
    }
    body.model = cfg.model || SEG_DEFAULT_JEV_MODEL;
  }
  return fetch(cfg.url, {method: 'POST', mode: 'cors', headers: headers,
                         body: JSON.stringify(body)})
    .then(function(resp) {
      if(resp.status != 200) {
        throw new Error('HTTP ' + resp.status);
      }
      return resp.json();
    })
    .then(function(json) {
      var answers = json && json.answers;
      if(!answers || typeof answers !== 'object') {
        throw new Error('Unexpected response shape');
      }
      var out = {};
      for(var q in questions) {
        if(!Object.prototype.hasOwnProperty.call(questions, q)) {
          continue;
        }
        var ans = answers[q];
        if(!ans || typeof ans.choice !== 'string' || !ans.choice) {
          throw new Error('Unexpected response shape');
        }
        out[q] = segNormalizeAnswer(ans, questions[q]);
      }
      return out;
    });
}

// Cached, pooled, circuit-broken decision. Resolves to answers, or null when
// no decision model is configured or the request failed (never rejects).
function segDecide(questions, state) {
  var cfg;
  try {
    cfg = segDecisionsResolved();
  } catch(e) {
    cfg = null;
  }
  if(!cfg) {
    return Promise.resolve(null);
  }
  var key = sugTextKey('dec|' + segDecisionsBase(cfg),
                       JSON.stringify(questions) + '\n' + state);
  if(SEG_AI.decMem[key]) {
    segAiStats.decisionCacheHits++;
    return Promise.resolve(SEG_AI.decMem[key]);
  }
  if(SEG_AI.decFails >= SEG_BREAKER_LIMIT) {
    return Promise.resolve(null);
  }
  if(SEG_AI.decInflight[key]) {
    return SEG_AI.decInflight[key];
  }
  var p = segIdbGet(key).then(function(stored) {
    if(stored && typeof stored === 'object') {
      SEG_AI.decMem[key] = stored;
      segAiStats.decisionCacheHits++;
      return stored;
    }
    return segPoolRun(SEG_AI.decPool, function() {
      // The breaker may have tripped while this job was queued
      if(SEG_AI.decFails >= SEG_BREAKER_LIMIT) {
        return null;
      }
      return segDecideRaw(cfg, questions, state).then(function(answers) {
        SEG_AI.decFails = 0;
        segAiStats.decisions++;
        SEG_AI.decMem[key] = answers;
        segIdbPut(key, answers);
        return answers;
      }, function(err) {
        SEG_AI.decFails++;
        segAiStats.decisionErrors++;
        console.warn('Segments: decision request failed:', segErrMessage(err)
          + (SEG_AI.decFails >= SEG_BREAKER_LIMIT
             ? ' (too many failures, giving up on decisions)' : ''));
        return null;
      });
    });
  }).then(function(v) {
    delete SEG_AI.decInflight[key];
    return v;
  }, function() {
    delete SEG_AI.decInflight[key];
    return null;
  });
  SEG_AI.decInflight[key] = p;
  return p;
}


/*
 * LLMs
 */

// Fast LLM: Promise<string|null>. null when the 'llm' task is not configured,
// the call failed or the answer was empty. Cached when it succeeds.
function segLLM(prompt, maxTokens) {
  var cfg;
  try {
    cfg = (typeof tagAiLLMConfig === 'function') ? tagAiLLMConfig('llm') : null;
  } catch(e) {
    cfg = null;
  }
  if(!cfg) {
    return Promise.resolve(null);
  }
  var key = sugTextKey('llm|' + cfg.url + '|' + (cfg.model || ''),
                       prompt + '\n#' + (maxTokens || 0) + '#' + cfg.temperature);
  if(SEG_AI.llmMem[key]) {
    segAiStats.llmCacheHits++;
    return Promise.resolve(SEG_AI.llmMem[key]);
  }
  if(SEG_AI.llmFails >= SEG_BREAKER_LIMIT) {
    return Promise.resolve(null);
  }
  if(SEG_AI.llmInflight[key]) {
    return SEG_AI.llmInflight[key];
  }
  var p = segIdbGet(key).then(function(stored) {
    if(typeof stored === 'string' && stored) {
      SEG_AI.llmMem[key] = stored;
      segAiStats.llmCacheHits++;
      return stored;
    }
    return segPoolRun(SEG_AI.llmPool, function() {
      if(SEG_AI.llmFails >= SEG_BREAKER_LIMIT) {
        return null;
      }
      return tagAiChat(cfg, prompt, maxTokens).then(function(text) {
        SEG_AI.llmFails = 0;
        if(typeof text !== 'string' || !text) {
          return null; // empty answer: not an outage, but not cacheable
        }
        segAiStats.llmCalls++;
        SEG_AI.llmMem[key] = text;
        segIdbPut(key, text);
        return text;
      }, function(err) {
        SEG_AI.llmFails++;
        segAiStats.llmErrors++;
        console.warn('Segments: LLM request failed:', segErrMessage(err)
          + (SEG_AI.llmFails >= SEG_BREAKER_LIMIT
             ? ' (too many failures, giving up on the fast LLM)' : ''));
        return null;
      });
    });
  }).then(function(v) {
    delete SEG_AI.llmInflight[key];
    return v;
  }, function() {
    delete SEG_AI.llmInflight[key];
    return null;
  });
  SEG_AI.llmInflight[key] = p;
  return p;
}

// Drafts the thematic segments from the support documents with the
// reasoning model. Promise<{segments:[{name, description, guide_questions}]}>;
// rejects with a user-readable Error.
function segGenerateGuide(supportDocs, tags) {
  var cfg = null;
  try {
    cfg = (typeof tagAiLLMConfig === 'function')
      ? tagAiLLMConfig('reasoning') : null;
  } catch(e) { /* treated as unconfigured */ }
  if(!cfg) {
    return Promise.reject(new Error(segT(
      'No reasoning model is configured. Set one up in the settings.')));
  }
  var prompt;
  try {
    prompt = segGuidePrompt(supportDocs, tags);
  } catch(e) {
    return Promise.reject(e);
  }
  return tagAiChat(cfg, prompt, 8000).then(function(text) {
    return segParseGuide(text);
  });
}


/*
 * Taguette server API (same origin)
 */

function segApiBase() {
  return '/api/project/' + project_id;
}

function segXsrf() {
  return encodeURIComponent(getCookie('_xsrf'));
}

// fetch() -> parsed JSON (or undefined for 204). Non-OK responses reject
// with an Error carrying the server's `error` message and `.status`.
function segRequest(method, url, init, expected) {
  var opts = {credentials: 'same-origin', mode: 'same-origin',
              redirect: 'error'};
  if(method !== 'GET') {
    opts.cache = 'no-cache';
  }
  opts.method = method;
  for(var k in init) {
    opts[k] = init[k];
  }
  return fetch(url, opts).then(function(response) {
    if(response.status != expected) {
      return response.json().then(function(json) {
        throw segApiError(response, json && json.error);
      }, function() {
        throw segApiError(response);
      });
    }
    if(expected == 204) {
      return undefined;
    }
    return response.json().catch(function() {
      throw segApiError(response, 'Invalid JSON');
    });
  });
}

function segApiError(response, message) {
  var err = new Error(message || ('Status ' + response.status));
  err.status = response.status;
  return err;
}

function segGetJSON(url, args) {
  return segRequest('GET', url + (args ? '?' + encodeGetParams(args) : ''),
                    {}, 200);
}

function segSendJSON(method, url, data) {
  return segRequest(method, url + '?_xsrf=' + segXsrf(), {
    headers: {'Content-Type': 'application/json; charset=utf-8'},
    body: JSON.stringify(data),
  }, 200);
}

// PUT counterpart of postJSON (taguette.js has none)
function segPutJSON(url, data) {
  return segSendJSON('PUT', url, data === undefined ? {} : data);
}

function segApiSupportDocs() {
  return segGetJSON(segApiBase() + '/support_documents').then(function(r) {
    return r.support_documents;
  });
}

// -> {id, name, kind, size, ...} (without contents)
function segApiAddSupportText(name, kind, text) {
  return segSendJSON('POST', segApiBase() + '/support_documents',
                     {name: name, kind: kind, text: text});
}

function segApiUploadSupportFile(file, name, kind) {
  var form = new FormData();
  form.append('file', file);
  if(name) {
    form.append('name', name);
  }
  if(kind) {
    form.append('kind', kind);
  }
  form.append('_xsrf', getCookie('_xsrf'));
  return segRequest('POST',
    segApiBase() + '/support_documents?_xsrf=' + segXsrf(),
    {body: form}, 200);
}

function segApiDeleteSupportDoc(id) {
  return segRequest('DELETE',
    segApiBase() + '/support_documents/' + encodeURIComponent(id)
      + '?_xsrf=' + segXsrf(),
    {}, 204);
}

function segApiGuide() {
  return segGetJSON(segApiBase() + '/thematic_segments').then(function(r) {
    return r.thematic_segments;
  });
}

function segApiSaveGuide(list) {
  return segPutJSON(segApiBase() + '/thematic_segments',
                    {thematic_segments: list}).then(function(r) {
    return r.thematic_segments;
  });
}


/*
 * Tag exemplars: the text of every tagged highlight in the project
 */

// Smallest char index c with byteOfChar[c] >= byte (byteOfChar holds the
// cumulative UTF-8 byte offset of every char boundary, see suggest.js)
function segByteToChar(byteOfChar, byte) {
  var lo = 0, hi = byteOfChar.length - 1;
  if(hi < 0) {
    return 0;
  }
  while(lo < hi) {
    var mid = (lo + hi) >> 1;
    if(byteOfChar[mid] < byte) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function segStripHtml(html) {
  if(typeof document !== 'undefined' && document && document.createElement
     && typeof tagAiStripHtml === 'function') {
    return tagAiStripHtml(html);
  }
  return String(html).replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

// Whole project, via GET /api/project/<id>/highlights/?page=N (an empty tag
// path lists ALL highlights, 50 per page). Page 1 tells how many pages
// there are; the rest are fetched with at most 5 requests in flight, so a
// project with N highlights costs ceil(N/50) requests.
// -> Promise<[{tagIds, text, docId, hlId, cStart?, cEnd?}]>, deduplicated by
// highlight id. Highlights with no tag or no text are dropped (useless as
// exemplars). cStart/cEnd (char offsets) are added for highlights of the
// open document. on_progress(pagesDone, pagesTotal) is optional.
function segFetchExemplars(on_progress) {
  var url = segApiBase() + '/highlights/';
  var pages = [];
  var total = 1;
  var done = 0;
  function fetchPage(n) {
    return segGetJSON(url, {page: n}).then(function(r) {
      pages[n - 1] = r.highlights || [];
      ++done;
      if(on_progress) {
        on_progress(done, total);
      }
      return r;
    });
  }
  return fetchPage(1).then(function(first) {
    total = Math.max(1, first.pages || 1);
    var next = 2;
    function worker() {
      if(next > total) {
        return Promise.resolve();
      }
      return fetchPage(next++).then(worker);
    }
    var workers = [];
    for(var w = 0; w < Math.min(SEG_EXEMPLAR_CONCURRENCY, total - 1); ++w) {
      workers.push(worker());
    }
    return Promise.all(workers);
  }).then(function() {
    return segBuildExemplars(pages);
  });
}

function segBuildExemplars(pages) {
  var seen = {};
  var out = [];
  var cur = (typeof current_document !== 'undefined') ? current_document : null;
  var hls = (typeof highlights !== 'undefined' && highlights) ? highlights : {};
  var boc = (typeof sug_session !== 'undefined' && sug_session
             && sug_session.byteOfChar) ? sug_session.byteOfChar : null;
  for(var p = 0; p < pages.length; ++p) {
    var list = pages[p] || [];
    for(var i = 0; i < list.length; ++i) {
      var h = list[i];
      if(seen[h.id]) {
        continue;
      }
      seen[h.id] = true;
      var tagIds = (h.tags || []).map(function(t) { return parseInt(t, 10); });
      if(!tagIds.length) {
        continue;
      }
      var text = segStripHtml(h.content || '');
      if(!text) {
        continue;
      }
      var ex = {tagIds: tagIds, text: text, docId: h.document_id, hlId: h.id};
      if(boc && cur !== null && h.document_id === cur) {
        var local = hls[String(h.id)];
        if(local && typeof local.start_offset === 'number') {
          ex.cStart = segByteToChar(boc, local.start_offset);
          ex.cEnd = segByteToChar(boc, local.end_offset);
        }
      }
      out.push(ex);
    }
  }
  return out;
}


/*
 * Deps for segRunAll()
 */

// opts: {progress?(stage, done, total)}
function segMakeDeps(opts) {
  opts = opts || {};
  var deps = {
    // Memory (L1) over sugEmbed's IndexedDB (L2). Identical texts within a
    // call are sent once. Vectors are not normalized.
    embed: function(texts) {
      var cfg = null;
      try {
        cfg = sugLoadConfig();
      } catch(e) { /* unconfigured */ }
      if(!cfg || !cfg.url) {
        return Promise.reject(new Error(segT(
          'No embedding model is configured. Set one up in the settings.')));
      }
      var ek = sugEmbKey(cfg);
      var mem = SEG_AI.embMem[ek] || (SEG_AI.embMem[ek] = {});
      var missing = [];
      var queued = {};
      for(var i = 0; i < texts.length; ++i) {
        var t = texts[i];
        if(mem[t] === undefined && !queued[t]) {
          queued[t] = true;
          missing.push(t);
        }
      }
      var fetched = missing.length
        ? sugEmbed(missing, cfg) : Promise.resolve([]);
      return fetched.then(function(vecs) {
        if(vecs.length !== missing.length) {
          throw new Error('Unexpected number of embeddings');
        }
        for(var j = 0; j < missing.length; ++j) {
          mem[missing[j]] = vecs[j];
        }
        return texts.map(function(t) { return mem[t]; });
      });
    },
    decide: segDecide,
    llm: segLLM,
  };
  if(typeof opts.progress === 'function') {
    deps.progress = opts.progress;
  }
  return deps;
}


/*
 * Self-test (browser: segAiSelfTest() in the console; Node:
 * scripts/segments_ai_selftest.js). Swaps fetch, localStorage's config,
 * the IndexedDB helpers and a few globals for mocks, and restores them.
 */

function segAiSelfTest() {
  var g = (typeof window !== 'undefined') ? window : globalThis;
  var failures = 0;
  function check(cond, msg) {
    if(!cond) {
      ++failures;
      console.error('SEG AI SELFTEST FAIL:', msg);
    }
  }
  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  // --- save state ---
  var saved = {};
  var names = ['fetch', 'sugIdbGetMany', 'sugIdbPutMany', 'project_id',
               'current_document', 'highlights', 'sug_session', 'getCookie'];
  names.forEach(function(n) { saved[n] = g[n]; });
  var had_cookie = g.document && 'cookie' in g.document;
  var saved_cookie = g.document ? g.document.cookie : undefined;
  var saved_conf = null;
  try {
    saved_conf = g.localStorage.getItem(TAGU_CONFIG_STORE);
  } catch(e) { /* ignore */ }
  var had_laya = !!TAGU_LOCALS.laya;
  var saved_warn = console.warn;
  var saved_pools = [SEG_AI.decPool.limit, SEG_AI.llmPool.limit];
  console.warn = function() {};

  function restore() {
    names.forEach(function(n) {
      if(saved[n] === undefined) {
        try { delete g[n]; } catch(e) { g[n] = undefined; }
      } else {
        g[n] = saved[n];
      }
    });
    if(g.document && had_cookie) {
      g.document.cookie = saved_cookie;
    }
    try {
      if(saved_conf === null) {
        g.localStorage.removeItem(TAGU_CONFIG_STORE);
      } else {
        g.localStorage.setItem(TAGU_CONFIG_STORE, saved_conf);
      }
    } catch(e) { /* ignore */ }
    if(!had_laya) {
      delete TAGU_LOCALS.laya;
    }
    console.warn = saved_warn;
    SEG_AI.decPool.limit = saved_pools[0];
    SEG_AI.llmPool.limit = saved_pools[1];
    segAiReset(true);
  }

  function setConfig(cfg) {
    cfg.version = 1;
    cfg.keys = cfg.keys || [];
    g.localStorage.setItem(TAGU_CONFIG_STORE, JSON.stringify(cfg));
  }

  // --- mocks ---
  var calls = [];        // {url, init, body}
  var inflight = 0, max_inflight = 0;
  var handler = null;    // (call) -> {status, json, delay}
  function mockFetch(url, init) {
    var call = {url: url, init: init || {},
                body: (init && typeof init.body === 'string')
                  ? JSON.parse(init.body) : (init && init.body)};
    calls.push(call);
    var r = handler(call);
    ++inflight;
    max_inflight = Math.max(max_inflight, inflight);
    return sleep(r.delay || 0).then(function() {
      --inflight;
      return {status: r.status === undefined ? 200 : r.status,
              json: function() {
                return r.json === undefined
                  ? Promise.reject(new Error('no json'))
                  : Promise.resolve(r.json);
              }};
    });
  }
  var idb = {};
  var idb_puts = 0;
  function installMocks() {
    g.fetch = mockFetch;
    g.sugIdbGetMany = function(keys) {
      var out = {};
      keys.forEach(function(k) { if(idb[k] !== undefined) { out[k] = idb[k]; } });
      return Promise.resolve(out);
    };
    g.sugIdbPutMany = function(entries) {
      entries.forEach(function(e) { idb[e.key] = e.vec; ++idb_puts; });
      return Promise.resolve();
    };
    calls = []; inflight = 0; max_inflight = 0; idb = {}; idb_puts = 0;
    segAiReset(true);
  }

  var Q = {pick: {type: 'choice', instructions: 'x',
                  criteria: {a: 'A', b: 'B', c: 'C'}}};
  function ok(choice, conf, probs) {
    var a = {choice: choice};
    if(conf !== undefined) { a.answer_confidence = conf; }
    if(probs) { a.probabilities = probs; }
    return {status: 200, json: {answers: {pick: a}}};
  }
  function near(a, b) { return Math.abs(a - b) < 1e-9; }

  var url = 'http://seg-test.invalid/decisions';
  var chain = Promise.resolve();
  function step(fn) {
    chain = chain.then(fn);
  }

  try {
    installMocks();

    // --- laya vs jev wire format ---
    step(function() {
      g.TAGU_LOCALS.laya = {label: 'Laya', kind: 'decisions',
                            url: 'http://localhost:8000', path: '/v1/systemone'};
      setConfig({tasks: {decisions: {source: 'local:laya'}}});
      handler = function() { return ok('a', 0.8); };
      var cfg = segDecisionsResolved();
      check(cfg && cfg.provider === 'laya'
            && cfg.url === 'http://localhost:8000/v1/systemone',
            'laya resolves to the local systemone URL');
      return segDecide(Q, 'state 1').then(function(ans) {
        check(calls.length === 1, 'laya: one request');
        var c = calls[0];
        check(c.init.method === 'POST', 'laya: POST');
        check(c.body.state === 'state 1' && c.body.questions.pick, 'laya: body');
        check(!('model' in c.body), 'laya: no model in body');
        check(!c.init.headers.Authorization, 'laya: no auth header');
        check(ans && ans.pick.choice === 'a', 'laya: answer choice');
      });
    });
    step(function() {
      installMocks();
      setConfig({tasks: {decisions: {source: 'custom', url: url,
                                     token: 'TOK', model: 'my-model'}}});
      handler = function() { return ok('b', 0.7); };
      return segDecide(Q, 's').then(function() {
        var c = calls[0];
        check(c.url === url, 'jev: url');
        check(c.init.headers.Authorization === 'Bearer TOK', 'jev: auth header');
        check(c.body.model === 'my-model', 'jev: model');
      });
    });
    step(function() {
      installMocks();
      setConfig({keys: [{id: 'k1', provider: 'openrouter', token: 'sk-x'}],
                 tasks: {decisions: {source: 'key:k1'}}});
      var cfg = segDecisionsResolved();
      check(cfg && cfg.provider === 'jev'
            && cfg.url === 'https://openrouter.ai/api/alpha/decisions'
            && cfg.model === '~typesafe/jev-latest',
            'openrouter key: default URL and model');
      check(segDecisionsDefaultPath({provider: 'openai'}) === '',
            'default path empty for other providers');
      handler = function() { return ok('a', 1); };
      return segDecide(Q, 's').then(function() {
        check(calls[0].init.headers.Authorization === 'Bearer sk-x',
              'key: bearer header');
        check(calls[0].body.model === '~typesafe/jev-latest',
              'key: default model in body');
      });
    });

    // --- normalization ---
    step(function() {
      installMocks();
      setConfig({tasks: {decisions: {source: 'custom', url: url}}});
      handler = function() { return ok('b', 0.7); };
      return segDecide(Q, 'norm1').then(function(ans) {
        var p = ans && ans.pick.probabilities;
        check(p && near(p.b, 0.7) && near(p.a, 0.15) && near(p.c, 0.15),
              'synthesized probabilities from answer_confidence');
        handler = function() { return ok('c'); };
        return segDecide(Q, 'norm2');
      }).then(function(ans) {
        var p = ans && ans.pick.probabilities;
        check(p && p.c === 1 && p.a === 0 && p.b === 0,
              'no confidence -> choice gets 1');
        handler = function() { return ok('a', 0.9, {a: 0.6, b: 0.3, c: 0.1}); };
        return segDecide(Q, 'norm3');
      }).then(function(ans) {
        var p = ans && ans.pick.probabilities;
        check(p && p.a === 0.6 && p.b === 0.3, 'given probabilities kept');
        handler = function() { return {status: 200, json: {answers: {}}}; };
        return segDecide(Q, 'norm4');
      }).then(function(ans) {
        check(ans === null, 'missing answer -> null');
        return segDecideRaw(segDecisionsResolved(), Q, 'x').then(function() {
          check(false, 'segDecideRaw should throw on bad shape');
        }, function(err) {
          check(/shape/.test(err.message), 'segDecideRaw throws on bad shape');
        });
      });
    });

    // --- caching ---
    step(function() {
      installMocks();
      setConfig({tasks: {decisions: {source: 'custom', url: url}}});
      handler = function() { return ok('a', 0.5); };
      return segDecide(Q, 'cache').then(function() {
        var n = calls.length;
        check(n === 1 && idb_puts === 1, 'first call fetches and persists');
        return segDecide(Q, 'cache').then(function(ans) {
          check(calls.length === n, 'memory cache: no second fetch');
          check(ans && ans.pick.choice === 'a', 'memory cache: answer');
          check(segAiStats.decisionCacheHits === 1, 'cache hit counted');
          SEG_AI.decMem = {};
          return segDecide(Q, 'cache');
        }).then(function(ans) {
          check(calls.length === n, 'IndexedDB cache: no second fetch');
          check(ans && ans.pick.choice === 'a', 'IndexedDB cache: answer');
        });
      });
    });
    step(function() {
      installMocks();
      setConfig({tasks: {decisions: {source: 'custom', url: url}}});
      handler = function() { return {status: 500, json: {error: 'boom'}}; };
      return segDecide(Q, 'fail').then(function(ans) {
        check(ans === null, 'HTTP error -> null');
        check(idb_puts === 0, 'failures are not persisted');
        handler = function() { return ok('a', 0.5); };
        return segDecide(Q, 'fail');
      }).then(function(ans) {
        check(ans && ans.pick.choice === 'a', 'failure was not cached');
        check(segAiStats.decisionErrors === 1, 'error counted');
      });
    });

    // --- unconfigured ---
    step(function() {
      installMocks();
      setConfig({tasks: {}});
      return segDecide(Q, 'x').then(function(ans) {
        check(ans === null && calls.length === 0, 'decisions off -> null, no fetch');
        return segLLM('hello', 10);
      }).then(function(t) {
        check(t === null && calls.length === 0, 'llm off -> null, no fetch');
        return segGenerateGuide([], []);
      }).then(function() {
        check(false, 'segGenerateGuide should reject when unconfigured');
      }, function(err) {
        check(err instanceof Error && /reasoning/i.test(err.message),
              'segGenerateGuide rejects readably when unconfigured');
        return segMakeDeps().embed(['a']);
      }).then(function() {
        check(false, 'embed should reject when unconfigured');
      }, function(err) {
        check(err instanceof Error && /embedding/i.test(err.message),
              'embed rejects when no embedding model');
      });
    });

    // --- concurrency ---
    step(function() {
      installMocks();
      setConfig({tasks: {decisions: {source: 'custom', url: url}}});
      handler = function() { var r = ok('a', 0.5); r.delay = 8; return r; };
      var ps = [];
      for(var i = 0; i < 20; ++i) {
        ps.push(segDecide(Q, 'conc' + i));
      }
      return Promise.all(ps).then(function(all) {
        check(all.every(function(a) { return a; }), 'concurrency: all answered');
        check(calls.length === 20, 'concurrency: 20 requests');
        check(max_inflight === 4, 'at most 4 decision requests in flight '
              + '(saw ' + max_inflight + ')');
        // identical concurrent calls share one request
        calls = [];
        return Promise.all([segDecide(Q, 'same'), segDecide(Q, 'same'),
                            segDecide(Q, 'same')]);
      }).then(function() {
        check(calls.length === 1, 'identical in-flight requests are shared');
      });
    });

    // --- breaker ---
    step(function() {
      installMocks();
      setConfig({tasks: {decisions: {source: 'custom', url: url}}});
      handler = function() { return {status: 503}; };
      var p = Promise.resolve();
      for(var i = 0; i < 5; ++i) {
        (function(i) {
          p = p.then(function() { return segDecide(Q, 'brk' + i); });
        })(i);
      }
      return p.then(function() {
        check(calls.length === 5, 'breaker: 5 failing requests');
        return segDecide(Q, 'brk-after');
      }).then(function(ans) {
        check(ans === null && calls.length === 5,
              'breaker open: null without fetching');
        segAiReset();
        handler = function() { return ok('a', 0.5); };
        return segDecide(Q, 'brk-after');
      }).then(function(ans) {
        check(ans && calls.length === 6, 'segAiReset closes the breaker');
      });
    });
    step(function() {
      // queued jobs notice the breaker tripping mid-batch
      installMocks();
      setConfig({tasks: {decisions: {source: 'custom', url: url}}});
      handler = function() { return {status: 500, delay: 5}; };
      var ps = [];
      for(var i = 0; i < 30; ++i) {
        ps.push(segDecide(Q, 'bq' + i));
      }
      return Promise.all(ps).then(function() {
        check(calls.length < 30, 'breaker stops queued requests (sent '
              + calls.length + ')');
      });
    });

    // --- LLM ---
    var llm_url = 'http://seg-test.invalid/chat';
    function chatOK(text) {
      return {status: 200, json: {choices: [{message: {content: text},
                                             finish_reason: 'stop'}]}};
    }
    step(function() {
      installMocks();
      setConfig({tasks: {llm: {source: 'custom', url: llm_url, model: 'm'}}});
      handler = function() { var r = chatOK(' hi there '); r.delay = 8; return r; };
      return segLLM('prompt 1', 50).then(function(t) {
        check(t === 'hi there', 'llm: trimmed text');
        check(calls.length === 1 && calls[0].body.max_tokens === 50
              && calls[0].body.messages[1].content === 'prompt 1',
              'llm: request format');
        return segLLM('prompt 1', 50);
      }).then(function(t) {
        check(t === 'hi there' && calls.length === 1, 'llm: memory cache');
        check(idb_puts === 1, 'llm: persisted');
        var ps = [];
        for(var i = 0; i < 8; ++i) {
          ps.push(segLLM('p' + i, 50));
        }
        return Promise.all(ps);
      }).then(function() {
        check(max_inflight <= 2, 'at most 2 llm requests in flight (saw '
              + max_inflight + ')');
        handler = function() { return {status: 500}; };
        var p = Promise.resolve();
        for(var i = 0; i < 5; ++i) {
          (function(i) {
            p = p.then(function() { return segLLM('f' + i, 5); });
          })(i);
        }
        return p;
      }).then(function() {
        var n = calls.length;
        return segLLM('after', 5).then(function(t) {
          check(t === null && calls.length === n, 'llm breaker open');
          check(segAiStats.llmErrors === 5, 'llm errors counted');
        });
      });
    });
    step(function() {
      // reasoning model + guide generation (needs the core's prompt/parser)
      if(typeof segGuidePrompt !== 'function' || typeof segParseGuide !== 'function') {
        return;
      }
      installMocks();
      setConfig({tasks: {reasoning: {source: 'custom', url: llm_url,
                                     model: 'big'}}});
      handler = function() {
        return chatOK('{"segments":[{"name":"Work","description":"d",'
                      + '"guide_questions":["What do you do?"]}]}');
      };
      return segGenerateGuide([{name: 'Script', kind: 'script',
                                contents: 'What do you do?'}], [])
        .then(function(r) {
          check(r && r.segments && r.segments[0].name === 'Work',
                'segGenerateGuide parses the reply');
          check(calls[0].body.max_tokens === 8000 && calls[0].body.model === 'big',
                'segGenerateGuide uses the reasoning task');
        });
    });

    // --- server API helpers ---
    step(function() {
      installMocks();
      g.project_id = 7;
      if(g.document) { g.document.cookie = '_xsrf=tok123'; }
      g.getCookie = function(name) {
        var r = (g.document ? g.document.cookie : '')
          .match('\\b' + name + '=([^;]*)\\b');
        return r ? r[1] : undefined;
      };
      handler = function(call) {
        if(call.init.method === 'PUT') {
          return {status: 200, json: {thematic_segments: [{id: 1, name: 'x'}]}};
        }
        if(call.init.method === 'DELETE') {
          return {status: 204};
        }
        if(/support_documents/.test(call.url) && call.init.method === 'GET') {
          return {status: 200, json: {support_documents: [{id: 1}]}};
        }
        return {status: 400, json: {error: 'Name cannot be empty'}};
      };
      return segPutJSON('/api/project/7/thematic_segments', {a: 1})
        .then(function(r) {
          var c = calls[0];
          check(c.init.method === 'PUT', 'segPutJSON: method');
          check(c.url === '/api/project/7/thematic_segments?_xsrf=tok123',
                'segPutJSON: xsrf query (' + c.url + ')');
          check(c.init.headers['Content-Type'].indexOf('application/json') === 0
                && c.body.a === 1, 'segPutJSON: JSON body');
          check(c.init.credentials === 'same-origin', 'segPutJSON: same-origin');
          check(r.thematic_segments[0].id === 1, 'segPutJSON: parsed JSON');
          return segApiSaveGuide([{name: 'x'}]);
        }).then(function(list) {
          check(list.length === 1 && calls[1].body.thematic_segments[0].name === 'x',
                'segApiSaveGuide');
          return segApiSupportDocs();
        }).then(function(docs) {
          check(docs.length === 1 && calls[2].url === '/api/project/7/support_documents',
                'segApiSupportDocs');
          return segApiDeleteSupportDoc(3);
        }).then(function() {
          check(calls[3].init.method === 'DELETE'
                && calls[3].url === '/api/project/7/support_documents/3?_xsrf=tok123',
                'segApiDeleteSupportDoc');
          return segApiAddSupportText('', 'script', 'text');
        }).then(function() {
          check(false, 'API error should reject');
        }, function(err) {
          check(err instanceof Error && err.message === 'Name cannot be empty'
                && err.status === 400, 'API errors carry the server message');
          if(typeof FormData === 'undefined') {
            return;
          }
          handler = function() { return {status: 200, json: {id: 9}}; };
          var f = {name: 'f.txt'};
          return segApiUploadSupportFile(f, 'F', 'script').then(function() {
            var c = calls[calls.length - 1];
            check(c.init.method === 'POST' && c.body instanceof FormData
                  && c.body.get('name') === 'F' && c.body.get('kind') === 'script'
                  && c.body.get('_xsrf') === 'tok123'
                  && !(c.init.headers && c.init.headers['Content-Type']),
                  'segApiUploadSupportFile: multipart form');
          });
        });
    });

    // --- exemplars ---
    step(function() {
      installMocks();
      g.project_id = 7;
      g.current_document = 2;
      g.highlights = {'12': {id: 12, start_offset: 2, end_offset: 5, tags: [1]}};
      g.sug_session = {byteOfChar: [0, 1, 2, 4, 5, 6, 7]};
      var n_pages = 7;
      handler = function(call) {
        var page = parseInt(/page=(\d+)/.exec(call.url)[1], 10);
        var hl = [];
        for(var i = 0; i < 3; ++i) {
          var id = (page - 1) * 3 + i + 1;
          hl.push({id: id, document_id: id <= 12 ? 2 : 3,
                   content: '<p>Text &amp; ' + id + '</p>',
                   tags: id === 5 ? [] : [1, 2]});
        }
        if(page === 3) { hl.push({id: 1, document_id: 2, content: 'dup', tags: [1]}); }
        return {status: 200, json: {highlights: hl, pages: n_pages}, delay: 6};
      };
      var progress = [];
      return segFetchExemplars(function(d, t) { progress.push([d, t]); })
        .then(function(ex) {
          check(calls.length === n_pages, 'exemplars: one request per page');
          check(calls[0].url.indexOf('/api/project/7/highlights/?page=1') === 0,
                'exemplars: URL ' + calls[0].url);
          check(max_inflight <= 5, 'exemplars: at most 5 in flight (saw '
                + max_inflight + ')');
          check(ex.length === n_pages * 3 - 1, 'exemplars: deduped, untagged '
                + 'dropped (' + ex.length + ')');
          check(ex[0].text === 'Text & 1' && ex[0].hlId === 1
                && ex[0].docId === 2 && ex[0].tagIds[1] === 2,
                'exemplars: shape and html stripped');
          var h12 = ex.filter(function(e) { return e.hlId === 12; })[0];
          check(h12 && h12.cStart === 2 && h12.cEnd === 4,
                'exemplars: cStart/cEnd for the open document');
          var h13 = ex.filter(function(e) { return e.hlId === 13; })[0];
          check(h13 && h13.cStart === undefined, 'exemplars: no offsets elsewhere');
          check(progress.length === n_pages
                && progress[progress.length - 1][0] === n_pages,
                'exemplars: progress');
        });
    });
    step(function() {
      var b = [0, 1, 2, 4, 5, 6, 7];
      check(segByteToChar(b, 0) === 0 && segByteToChar(b, 4) === 3
            && segByteToChar(b, 7) === 6 && segByteToChar(b, 99) === 6
            && segByteToChar(b, 3) === 3, 'segByteToChar');
    });

    // --- deps.embed ---
    step(function() {
      installMocks();
      setConfig({tasks: {embeddings: {source: 'custom',
                                      url: 'http://seg-test.invalid/emb' + Date.now(),
                                      model: 'e'}}});
      handler = function(call) {
        return {status: 200, json: {data: call.body.input.map(function(t) {
          return {embedding: [t.length, 1]};
        })}};
      };
      var progress = [];
      var deps = segMakeDeps({progress: function(s, d, t) { progress.push(s); }});
      check(typeof deps.progress === 'function' && deps.decide === segDecide
            && deps.llm === segLLM, 'segMakeDeps wiring');
      return deps.embed(['aa', 'b', 'aa']).then(function(v) {
        check(calls.length === 1 && calls[0].body.input.length === 2,
              'embed dedupes texts within a call');
        check(v.length === 3 && v[0][0] === 2 && v[1][0] === 1 && v[2][0] === 2,
              'embed keeps order');
        return deps.embed(['b', 'aa']);
      }).then(function(v) {
        check(calls.length === 1, 'embed L1 memory cache');
        check(v[0][0] === 1 && v[1][0] === 2, 'embed cached values');
      });
    });
  } catch(e) {
    ++failures;
    console.error('SEG AI SELFTEST FAIL: exception', e);
  }

  return chain.then(null, function(e) {
    ++failures;
    console.error('SEG AI SELFTEST FAIL: exception', e);
  }).then(function() {
    restore();
    if(failures) {
      console.error('SEG AI SELFTEST: ' + failures + ' failure(s)');
    } else {
      console.log('SEG AI SELFTEST OK');
    }
    return failures;
  });
}
