/*
 * Suggested highlights: semi-supervised coding support.
 *
 * Runs TextRank / LexRank / YAKE / RAKE over the loaded document (client-side,
 * no new server endpoints), shows the suggestions as shades of yellow with
 * blinking brackets, and lets the user adjust / merge / accept them into real
 * highlights. Optionally re-scores candidates with an OpenAI-compatible
 * embeddings endpoint (OpenRouter, or a local server running e.g. MiniLM).
 *
 * All state lives in `sug_session` (browser memory): suggestions are ephemeral,
 * accepted ones are staged client-side and only POSTed to the regular
 * highlight API when the user stops the session with "Save".
 *
 * - Algorithms
 * - Scoring helpers (percentile, cut-off, merge)
 * - Plain-text byte index
 * - Embedding client
 * - Session state + rendering
 * - Brackets + dragging + merging
 * - Context menus
 * - Split screen
 * - Config screen
 * - Stop / save / discard
 * - Init + self-test
 */


/*
 * Algorithms
 */

// Compact English stopword list for the lexical algorithms
var SUG_STOPWORDS = {};
(function() {
  var words = (
    'a about above after again against all am an and any are as at be because been ' +
    'before being below between both but by can cannot could did do does doing down ' +
    'during each few for from further had has have having he her here hers herself ' +
    'him himself his how i if in into is it its itself just me more most my myself ' +
    'no nor not now of off on once only or other our ours ourselves out over own ' +
    'same she should so some such than that the their theirs them themselves then ' +
    'there these they this those through to too under until up very was we were what ' +
    'when where which while who whom why will with you your yours yourself yourselves ' +
    'also may might must shall would one two three upon within without said says'
  ).split(' ');
  for(var i = 0; i < words.length; ++i) {
    SUG_STOPWORDS[words[i]] = true;
  }
})();

// Conversational fillers: not stopwords for written prose, but pure noise in
// interview transcriptions ("I think that...", "Yeah, right"). Only filtered
// when transcription mode is on.
var SUG_TRANSCRIPTION = false;
var SUG_FILLERS = {};
(function() {
  var words = (
    'yeah yep yup mm mmhmm hmm uh um umm er ah oh okay okey right knows knew ' +
    'know mean means meant like liked really sort sorta kinda kind gonna wanna ' +
    'gotta gotten stuffs lots maybe perhaps probably anyway anyways whatever ' +
    'cuz cos til till thing things stuff lot bit actually basically literally ' +
    'suppose guess thinks thought think gets getting got get just'
  ).split(' ');
  for(var i = 0; i < words.length; ++i) {
    SUG_FILLERS[words[i]] = true;
  }
})();

// Stopword check that takes the transcription mode into account
function sugIsStop(word) {
  return SUG_STOPWORDS[word]
    || (SUG_TRANSCRIPTION && SUG_FILLERS[word]);
}

var SUG_WORD_RE = new RegExp('[\\p{L}\\p{N}][\\p{L}\\p{N}\u0027\u2019-]*', 'gu');

// Word tokens of `text` as {word, start, end} (JS char indices, lowercased)
function sugTokenize(text) {
  var tokens = [];
  var m;
  SUG_WORD_RE.lastIndex = 0;
  while((m = SUG_WORD_RE.exec(text)) !== null) {
    tokens.push({
      word: m[0].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return tokens;
}

// Sentences of `text` as {start, end, text} (JS char indices)
var SUG_MAX_SENTENCE_WORDS = 60;

// Split one line's runs at sentence terminators
function sugSentenceRuns(text, base, out) {
  var re = new RegExp('[^.!?]+[.!?]+["\'\u2019\\)\\]]*|[^.!?]+$', 'g');
  var m;
  while((m = re.exec(text)) !== null) {
    var chunk = m[0];
    var end = m.index + chunk.length;
    while(end > m.index && /\s/.test(text[end - 1])) {
      --end;
    }
    var start = m.index;
    while(start < end && /\s/.test(text[start])) {
      ++start;
    }
    if(end - start >= 2) {
      sugCapSentence({start: base + start, end: base + end,
                      text: text.substring(start, end)}, out);
    }
  }
}

// Cap a run at SUG_MAX_SENTENCE_WORDS words: transcriptions often contain
// long stretches without punctuation, which would otherwise become one
// giant highlight. Prefers a comma/semicolon break near the cut point.
function sugCapSentence(s, out) {
  var toks = sugTokenize(s.text);
  if(toks.length <= SUG_MAX_SENTENCE_WORDS) {
    out.push(s);
    return;
  }
  var i = 0;
  while(i < toks.length) {
    var j = Math.min(i + SUG_MAX_SENTENCE_WORDS, toks.length);
    if(j < toks.length) {
      for(var q = j - 1; q > Math.max(i, j - 16); --q) {
        if(/[,;:\u2014\u2013]/.test(s.text.substring(toks[q - 1].end, toks[q].start))) {
          j = q;
          break;
        }
      }
    }
    out.push({
      start: s.start + toks[i].start,
      end: s.start + toks[j - 1].end,
      text: s.text.substring(toks[i].start, toks[j - 1].end),
    });
    i = j;
  }
}

// Sentences of `text` as {start, end, text} (JS char indices). Newlines are
// hard boundaries (speaker turns in transcriptions), and runs without
// punctuation are capped at SUG_MAX_SENTENCE_WORDS words.
function sugSplitSentences(text) {
  var sentences = [];
  var lines = text.split('\n');
  var offset = 0;
  for(var l = 0; l < lines.length; ++l) {
    sugSentenceRuns(lines[l], offset, sentences);
    offset += lines[l].length + 1;
  }
  if(sentences.length === 0 && text.trim().length > 0) {
    sentences.push({start: 0, end: text.length, text: text});
  }
  return sentences;
}

function sugContentWords(tokens) {
  var words = [];
  for(var i = 0; i < tokens.length; ++i) {
    if(!sugIsStop(tokens[i].word) && tokens[i].word.length > 1) {
      words.push(tokens[i].word);
    }
  }
  return words;
}

// Backchannel / too-thin-to-rank sentence ("Yeah.", "Mm-hm.", "I think so").
// Only meaningful in transcription mode.
function sugIsBackchannel(sentence) {
  var toks = sugTokenize(sentence.text);
  var content = sugContentWords(toks).length;
  return content === 0 || (toks.length <= 3 && content <= 1);
}

// Sentences usable as ranking candidates: in transcription mode, drop
// backchannels and sentences without at least 2 content words
function sugRankableSentences(text) {
  var sentences = sugSplitSentences(text);
  if(!SUG_TRANSCRIPTION) {
    return sentences;
  }
  return sentences.filter(function(s) {
    return !sugIsBackchannel(s)
      && sugContentWords(sugTokenize(s.text)).length >= 2;
  });
}

// Heuristic: sparse punctuation, frequent fillers, or many very short
// "sentences" suggest a verbatim transcription rather than written prose
function sugDetectTranscription(text) {
  var words = (text.match(SUG_WORD_RE) || []).length;
  if(words === 0) {
    return false;
  }
  if((text.match(/[.!?]/g) || []).length / words < 0.05) {
    return true;
  }
  if((text.match(/\b(yeah|yep|yup|mm+|hmm+|uh+|um+)\b/gi) || []).length / words > 0.008) {
    return true;
  }
  var sentences = sugSplitSentences(text);
  if(sentences.length >= 10) {
    var short = 0;
    for(var i = 0; i < sentences.length; ++i) {
      if(sugTokenize(sentences[i].text).length <= 3) {
        ++short;
      }
    }
    if(short / sentences.length > 0.2) {
      return true;
    }
  }
  return false;
}

// Expand keyphrase candidates (YAKE/RAKE) to the sentence/turn containing
// them, so the suggestion shows the whole argument rather than 2-3 words
function sugExpandToSentences(cands, sentences) {
  for(var i = 0; i < cands.length; ++i) {
    var c = cands[i];
    for(var j = 0; j < sentences.length; ++j) {
      var s = sentences[j];
      if(s.start <= c.start && c.end <= s.end) {
        if(s.end - s.start > c.end - c.start) {
          c.start = s.start;
          c.end = s.end;
        }
        break;
      }
    }
  }
  return cands;
}

function sugBag(words) {
  var bag = {};
  for(var i = 0; i < words.length; ++i) {
    bag[words[i]] = (bag[words[i]] || 0) + 1;
  }
  return bag;
}

// Weighted PageRank over a symmetric weight matrix (array of arrays).
function sugPageRank(weights, iterations) {
  var n = weights.length;
  if(n === 0) {
    return [];
  }
  var d = 0.85;
  var out_sum = [];
  for(var i = 0; i < n; ++i) {
    var s = 0;
    for(var j = 0; j < n; ++j) {
      s += weights[i][j];
    }
    out_sum.push(s);
  }
  var ranks = [];
  for(i = 0; i < n; ++i) {
    ranks.push(1 / n);
  }
  for(var it = 0; it < iterations; ++it) {
    var next = [];
    var delta = 0;
    for(i = 0; i < n; ++i) {
      var acc = 0;
      for(var j = 0; j < n; ++j) {
        if(out_sum[j] > 0) {
          acc += weights[j][i] / out_sum[j] * ranks[j];
        }
      }
      next.push((1 - d) / n + d * acc);
    }
    for(i = 0; i < n; ++i) {
      delta += Math.abs(next[i] - ranks[i]);
    }
    ranks = next;
    if(delta < 1e-6) {
      break;
    }
  }
  return ranks;
}

// TextRank (Mihalcea & Tarau 2004): sentence-similarity graph + PageRank.
function sugTextRank(text) {
  var sentences = sugRankableSentences(text);
  var n = sentences.length;
  if(n < 2) {
    return [];
  }
  var bags = [];
  for(var i = 0; i < n; ++i) {
    bags.push(sugBag(sugContentWords(sugTokenize(sentences[i].text))));
  }
  var weights = [];
  for(i = 0; i < n; ++i) {
    weights.push(new Array(n));
    weights[i][i] = 0;
  }
  for(i = 0; i < n; ++i) {
    for(var j = i + 1; j < n; ++j) {
      var inter = 0;
      var li = 0, lj = 0;
      for(var w in bags[i]) {
        li += bags[i][w];
        if(bags[j][w]) {
          inter += Math.min(bags[i][w], bags[j][w]);
        }
      }
      for(w in bags[j]) {
        lj += bags[j][w];
      }
      var sim = 0;
      if(inter > 0 && li > 0 && lj > 0) {
        sim = inter / (Math.log(li) + Math.log(lj));
      }
      weights[i][j] = weights[j][i] = sim;
    }
  }
  var ranks = sugPageRank(weights, 100);
  var out = [];
  for(i = 0; i < n; ++i) {
    out.push({start: sentences[i].start, end: sentences[i].end, raw: ranks[i]});
  }
  return out;
}

// LexRank (Erkan & Radev 2004), continuous variant: idf-modified cosine
// similarity graph + PageRank.
function sugLexRank(text) {
  var sentences = sugRankableSentences(text);
  var n = sentences.length;
  if(n < 2) {
    return [];
  }
  // TF-IDF vectors
  var tfs = [];
  var df = {};
  for(var i = 0; i < n; ++i) {
    var bag = sugBag(sugContentWords(sugTokenize(sentences[i].text)));
    tfs.push(bag);
    for(var w in bag) {
      df[w] = (df[w] || 0) + 1;
    }
  }
  var idf = {};
  for(w in df) {
    idf[w] = Math.log((n + 1) / (df[w] + 0.5));
  }
  var norms = [];
  for(i = 0; i < n; ++i) {
    var s = 0;
    for(w in tfs[i]) {
      var wi = tfs[i][w] * idf[w];
      s += wi * wi;
    }
    norms.push(Math.sqrt(s));
  }
  var weights = [];
  for(i = 0; i < n; ++i) {
    weights.push(new Array(n));
    weights[i][i] = 0;
  }
  for(i = 0; i < n; ++i) {
    for(var j = i + 1; j < n; ++j) {
      var dot = 0;
      for(w in tfs[i]) {
        if(tfs[j][w]) {
          var a = tfs[i][w] * idf[w];
          var b = tfs[j][w] * idf[w];
          dot += a * b;
        }
      }
      var sim = (norms[i] > 0 && norms[j] > 0) ? dot / (norms[i] * norms[j]) : 0;
      weights[i][j] = weights[j][i] = sim;
    }
  }
  var ranks = sugPageRank(weights, 100);
  var out = [];
  for(i = 0; i < n; ++i) {
    out.push({start: sentences[i].start, end: sentences[i].end, raw: ranks[i]});
  }
  return out;
}

// YAKE (Campos et al. 2020), simplified: term weights from position,
// frequency, relatedness and sentence spread; candidate n-grams (1-3).
function sugYake(text) {
  var sentences = sugSplitSentences(text);
  var tokens = sugTokenize(text);
  if(tokens.length === 0) {
    return [];
  }
  // Sentence index for each token
  var tok_sentence = [];
  var si = 0;
  for(var i = 0; i < tokens.length; ++i) {
    while(si < sentences.length - 1 && tokens[i].start >= sentences[si + 1].start) {
      ++si;
    }
    tok_sentence.push(si);
  }
  var doc_len = Math.max(tokens.length, 1);

  // Term statistics
  var stats = {};
  var pos_acc = {}, pos_n = {}, freq = {}, related = {}, max_related = {}, sent_set = {};
  for(i = 0; i < tokens.length; ++i) {
    var t = tokens[i].word;
    if(sugIsStop(t)) {
      continue;
    }
    freq[t] = (freq[t] || 0) + 1;
    pos_acc[t] = (pos_acc[t] || 0) + (i + 1) / doc_len;
    pos_n[t] = (pos_n[t] || 0) + 1;
    sent_set[t] = sent_set[t] || {};
    sent_set[t][tok_sentence[i]] = true;
    // Relatedness: co-occurrence within a 2-token window
    for(var d = -2; d <= 2; ++d) {
      if(d === 0 || i + d < 0 || i + d >= tokens.length) {
        continue;
      }
      var u = tokens[i + d].word;
      if(sugIsStop(u)) {
        continue;
      }
      var key = t + '\x00' + u;
      related[key] = (related[key] || 0) + 1;
      if(related[key] > (max_related[t] || 0)) {
        max_related[t] = related[key];
      }
    }
  }
  // Term weight W(t) = (position * frequency) / (relatedness * (1 + spread))
  var W = {};
  for(t in freq) {
    var position = 1 / (pos_acc[t] / pos_n[t] + 1); // earlier terms score higher
    var relatedness = 1 + (max_related[t] || 0) / freq[t];
    var spread = 0;
    for(si in sent_set[t]) {
      ++spread;
    }
    W[t] = (position * freq[t]) / (relatedness * (1 + spread));
  }
  // Candidate n-grams: contiguous non-stopword, non-punctuation runs of 1-3
  var candidates = [];
  for(i = 0; i < tokens.length; ++i) {
    if(sugIsStop(tokens[i].word)) {
      continue;
    }
    var span = {words: [], start: tokens[i].start, end: tokens[i].end};
    for(var k = 0; k < 3 && i + k < tokens.length; ++k) {
      var tk = tokens[i + k];
      if(k > 0) {
        if(sugIsStop(tk.word)) {
          break;
        }
        // Break on punctuation gaps between tokens
        if(text.substring(span.end, tk.start).search(/[\n.!?;:,]/) !== -1) {
          break;
        }
        span.words.push(tk.word);
        span.end = tk.end;
      } else {
        span.words.push(tk.word);
      }
    }
    candidates.push(span);
  }
  // Score, dedupe by phrase text
  var best = {};
  for(i = 0; i < candidates.length; ++i) {
    var c = candidates[i];
    var sum = 0, mx = 0;
    for(k = 0; k < c.words.length; ++k) {
      var w = W[c.words[k]] || 0;
      sum += w;
      if(w > mx) {
        mx = w;
      }
    }
    var score = sum / (mx + 1);
    var key = c.words.join(' ');
    if(!(key in best) || score > best[key].raw) {
      c.raw = score;
      best[key] = c;
    }
  }
  var out = [];
  for(key in best) {
    out.push({start: best[key].start, end: best[key].end, raw: best[key].raw});
  }
  return out;
}

// RAKE (Rose et al. 2010): phrases split on stopwords, score = sum of
// word degrees (degree/frequency).
function sugRake(text) {
  var tokens = sugTokenize(text);
  if(tokens.length === 0) {
    return [];
  }
  // Split into candidate phrases on stopwords and sentence punctuation
  var phrases = [];
  var current = null;
  var last_end = null;
  for(var i = 0; i < tokens.length; ++i) {
    var tk = tokens[i];
    var is_stop = sugIsStop(tk.word);
    var punct_gap = last_end !== null
      && text.substring(last_end, tk.start).search(/[\n.!?;:,]/) !== -1;
    if(is_stop || punct_gap) {
      current = null;
    } else {
      if(current === null) {
        current = {words: [], start: tk.start, end: tk.end};
        phrases.push(current);
      }
      current.words.push(tk.word);
      current.end = tk.end;
    }
    last_end = tk.end;
  }
  phrases = phrases.filter(function(p) { return p.words.length >= 1 && p.words.length <= 6; });
  if(phrases.length === 0) {
    return [];
  }
  // Word frequency and degree
  var word_freq = {}, word_degree = {};
  for(i = 0; i < phrases.length; ++i) {
    var degree = phrases[i].words.length - 1;
    for(var k = 0; k < phrases[i].words.length; ++k) {
      var w = phrases[i].words[k];
      word_freq[w] = (word_freq[w] || 0) + 1;
      word_degree[w] = (word_degree[w] || 0) + degree;
    }
  }
  // Phrase score
  var out = [];
  var seen = {};
  for(i = 0; i < phrases.length; ++i) {
    var score = 0;
    for(k = 0; k < phrases[i].words.length; ++k) {
      w = phrases[i].words[k];
      score += (word_degree[w] + word_freq[w]) / word_freq[w];
    }
    var key = phrases[i].words.join(' ');
    if(seen[key] !== undefined) {
      // One suggestion per phrase text: keep the best occurrence's score
      if(score > seen[key].raw) {
        seen[key].raw = score;
      }
      continue;
    }
    seen[key] = phrases[i];
    phrases[i].raw = score;
    out.push(phrases[i]);
  }
  return out;
}

var SUG_ALGOS = {
  textrank: {label: 'TextRank', run: sugTextRank},
  lexrank: {label: 'LexRank', run: sugLexRank},
  yake: {label: 'YAKE', run: sugYake},
  rake: {label: 'RAKE', run: sugRake},
};

var SUG_ALGO_OPTIONS = ['textrank', 'lexrank', 'yake', 'rake'];

// Caches (module-level, so they survive session restarts in the same page):
// - SUG_ALGO_CACHE: algorithm results per document, so switching back to an
//   algorithm is instant (candidates keep their embedding scores)
// - SUG_EMB_CACHE: embeddings keyed by text, so switching algorithms or
//   restarting the session never re-embeds the same text
// - SUG_CENTROID_CACHE: document centroid vector, computed from the (cached)
//   sentence embeddings
var SUG_ALGO_CACHE = {};     // document_id -> { algo: candidates[] }
var SUG_EMB_CACHE = {};      // embKey -> { text: vector }
var SUG_CENTROID_CACHE = {}; // document_id + '|' + embKey -> vector
var SUG_QA_CACHE = {};       // decision key + '|' + text hash -> {role, prob}

function sugEmbKey(cfg) {
  return cfg.url + '|' + (cfg.model || '');
}


/*
 * L2 vector persistence (IndexedDB). The in-memory caches die with the page;
 * these survive reloads and browser restarts, so re-opening the suggest
 * tool doesn't re-embed (and re-pay) the same document. Degrades to a no-op
 * when storage is unavailable (private mode, blocked, jsdom, ...).
 */

var SUG_IDB = {db_promise: null, dead: false};

function sugIdbOpen() {
  if(SUG_IDB.dead || !window.indexedDB) {
    return Promise.resolve(null);
  }
  if(!SUG_IDB.db_promise) {
    SUG_IDB.db_promise = new Promise(function(resolve) {
      var req;
      try {
        req = window.indexedDB.open('taguette_suggest', 1);
      } catch(e) {
        SUG_IDB.dead = true;
        resolve(null);
        return;
      }
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if(!db.objectStoreNames.contains('vectors')) {
          db.createObjectStore('vectors');
        }
      };
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror = function() { SUG_IDB.dead = true; resolve(null); };
      req.onblocked = function() { SUG_IDB.dead = true; resolve(null); };
    });
  }
  return SUG_IDB.db_promise;
}

// One lookup per key, all inside a single read transaction
function sugIdbGetMany(keys) {
  return sugIdbOpen().then(function(db) {
    if(!db || !keys.length) {
      return {};
    }
    return new Promise(function(resolve) {
      var out = {};
      try {
        var tx = db.transaction(['vectors'], 'readonly');
        var store = tx.objectStore('vectors');
        keys.forEach(function(k) {
          var req = store.get(k);
          req.onsuccess = function() {
            if(req.result) {
              out[k] = req.result;
            }
          };
        });
        // The transaction completes once every get has settled
        tx.oncomplete = function() { resolve(out); };
        tx.onerror = function() { resolve(out); };
      } catch(e) {
        resolve(out);
      }
    });
  });
}

function sugIdbPutMany(entries) { // [{key, vec}]
  return sugIdbOpen().then(function(db) {
    if(!db || !entries.length) {
      return;
    }
    return new Promise(function(resolve) {
      try {
        var tx = db.transaction(['vectors'], 'readwrite');
        var store = tx.objectStore('vectors');
        entries.forEach(function(e) { store.put(e.vec, e.key); });
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { resolve(); };
      } catch(e) {
        resolve();
      }
    });
  });
}

// Stable key for a vector: endpoint|model + two 32-bit FNV-1a hashes +
// length. Collisions are astronomically unlikely, and the worst case is a
// wrong (but plausible) vector served from cache — same failure mode as any
// cache. Never serves a vector across models or endpoints.
function sugFnv(str, offset) {
  var h = offset >>> 0;
  for(var i = 0; i < str.length; ++i) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function sugTextKey(emb_key, text) {
  return emb_key + '|' + sugFnv(text, 0x811c9dc5).toString(16)
    + sugFnv(text, 0xdeadbeef).toString(16) + '_' + text.length;
}


/*
 * Interviewer/interviewee classification. Speaker turns (non-empty lines)
 * are labeled question or answer by a decision model, so suggestions can be
 * restricted to the answers. Both supported providers speak the same Jev
 * /v1/systemone wire protocol:
 *   - Laya, installed and served locally (`pip install "laya[serve]"`,
 *     `laya-serve`, http://localhost:8000)
 *   - Jev through OpenRouter (https://openrouter.ai/api/alpha/decisions,
 *     model ~typesafe/jev-latest)
 */

// The one question asked about every speaker turn
function sugQaQuestion() {
  return {
    speaker: {
      type: 'choice',
      instructions: 'In an interview transcript, is this block spoken by '
        + 'the interviewer or the interviewee? The block may start with a '
        + 'speaker label or timestamp prefix.',
      criteria: {
        interviewer: 'the interviewer asking, probing, prompting or reading '
          + 'out a question',
        interviewee: 'the interviewee answering, explaining or narrating '
          + 'their own experience',
      },
    },
  };
}

// Cache-isolation key: decisions from different servers/models never mix
function sugQaBase(cfg) {
  if(cfg.provider === 'laya') {
    return 'laya|' + (cfg.layaUrl || '');
  }
  return 'jev|' + (cfg.jevUrl || '') + '|' + (cfg.jevModel || '');
}

function sugQaConfigFromForm() {
  return {
    provider: document.getElementById('sug-qa-provider').value,
    layaUrl: document.getElementById('sug-qa-laya-url').value.trim(),
    jevKey: document.getElementById('sug-qa-jev-key').value,
    jevModel: document.getElementById('sug-qa-jev-model').value.trim(),
    jevUrl: document.getElementById('sug-qa-jev-url').value.trim(),
  };
}

function sugLoadQaConfig() {
  try {
    return JSON.parse(window.localStorage.getItem('taguette_suggest_qa') || 'null');
  } catch(e) {
    return null;
  }
}

function sugSaveQaConfig(cfg) {
  try {
    window.localStorage.setItem('taguette_suggest_qa', JSON.stringify(cfg));
  } catch(e) {
    /* private mode: config just won't persist */
  }
}

// Speaker turns as {start, end, text} blocks over plainText. Block
// boundaries: newlines inside text nodes (verbatim .txt) and block-level
// elements (<p>, <br>, <li>, ...) in rendered documents. Offsets index the
// same plainText the candidates use — nothing is inserted, so highlight
// byte offsets stay valid.
var SUG_BLOCK_TAGS = {P: 1, DIV: 1, BR: 1, LI: 1, UL: 1, OL: 1, H1: 1, H2: 1,
                      H3: 1, H4: 1, H5: 1, H6: 1, TR: 1, TABLE: 1,
                      BLOCKQUOTE: 1, PRE: 1, SECTION: 1, ARTICLE: 1};

// Trim shared by both block sources; drops whitespace-only blocks
function sugFinishBlock(blocks, plain, start, end) {
  while(start < end && /\s/.test(plain[start])) {
    ++start;
  }
  while(end > start && /\s/.test(plain[end - 1])) {
    --end;
  }
  if(end > start) {
    blocks.push({start: start, end: end, text: plain.slice(start, end)});
  }
}

// Transcript prefix line: a short speaker label / time reference on its
// own line ("Interviewer:", "John Smith [00:12:34]:", "[00:12:33]"), whose
// real content follows on the next line
var SUG_TS = '\\d{1,2}:\\d{2}(?::\\d{2})?(?:[.,]\\d{1,3})?';
function sugIsPrefixLine(text) {
  var t = text.trim();
  if(t.length === 0 || t.length > 80) {
    return false;
  }
  var last = t.charAt(t.length - 1);
  if(last === '.' || last === '!' || last === '?') {
    return false; // sentence line, not a label
  }
  if(last === ':') {
    return true; // "Interviewer:", "Dr. Silva [00:12]:" (internal dots ok)
  }
  if(new RegExp('^[\\[(]?' + SUG_TS + '[\\])]?$').test(t)) {
    return true; // the line is just a timestamp
  }
  var sep = '\\s*(?:-{1,2}>|[-\\u2013\\u2014])\\s*';
  if(new RegExp('^[\\[(]?' + SUG_TS + '[\\])]?' + sep + '[\\[(]?' + SUG_TS
      + '[\\])]?$').test(t)) {
    return true; // subtitle cue range ("00:00 --> 00:05", "00:00 - 00:05")
  }
  // Label with a bracketed timestamp and no colon: "RESPONDENT [00:20]",
  // "Maria Silva (12:34)" - kept tight (<= 4 words) so ordinary sentences
  // that merely mention a time ("we met at (10:30) once") never match
  if(t.split(/\s+/).length <= 4
      && new RegExp('[\\[(]\\s*' + SUG_TS + '\\s*[\\])]').test(t)) {
    return true;
  }
  return false;
}

// Fold prefix lines into the block that follows them. The merged block
// keeps contentStart pointing at the spoken text: classification sees the
// whole turn (label included), but the rectangle drawn in the transcript
// wraps only the spoken part.
function sugMergePrefixBlocks(blocks, plain) {
  var merged = [];
  var i = 0;
  while(i < blocks.length) {
    if(sugIsPrefixLine(blocks[i].text) && i + 1 < blocks.length) {
      var next = blocks[i + 1];
      merged.push({start: blocks[i].start, end: next.end,
                   contentStart: next.start,
                   text: plain.slice(blocks[i].start, next.end)});
      i += 2;
    } else {
      merged.push(blocks[i]);
      ++i;
    }
  }
  return merged;
}

// Line-based blocks for plain text (no DOM): one per non-empty line
function sugBlocksOfText(plain) {
  var blocks = [];
  var start = null;
  for(var i = 0; i <= plain.length; ++i) {
    if(i === plain.length || plain[i] === '\n') {
      if(start !== null) {
        sugFinishBlock(blocks, plain, start, i);
        start = null;
      }
    } else if(start === null) {
      start = i;
    }
  }
  return sugMergePrefixBlocks(blocks, plain);
}

// DOM-based blocks: walk the document chunks in order, break at
// block-level elements and newlines, mirror sugBuildPlainIndex's text
function sugBlocks() {
  var plain = sug_session.plainText;
  var blocks = [];
  var pos = 0;
  var cur = null; // start of the block being accumulated
  var close = function() {
    if(cur !== null) {
      sugFinishBlock(blocks, plain, cur, pos);
      cur = null;
    }
  };
  var visit = function(node) {
    if(node.nodeType === 3) { // text
      var data = node.data;
      var seg = '';
      for(var i = 0; i <= data.length; ++i) {
        if(i === data.length || data[i] === '\n') {
          if(seg !== '') {
            if(cur === null) {
              cur = pos;
            }
            pos += seg.length;
            seg = '';
          }
          if(i < data.length) {
            close(); // newline inside a text node is a hard boundary
            ++pos;   // the newline itself still occupies plainText
          }
        } else {
          seg += data[i];
        }
      }
      return;
    }
    if(node.nodeType !== 1) {
      return;
    }
    var block = !!SUG_BLOCK_TAGS[node.tagName];
    if(block) {
      close();
    }
    for(var c = node.firstChild; c; c = c.nextSibling) {
      visit(c);
    }
    if(block) {
      close();
    }
  };
  var root = document.getElementById('document-contents');
  var chunks = root.querySelectorAll('[id^="doc-offset-"]');
  for(var i = 0; i < chunks.length; ++i) {
    visit(chunks[i]);
  }
  close();
  return sugMergePrefixBlocks(blocks, plain);
}

// One turn -> Promise<{role: 'Q'|'A', prob}>. Memory, then IndexedDB, then a
// single systemone request; the result is cached in both layers.
function sugQaClassifyOne(text, cfg) {
  var key = sugTextKey(sugQaBase(cfg), text);
  if(SUG_QA_CACHE[key]) {
    return Promise.resolve(SUG_QA_CACHE[key]);
  }
  return sugIdbGetMany([key]).then(function(stored) {
    if(stored[key]) {
      SUG_QA_CACHE[key] = stored[key];
      return stored[key];
    }
    var url, headers = {'Content-Type': 'application/json'};
    var body = {state: text, questions: sugQaQuestion()};
    if(cfg.provider === 'laya') {
      url = (cfg.layaUrl || 'http://localhost:8000').replace(/\/+$/, '')
        + '/v1/systemone';
    } else {
      url = (cfg.jevUrl || 'https://openrouter.ai/api/alpha/decisions').replace(/\/+$/, '');
      headers['Authorization'] = 'Bearer ' + (cfg.jevKey || '');
      body.model = cfg.jevModel || '~typesafe/jev-latest';
    }
    return fetch(url, {method: 'POST', mode: 'cors', headers: headers,
                       body: JSON.stringify(body)})
      .then(function(resp) {
        if(resp.status != 200) {
          throw new Error('HTTP ' + resp.status);
        }
        return resp.json();
      })
      .then(function(json) {
        var ans = json && json.answers && json.answers.speaker;
        if(!ans || !ans.choice) {
          throw new Error('Unexpected response shape');
        }
        var prob = (typeof ans.answer_confidence === 'number')
          ? ans.answer_confidence
          : (ans.probabilities && ans.probabilities[ans.choice]) || 0;
        var r = {role: ans.choice === 'interviewer' ? 'Q' : 'A',
                 prob: Math.round(prob * 100) / 100};
        SUG_QA_CACHE[key] = r;
        sugIdbPutMany([{key: key, vec: r}]); // fire-and-forget persistence
        return r;
      });
  });
}

// All turns, a few requests at a time. on_done(i, role, prob) after each.
function sugQaClassifyAll(blocks, cfg, on_done) {
  var next = 0;
  function worker() {
    if(next >= blocks.length) {
      return Promise.resolve();
    }
    var i = next++;
    if(blocks[i].role) {
      return Promise.resolve().then(worker); // already classified/inherited
    }
    return sugQaClassifyOne(blocks[i].text, cfg)
      .then(function(r) {
        if(on_done) {
          on_done(i, r.role, r.prob);
        }
      })
      .then(worker);
  }
  var workers = [];
  for(var w = 0; w < Math.min(4, blocks.length); ++w) {
    workers.push(worker());
  }
  return Promise.all(workers);
}

// >half of [start, end) lies in a block labeled 'Q'
function sugIsQuestionSpan(start, end) {
  var blocks = sug_session && sug_session.roles ? sug_session.roles : null;
  if(!blocks) {
    return false;
  }
  var total = end - start;
  if(total <= 0) {
    return false;
  }
  var q = 0;
  for(var i = 0; i < blocks.length; ++i) {
    var b = blocks[i];
    if(b.role !== 'Q' || b.start >= end || b.end <= start) {
      continue;
    }
    q += Math.min(end, b.end) - Math.max(start, b.start);
    if(2 * q > total) {
      return true;
    }
  }
  return false;
}


/*
 * Scoring helpers
 */

function sugPercentiles(cands) {
  var sorted = cands.slice().sort(function(a, b) { return a.raw - b.raw; });
  var n = sorted.length;
  for(var i = 0; i < n; ++i) {
    sorted[i].lexPct = n > 1 ? i / (n - 1) : 1;
  }
  return cands;
}

function sugCutoff(pct) {
  var v = sug_session ? sug_session.aggressiveness : 50;
  // Full range: v=0 keeps only the single best candidate, v=100 keeps ~99%
  return 1.0 - 0.99 * (v / 100);
}

// Effective centrality used for cut-off and shading
function sugEffPct(cand) {
  if(sug_session && sug_session.useEmbeddings
     && typeof cand.embPct === 'number') {
    return (cand.lexPct + cand.embPct) / 2;
  }
  return cand.lexPct;
}

// Merge overlapping candidates (union span, max raw score); merely adjacent
// candidates are kept separate
function sugMergeOverlaps(cands) {
  cands.sort(function(a, b) { return a.start - b.start || b.end - a.end; });
  var out = [];
  for(var i = 0; i < cands.length; ++i) {
    var last = out.length ? out[out.length - 1] : null;
    if(last && cands[i].start < last.end) {
      last.end = Math.max(last.end, cands[i].end);
      last.raw = Math.max(last.raw, cands[i].raw);
      last.lexPct = Math.max(last.lexPct, cands[i].lexPct);
      if(typeof last.embPct === 'number' || typeof cands[i].embPct === 'number') {
        last.embPct = Math.max(last.embPct || 0, cands[i].embPct || 0);
      }
      last.cStart = Math.min(last.cStart, cands[i].cStart);
      last.cEnd = Math.max(last.cEnd, cands[i].cEnd);
    } else {
      out.push(cands[i]);
    }
  }
  return out;
}

function sugShade(pct) {
  var l = Math.round(92 - 32 * pct);
  return 'hsl(52, 100%, ' + l + '%)';
}


/*
 * Plain-text byte index
 */

// Builds plainText (JS string) and byteOfChar (cumulative UTF-8 byte offsets
// anchored at chunk offsets), matching describePos()'s offset space.
function sugBuildPlainIndex() {
  var root = document.getElementById('document-contents');
  var parts = [];
  var byteOfChar = [0];
  var nodes = root.querySelectorAll('[id^="doc-offset-"]');
  for(var i = 0; i < nodes.length; ++i) {
    var node = nodes[i];
    // Bases come from chunk_offsets (same DOM order) rather than the ids:
    // in-session transcript edits shift the virtual byte space, while the
    // ids keep the server's original anchors
    var base = chunk_offsets[i] || 0;
    var t = node.textContent;
    var b = 0;
    for(var j = 0; j < t.length;) {
      var cp = t.codePointAt(j);
      var width = cp > 0xFFFF ? 2 : 1;
      var ch = t.substr(j, width);
      parts.push(ch);
      b += lengthUTF8(ch);
      for(var k = 0; k < width; ++k) {
        byteOfChar.push(base + b);
      }
      j += width;
    }
  }
  return {
    plainText: parts.join(''),
    byteOfChar: byteOfChar,
    totalBytes: byteOfChar[byteOfChar.length - 1],
  };
}


/*
 * Embedding client (OpenAI-compatible /embeddings endpoint)
 */

function sugLoadConfig() {
  try {
    var cfg = JSON.parse(window.localStorage.getItem('taguette_suggest_config'));
    if(cfg && cfg.url) {
      return cfg;
    }
  } catch(e) { /* ignore */ }
  return null;
}

function sugSaveConfig(cfg) {
  window.localStorage.setItem('taguette_suggest_config', JSON.stringify(cfg));
}

// texts -> Promise<Array<vector>>. use_cache=false skips the persistent
// cache entirely (used by the config test button, which must actually hit
// the endpoint to prove the URL/token work)
function sugEmbed(texts, cfg, use_cache) {
  cfg = cfg || sugLoadConfig();
  if(!cfg || !cfg.url) {
    return Promise.reject(new Error('No embedding endpoint configured'));
  }
  var emb_key = sugEmbKey(cfg);
  var keys = texts.map(function(t) { return sugTextKey(emb_key, t); });
  var all = new Array(texts.length);
  var lookup = (use_cache === false) ? Promise.resolve({}) : sugIdbGetMany(keys);
  return lookup.then(function(stored) {
    // Take whatever IndexedDB (L2) already has; embed only the rest
    var missing_idx = [];
    for(var i = 0; i < texts.length; ++i) {
      if(stored[keys[i]]) {
        all[i] = stored[keys[i]];
      } else {
        missing_idx.push(i);
      }
    }
    var to_fetch = missing_idx.map(function(i) { return texts[i]; });
    var batches = [];
    for(i = 0; i < to_fetch.length; i += 32) {
      batches.push(to_fetch.slice(i, i + 32));
    }
    var headers = {'Content-Type': 'application/json'};
    if(cfg.token) {
      headers['Authorization'] = 'Bearer ' + cfg.token;
    }
    var new_entries = [];
    var fetched = 0; // running cursor into missing_idx
    var p = Promise.resolve();
    batches.forEach(function(batch) {
      p = p.then(function() {
        return fetch(cfg.url, {
          method: 'POST',
          mode: 'cors',
          headers: headers,
          body: JSON.stringify({model: cfg.model || '', input: batch}),
        }).then(function(response) {
          if(response.status != 200) {
            throw new Error('HTTP ' + response.status);
          }
          return response.json();
        }).then(function(json) {
          var data = json.data || json.embeddings;
          if(!data || data.length !== batch.length) {
            throw new Error('Unexpected response shape');
          }
          for(var i = 0; i < data.length; ++i) {
            var vec = data[i].embedding || data[i];
            if(!vec || !vec.length) {
              throw new Error('Unexpected response shape');
            }
            var idx = missing_idx[fetched + i];
            all[idx] = vec;
            new_entries.push({key: keys[idx],
                              vec: Float32Array.from(vec)});
          }
          fetched += batch.length;
        });
      });
    });
    return p.then(function() {
      // Persist the newly fetched vectors for next time (never blocks or
      // fails the call: sugIdbPutMany resolves even on storage errors)
      var save = (use_cache === false) ? Promise.resolve() : sugIdbPutMany(new_entries);
      return save.then(function() { return all; });
    });
  });
}

function sugCosine(a, b) {
  var dot = 0, na = 0, nb = 0;
  for(var i = 0; i < a.length && i < b.length; ++i) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if(na === 0 || nb === 0) {
    return 0;
  }
  return dot / Math.sqrt(na * nb);
}


/*
 * Theme clustering: cosine k-means over candidate embeddings. Instead of
 * global centrality (which bunches on the dominant topic), each cluster
 * contributes its most representative passages, so suggestions cover the
 * document's distinct themes.
 */

// Deterministic RNG (mulberry32), so re-clustering is stable
function sugRng(seed) {
  return function() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function sugNormalize(v) {
  var n = 0;
  for(var i = 0; i < v.length; ++i) {
    n += v[i] * v[i];
  }
  n = Math.sqrt(n);
  if(n === 0) {
    return v;
  }
  var out = new Array(v.length);
  for(i = 0; i < v.length; ++i) {
    out[i] = v[i] / n;
  }
  return out;
}

function sugDist2(a, b) {
  var s = 0;
  for(var i = 0; i < a.length; ++i) {
    var d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

// Deterministic cosine k-means (k-means++ init, <=25 iterations). Vectors
// must be normalized. Returns {assignments: int[], centroids: number[][]}.
function sugKMeans(vecs, k) {
  var n = vecs.length;
  if(n === 0 || k < 1) {
    return {assignments: [], centroids: []};
  }
  k = Math.min(k, n);
  var rng = sugRng(42);
  var centroids = [vecs[Math.floor(rng() * n)].slice()];
  var d2 = new Array(n);
  for(var c = 1; c < k; ++c) {
    var tot = 0;
    for(var i = 0; i < n; ++i) {
      var m = Infinity;
      for(var j = 0; j < centroids.length; ++j) {
        m = Math.min(m, sugDist2(vecs[i], centroids[j]));
      }
      d2[i] = m;
      tot += m;
    }
    if(tot <= 0) {
      break; // duplicate vectors exhausted the distinct seeds
    }
    var r = rng() * tot, acc = 0, pick = n - 1;
    for(i = 0; i < n; ++i) {
      acc += d2[i];
      if(acc >= r) {
        pick = i;
        break;
      }
    }
    centroids.push(vecs[pick].slice());
  }
  k = centroids.length;
  var assignments = new Array(n);
  for(i = 0; i < n; ++i) {
    assignments[i] = 0;
  }
  var dim = vecs[0].length;
  for(var it = 0; it < 25; ++it) {
    var changed = false;
    for(i = 0; i < n; ++i) {
      var best = 0, bd = Infinity;
      for(j = 0; j < k; ++j) {
        var d = sugDist2(vecs[i], centroids[j]);
        if(d < bd) {
          bd = d;
          best = j;
        }
      }
      if(assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }
    if(!changed && it > 0) {
      break;
    }
    // Recompute centroids (normalized means); reseed empty clusters
    var sums = [], cnts = [];
    for(j = 0; j < k; ++j) {
      var s = new Array(dim);
      for(var dd = 0; dd < dim; ++dd) {
        s[dd] = 0;
      }
      sums.push(s);
      cnts.push(0);
    }
    for(i = 0; i < n; ++i) {
      var a = assignments[i], sv = sums[a];
      cnts[a]++;
      for(dd = 0; dd < dim; ++dd) {
        sv[dd] += vecs[i][dd];
      }
    }
    for(j = 0; j < k; ++j) {
      if(cnts[j] === 0) {
        centroids[j] = vecs[Math.floor(rng() * n)].slice();
        continue;
      }
      var norm = 0;
      for(dd = 0; dd < dim; ++dd) {
        norm += sums[j][dd] * sums[j][dd];
      }
      norm = Math.sqrt(norm) || 1;
      for(dd = 0; dd < dim; ++dd) {
        centroids[j][dd] = sums[j][dd] / norm;
      }
    }
  }
  return {assignments: assignments, centroids: centroids};
}

// Number of themes from the aggressiveness slider: conservative = fewer,
// bigger themes; aggressive = more, finer ones
function sugClusterK(n) {
  var kmax = Math.max(2, Math.min(16, Math.floor(n / 2)));
  if(kmax < 2) {
    return 1;
  }
  var v = sug_session ? sug_session.aggressiveness : 50;
  return Math.max(1, Math.min(kmax, Math.round(2 + (v / 100) * (kmax - 2))));
}

// Suggestions kept per theme from the aggressiveness slider
function sugClusterPer() {
  var v = sug_session ? sug_session.aggressiveness : 50;
  return Math.min(4, 1 + Math.floor(v / 25));
}

// (Re-)cluster one pane's candidates by their embeddings and label the
// clusters (T1 = theme with the most representative passage)
function sugReclusterPane(pkey) {
  var pane = sug_session.panes[pkey];
  pane.clusterLabels = {};
  var clustered = [];
  (pane.candidates || []).forEach(function(c) {
    delete c.cluster;
    delete c.clSim;
    if(c._vec) {
      clustered.push(c);
    }
  });
  if(clustered.length < 3) {
    return; // too few vectors to cluster meaningfully
  }
  var vecs = clustered.map(function(c) { return sugNormalize(c._vec); });
  var result = sugKMeans(vecs, sugClusterK(clustered.length));
  var best = {};
  for(var i = 0; i < clustered.length; ++i) {
    var cl = result.assignments[i];
    clustered[i].cluster = cl;
    clustered[i].clSim = sugCosine(vecs[i], result.centroids[cl]);
    if(!(cl in best) || clustered[i].clSim > best[cl]) {
      best[cl] = clustered[i].clSim;
    }
  }
  var order = Object.keys(best).sort(function(a, b) { return best[b] - best[a]; });
  for(i = 0; i < order.length; ++i) {
    pane.clusterLabels[order[i]] = 'T' + (i + 1);
  }
}


/*
 * Session state
 */

var sug_session = null;

function sugPaneCount() {
  return sug_session.split ? 2 : 1;
}

function sugPaneKeys() {
  return sug_session.split ? ['', 'R'] : [''];
}

function sugSetStatus(msg) {
  document.getElementById('sug-status').textContent = msg || '';
}

function sugOtherAlgo(algo) {
  return algo === 'lexrank' ? 'yake' : 'lexrank';
}

// Cache/stash key for an algorithm's results: transcription mode changes the
// algorithm's behavior (filler filtering) and expansion changes YAKE/RAKE
// spans, so both are part of the key
function sugAlgoCacheKey(algo) {
  var k = algo;
  if(sug_session.transcription) {
    k += '|t';
  }
  if((algo === 'yake' || algo === 'rake') && sug_session.expand) {
    k += '|x';
  }
  return k;
}

// Compute (or load from cache) the lexical suggestions for one pane
function sugComputePane(pkey) {
  var pane = sug_session && sug_session.panes[pkey];
  if(!pane) {
    return; // pane may have disappeared while a computation was queued
  }
  var algo = SUG_ALGOS[pane.algo];
  var akey = sugAlgoCacheKey(pane.algo);
  var doc_cache = SUG_ALGO_CACHE[current_document];
  if(!doc_cache) {
    doc_cache = SUG_ALGO_CACHE[current_document] = {};
  }
  var gen = sug_session.editGen || 0;
  var done = function() {
    if(gen !== (sug_session ? sug_session.editGen : gen)) {
      return; // a transcript edit superseded this computation
    }
    // Restore the suggestions the user adjusted for this algorithm, if any
    if(pane.savedSuggestions && pane.savedSuggestions[akey]) {
      pane.suggestions = pane.savedSuggestions[akey];
    }
    sugRefilterPane(pkey);
    if(sug_session.useEmbeddings) {
      sugEnhanceEmbeddings();
    } else {
      sugSetStatus(sugStatusText());
    }
  };
  if(doc_cache[akey]) {
    // Cache hit: no recompute, embedding scores kept on the candidates
    pane.candidates = doc_cache[akey];
    done();
    return;
  }
  sugSetStatus(gettext('Running %(algo)s...', {algo: algo.label}));
  // setTimeout so the status actually paints
  window.setTimeout(function() {
    if(!sug_session || !sug_session.panes[pkey]) {
      return; // session ended while computing
    }
    var text = sug_session.plainText;
    var cands;
    try {
      cands = algo.run(text);
    } catch(error) {
      console.error('Suggestion algorithm failed:', error);
      sugSetStatus(gettext('Algorithm failed (see console)'));
      return;
    }
    if((pane.algo === 'yake' || pane.algo === 'rake') && sug_session.expand) {
      // Show the whole sentence/turn containing each keyphrase
      cands = sugExpandToSentences(cands, sug_session.sentences);
    }
    var boc = sug_session.byteOfChar;
    for(var i = 0; i < cands.length; ++i) {
      var cStart = Math.max(0, Math.min(cands[i].start, text.length));
      var cEnd = Math.max(cStart + 1, Math.min(cands[i].end, text.length));
      cands[i].cStart = cStart;
      cands[i].cEnd = cEnd;
      cands[i].start = boc[cStart];
      cands[i].end = boc[cEnd];
    }
    cands = cands.filter(function(c) { return c.end - c.start >= 3; });
    sugPercentiles(cands);
    pane.candidates = sugMergeOverlaps(cands);
    doc_cache[akey] = pane.candidates;
    done();
  }, 10);
}

function sugStatusText() {
  var n = 0, themes = 0;
  sugPaneKeys().forEach(function(k) {
    var seen = {};
    sug_session.panes[k].suggestions.forEach(function(s) {
      ++n;
      if(s.clusterLabel) {
        seen[s.clusterLabel] = true;
      }
    });
    themes += Object.keys(seen).length;
  });
  var answers_only = !!(sug_session.roles && sug_session.answersOnly);
  if(sug_session.rankMode === 'cluster' && themes > 0) {
    var t = gettext('%(n)s suggestion(s) in %(k)s theme(s)', {n: n, k: themes});
    return answers_only ? t + ' · ' + gettext('answers only') : t;
  }
  if(answers_only) {
    return gettext('%(n)s suggestion(s)', {n: n}) + ' · ' + gettext('answers only');
  }
  return gettext('%(n)s suggestion(s)', {n: n});
}

// Re-apply the slider cut-off (no recomputation) and re-render
function sugRefilter() {
  sugPaneKeys().forEach(sugRefilterPane);
  sugSetStatus(sugStatusText());
}

function sugRefilterPane(pkey) {
  var pane = sug_session.panes[pkey];
  var akey = sugAlgoCacheKey(pane.algo);
  // Keep this algorithm's suggestion state (including the user's edits) for
  // when they switch algorithms and back
  var stash = function() {
    pane.savedSuggestions = pane.savedSuggestions || {};
    pane.savedSuggestions[akey] = pane.suggestions;
  };
  if(!pane.candidates) {
    pane.suggestions = [];
    stash();
    sugRenderPane(pkey);
    return;
  }
  // Answers-only: drop candidates that mostly sit inside speaker turns
  // labeled as interviewer questions
  var cands = pane.candidates;
  if(sug_session.roles && sug_session.answersOnly) {
    cands = cands.filter(function(c) {
      return !sugIsQuestionSpan(c.cStart, c.cEnd);
    });
  }
  // Selection: either per-theme top-m (cluster mode with vectors), or the
  // percentile cut-off over effective centrality
  var entries; // [{c, sortPct, lexPct, embPct}]
  var groups = null;
  if(sug_session.rankMode === 'cluster'
     && pane.clusterLabels && Object.keys(pane.clusterLabels).length) {
    var per = sugClusterPer();
    groups = {};
    cands.forEach(function(c) {
      if(c.cluster === undefined) {
        return;
      }
      (groups[c.cluster] = groups[c.cluster] || []).push(c);
    });
    entries = [];
    for(var cl in groups) {
      // Most representative first; skip near-duplicates of already-picked
      // passages so a theme contributes distinct arguments, not rephrasings
      groups[cl].sort(function(a, b) { return (b.clSim || 0) - (a.clSim || 0); });
      var top = [];
      for(var ci = 0; ci < groups[cl].length && top.length < per; ++ci) {
        var cand = groups[cl][ci], dup = false;
        for(var pj = 0; pj < top.length; ++pj) {
          if(cand._vec && top[pj]._vec
             && sugCosine(cand._vec, top[pj]._vec) >= SUG_DUP_COS) {
            dup = true;
            break;
          }
        }
        if(!dup) {
          top.push(cand);
        }
      }
      var m = top.length;
      for(var i = 0; i < m; ++i) {
        // Within-theme percentile drives the shade of yellow
        var pct = m > 1 ? 1 - i / (m - 1) : 1;
        entries.push({c: top[i], sortPct: pct, lexPct: pct, embPct: null});
      }
    }
    entries.sort(function(a, b) { return a.c.start - b.c.start; });
  } else {
    var cutoff = sugCutoff();
    entries = cands
      .map(function(c) {
        return {c: c, sortPct: sugEffPct(c), lexPct: c.lexPct,
                embPct: (typeof c.embPct === 'number') ? c.embPct : null};
      })
      .filter(function(e) { return e.sortPct >= cutoff; });
    if(entries.length > 80) {
      entries.sort(function(a, b) { return b.sortPct - a.sortPct; });
      entries = entries.slice(0, 80);
    }
    entries.sort(function(a, b) { return a.c.start - b.c.start; });
  }
  // Preserve "modified" flags and ids of suggestions that are unchanged
  var old = {};
  pane.suggestions.forEach(function(s) { old[s.sid] = s; });
  pane.suggestions = entries.map(function(e) {
    var c = e.c;
    var label = (c.cluster !== undefined && pane.clusterLabels)
      ? (pane.clusterLabels[c.cluster] || null) : null;
    var s = null;
    for(var sid in old) {
      var o = old[sid];
      if(!o.mergedAway && o.origStart === c.start && o.origEnd === c.end) {
        s = o;
        delete old[sid];
        break;
      }
    }
    if(s) {
      // Refresh scores that may have changed (e.g. re-clustered themes)
      s.lexPct = e.lexPct;
      s.embPct = e.embPct;
      s.cluster = c.cluster;
      s.clusterLabel = label;
      return s;
    }
    return {
      sid: ++sug_session.nextSid,
      start: c.start,
      end: c.end,
      origStart: c.start,
      origEnd: c.end,
      cStart: c.cStart,
      cEnd: c.cEnd,
      lexPct: e.lexPct,
      embPct: e.embPct,
      cluster: c.cluster,
      clusterLabel: label,
      modified: false,
    };
  });
  stash();
  sugRenderPane(pkey);
}

// Optional embedding re-scoring: centrality = cosine to document centroid.
// Vectors are cached per text and per endpoint/model, so switching algorithms
// or restarting the session only embeds texts never seen before; switching
// back to an algorithm costs zero requests.
function sugEnhanceEmbeddings() {
  var cfg = sugLoadConfig();
  if(!cfg) {
    sug_session.useEmbeddings = false;
    sug_session.rankMode = 'lexical';
    var sel = document.getElementById('sug-mode');
    if(sel) {
      sel.value = 'lexical';
    }
    sugRefilter();
    return;
  }
  var emb_key = sugEmbKey(cfg);
  if(sug_session.embKey !== emb_key) {
    // Endpoint or model changed: drop the stale scores and vectors
    var doc_cache = SUG_ALGO_CACHE[current_document] || {};
    Object.keys(doc_cache).forEach(function(a) {
      doc_cache[a].forEach(function(c) {
        delete c.embPct;
        delete c._vec;
        delete c.cluster;
        delete c.clSim;
      });
    });
    sug_session.embKey = emb_key;
  }
  var emb_cache = SUG_EMB_CACHE[emb_key] || (SUG_EMB_CACHE[emb_key] = {});

  // All candidates across panes; percentiles are normalized over all of them
  // so the two split-screen panes stay comparable
  var all_c = [];
  sugPaneKeys().forEach(function(pkey) {
    (sug_session.panes[pkey].candidates || []).forEach(function(c) {
      all_c.push(c);
    });
  });
  var cand_texts = all_c.map(function(c) {
    return sug_session.plainText.substring(c.cStart, c.cEnd);
  });

  // Centroid from up to 200 sentences (their vectors are cached too, so this
  // is a network no-op after the first time)
  var cent_key = current_document + '|' + emb_key;
  var centroid = SUG_CENTROID_CACHE[cent_key];
  var cent_texts = [];
  if(!centroid) {
    var sentences = sug_session.sentences;
    var step = Math.max(1, Math.ceil(sentences.length / 200));
    for(var i = 0; i < sentences.length; i += step) {
      cent_texts.push(sentences[i].text);
    }
  }

  var missing = [];
  var add_missing = function(t) {
    if(!emb_cache[t] && missing.indexOf(t) === -1) {
      missing.push(t);
    }
  };
  cand_texts.forEach(add_missing);
  cent_texts.forEach(add_missing);

  var score = function() {
    if(!centroid) {
      var vecs = cent_texts.map(function(t) { return emb_cache[t]; });
      var dim = vecs[0].length;
      centroid = [];
      for(var d = 0; d < dim; ++d) {
        centroid.push(0);
      }
      vecs.forEach(function(v) {
        for(d = 0; d < v.length; ++d) {
          centroid[d] += v[d] / vecs.length;
        }
      });
      SUG_CENTROID_CACHE[cent_key] = centroid;
    }
    // Keep the vectors on the candidates for theme clustering, and the
    // document-centroid percentiles for the centrality blend
    var cents = [];
    for(var i = 0; i < cand_texts.length; ++i) {
      all_c[i]._vec = emb_cache[cand_texts[i]];
      cents.push(sugCosine(emb_cache[cand_texts[i]], centroid));
    }
    var idx = cents.map(function(c, i) { return i; })
      .sort(function(a, b) { return cents[a] - cents[b]; });
    var n = cents.length;
    idx.forEach(function(ci, rank) {
      all_c[ci].embPct = n > 1 ? rank / (n - 1) : 1;
    });
    if(sug_session.rankMode === 'cluster') {
      sugPaneKeys().forEach(sugReclusterPane);
    }
    sugRefilter();
  };

  if(missing.length === 0) {
    // Everything already embedded: score locally, no network
    score();
    return;
  }
  sugSetStatus(gettext('Embedding %(n)s text(s)...', {n: missing.length}));
  showSpinner();
  sugEmbed(missing, cfg)
  .then(function(embs) {
    for(var i = 0; i < missing.length; ++i) {
      emb_cache[missing[i]] = embs[i];
    }
    hideSpinner();
    score();
  })
  .catch(function(error) {
    hideSpinner();
    console.error('Embedding failed:', error);
    alert(gettext('Embedding request failed, staying with lexical scores.') + '\n\n' + error);
    sugSetStatus(sugStatusText());
  });
}


/*
 * Rendering
 */

function sugUnwrapClass(className) {
  var elements = document.getElementsByClassName(className);
  while(elements.length > 0) {
    var node = elements[0];
    while(node.firstChild) {
      node.parentNode.insertBefore(node.firstChild, node);
    }
    node.parentNode.removeChild(node);
  }
}

function sugWrapRange(prefix, startByte, endByte, mkElement) {
  var start = locatePos(startByte, prefix);
  if(!start || !start[0]) {
    return null;
  }
  start = splitAtPos(start, false);
  var end = locatePos(endByte, prefix);
  if(!end || !end[0]) {
    return null;
  }
  end = splitAtPos(end, true);
  var first = null, last = null;
  var node = start;
  while(node != end) {
    var next = nextElement(node);
    if(node.nodeType == 3 && node.textContent) { // TEXT_NODE
      var span = mkElement();
      node.parentNode.insertBefore(span, node);
      span.appendChild(node);
      if(first === null) {
        first = span;
      }
      last = span;
    }
    node = next;
    if(node === null) {
      break;
    }
  }
  return {first: first, last: last};
}

// Like sugWrapRange, but wraps the whole byte range in ONE element (a
// single borderable box). Returns null when the range partially contains
// an element (e.g. a suggestion crossing a block edge).
function sugWrapOne(prefix, startByte, endByte, mkElement) {
  var start = locatePos(startByte, prefix);
  if(!start || !start[0]) {
    return null;
  }
  start = splitAtPos(start, false);
  var end = locatePos(endByte, prefix);
  if(!end || !end[0]) {
    return null;
  }
  end = splitAtPos(end, true);
  try {
    var range = document.createRange();
    range.setStart(start, 0);
    if(end) {
      range.setEnd(end, 0);
    } else {
      // Block runs to the end of the document: end at the last node
      var n = start;
      while(true) {
        var nx = nextElement(n);
        if(!nx) {
          break;
        }
        n = nx;
      }
      range.setEnd(n, n.nodeType === 3 ? n.textContent.length
                                       : n.childNodes.length);
    }
    var span = mkElement();
    range.surroundContents(span);
    return span;
  } catch(error) {
    return null;
  }
}

function sugInsertBracket(prefix, byte, which, attrs) {
  var bracket = document.createElement('span');
  bracket.className = 'sug-bracket';
  bracket.setAttribute('data-which', which);
  for(var k in attrs) {
    bracket.setAttribute('data-' + k, attrs[k]);
  }
  var pos = locatePos(byte, prefix);
  var node = (pos && pos[0]) ? splitAtPos(pos, false) : null;
  if(node) {
    node.parentNode.insertBefore(bracket, node);
  } else {
    var root = prefix === 'R'
      ? document.getElementById('document-contents-b')
      : document.getElementById('document-contents');
    root.appendChild(bracket);
  }
  return bracket;
}

function sugRemoveSuggestionDom(sid) {
  sugUnwrapClass('sug-' + sid);
  var brackets = document.querySelectorAll(
    '.sug-bracket[data-sid="' + sid + '"]');
  for(var i = 0; i < brackets.length; ++i) {
    brackets[i].parentNode.removeChild(brackets[i]);
  }
}

// Render (or re-render) one pane's suggestion spans + brackets
function sugRenderPane(pkey) {
  var pane = sug_session.panes[pkey];
  // Clear this pane's previous rendering
  sugUnwrapClass('sug-span sug-p-' + pkey);
  var old_brackets = document.querySelectorAll(
    '.sug-bracket[data-pane="' + pkey + '"][data-sid]');
  for(var i = 0; i < old_brackets.length; ++i) {
    old_brackets[i].parentNode.removeChild(old_brackets[i]);
  }
  pane.suggestions.forEach(function(s) {
    var cls = 'sug-span sug-p-' + pkey + ' sug-' + s.sid;
    var bg = sugShade(sugEffPct(s));
    var wrapped = sugWrapRange(pkey, s.start, s.end, function() {
      var span = document.createElement('span');
      span.className = cls;
      span.setAttribute('data-sid', s.sid);
      span.setAttribute('data-pane', pkey);
      span.style.backgroundColor = bg;
      return span;
    });
    if(!wrapped) {
      console.error('Could not render suggestion', s.sid, s);
      return;
    }
    if(s.clusterLabel && wrapped.first) {
      // Theme badge: CSS-generated content, so text offsets stay intact
      wrapped.first.setAttribute('data-cluster-label', s.clusterLabel);
    }
    var attrs = {sid: s.sid, pane: pkey};
    if(s.modified) {
      attrs.modified = '1';
    }
    sugInsertBracket(pkey, s.start, 'start', attrs);
    sugInsertBracket(pkey, s.end, 'end', attrs);
  });
}

// Staged (accepted) highlights are rendered in every pane
function sugRenderStaged(st) {
  sugRemoveStagedDom(st.aid);
  sugPaneKeys().forEach(function(pkey) {
    sugWrapRange(pkey, st.start, st.end, function() {
      var span = document.createElement('a');
      span.className = 'highlight hl-staged hl-staged-' + st.aid;
      span.setAttribute('data-aid', st.aid);
      return span;
    });
    sugInsertBracket(pkey, st.start, 'start', {aid: st.aid, pane: pkey});
    sugInsertBracket(pkey, st.end, 'end', {aid: st.aid, pane: pkey});
  });
}

function sugRemoveStagedDom(aid) {
  sugUnwrapClass('hl-staged-' + aid);
  var brackets = document.querySelectorAll(
    '.sug-bracket[data-aid="' + aid + '"]');
  for(var i = 0; i < brackets.length; ++i) {
    brackets[i].parentNode.removeChild(brackets[i]);
  }
}


/*
 * Accept / discard / revert
 */

function sugFindSuggestion(sid) {
  var keys = sugPaneKeys();
  for(var i = 0; i < keys.length; ++i) {
    var pane = sug_session.panes[keys[i]];
    for(var j = 0; j < pane.suggestions.length; ++j) {
      if(pane.suggestions[j].sid === sid) {
        return {paneKey: keys[i], pane: pane, index: j, s: pane.suggestions[j]};
      }
    }
  }
  return null;
}

function sugAccept(sid) {
  var found = sugFindSuggestion(sid);
  if(!found) {
    return;
  }
  var s = found.s;
  var st = {
    aid: ++sug_session.nextAid,
    start: s.start,
    end: s.end,
    origStart: s.origStart,
    origEnd: s.origEnd,
    cStart: s.cStart,
    cEnd: s.cEnd,
    tags: [],
    algo: found.pane.algo,
    lexPct: s.lexPct,
    pkey: found.paneKey,
  };
  found.pane.suggestions.splice(found.index, 1);
  sugRemoveSuggestionDom(sid);
  sug_session.staged.push(st);
  sugRenderStaged(st);
  sugUpdateCounts();
  sugHideMenu();
}

function sugDiscard(sid) {
  var found = sugFindSuggestion(sid);
  if(!found) {
    return;
  }
  found.pane.suggestions.splice(found.index, 1);
  sugRemoveSuggestionDom(sid);
  sugUpdateCounts();
  sugHideMenu();
}

function sugRevertToAlgo(sid) {
  var found = sugFindSuggestion(sid);
  if(!found || !found.s.modified) {
    return;
  }
  var s = found.s;
  s.start = s.origStart;
  s.end = s.origEnd;
  s.modified = false;
  // Reverting may re-overlap neighbours; merge to keep the invariant
  sugMergeIntoNeighbors(found.paneKey, s);
  sugRenderPane(found.paneKey);
  sugHideMenu();
}

function sugUnaccept(aid) {
  var idx = -1, st = null;
  for(var i = 0; i < sug_session.staged.length; ++i) {
    if(sug_session.staged[i].aid === aid) {
      idx = i;
      st = sug_session.staged[i];
      break;
    }
  }
  if(idx < 0) {
    return;
  }
  sug_session.staged.splice(idx, 1);
  sugRemoveStagedDom(aid);
  // Restore as a suggestion in its original pane
  var pane = sug_session.panes[st.pkey];
  if(pane) {
    pane.suggestions.push({
      sid: ++sug_session.nextSid,
      start: st.start,
      end: st.end,
      origStart: st.origStart,
      origEnd: st.origEnd,
      cStart: st.cStart,
      cEnd: st.cEnd,
      lexPct: st.lexPct,
      embPct: null,
      modified: st.start !== st.origStart || st.end !== st.origEnd,
    });
    pane.suggestions.sort(function(a, b) { return a.start - b.start; });
    sugRenderPane(st.pkey);
  }
  sugUpdateCounts();
  sugHideMenu();
}

function sugUpdateCounts() {
  var el = document.getElementById('sug-stop-counts');
  if(el && sug_session) {
    el.textContent = gettext(
      '%(accepted)s accepted highlight(s), %(pending)s pending suggestion(s)',
      {accepted: sug_session.staged.length,
       pending: sugStatusCountPending()});
  }
}

function sugStatusCountPending() {
  var n = 0;
  sugPaneKeys().forEach(function(k) {
    n += sug_session.panes[k].suggestions.length;
  });
  return n;
}

// Merge suggestion `s` into any neighbours it overlaps (keeps the
// "no two suggestion brackets overlap" invariant within a pane). The union
// becomes the active span so chained overlaps collapse too.
function sugMergeIntoNeighbors(pkey, s) {
  var pane = sug_session.panes[pkey];
  for(;;) {
    var i, o;
    for(i = 0; i < pane.suggestions.length; ++i) {
      o = pane.suggestions[i];
      if(o.sid === s.sid) {
        continue;
      }
      if(s.start < o.end && o.start < s.end) {
        o.start = Math.min(o.start, s.start);
        o.end = Math.max(o.end, s.end);
        o.lexPct = Math.max(o.lexPct, s.lexPct);
        o.cStart = Math.min(o.cStart, s.cStart);
        o.cEnd = Math.max(o.cEnd, s.cEnd);
        o.modified = true;
        sugRemoveSuggestionDom(s.sid);
        pane.suggestions = pane.suggestions.filter(function(x) {
          return x.sid !== s.sid;
        });
        // Continue with the union
        s = o;
        break;
      }
    }
    if(i >= pane.suggestions.length) {
      break;
    }
  }
}


/*
 * Bracket dragging
 */

var sug_drag = null; // {sid, which, paneKey, s}

function sugCaretByte(clientX, clientY) {
  var range = null;
  if(document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(clientX, clientY);
  } else if(document.caretPositionFromPoint) {
    var p = document.caretPositionFromPoint(clientX, clientY);
    if(p) {
      range = document.createRange();
      range.setStart(p.offsetNode, p.offset);
      range.setEnd(p.offsetNode, p.offset);
    }
  }
  if(!range) {
    return null;
  }
  return describePos(range.startContainer, range.startOffset);
}

function sugOnBracketMouseDown(e) {
  var bracket = e.target.closest ? e.target.closest('.sug-bracket') : null;
  if(!bracket || !bracket.hasAttribute('data-sid')) {
    return; // staged brackets are fixed
  }
  var sid = parseInt(bracket.getAttribute('data-sid'));
  var found = sugFindSuggestion(sid);
  if(!found) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  sugHideMenu();
  sug_drag = {
    sid: sid,
    which: bracket.getAttribute('data-which'),
    paneKey: found.paneKey,
    s: found.s,
    lastRender: 0,
  };
  bracket.classList.add('sug-dragging');

  function onMove(e2) {
    var b = sugCaretByte(e2.clientX, e2.clientY);
    if(b === null) {
      return;
    }
    var s = sug_drag.s;
    var min_gap = 3;
    if(sug_drag.which === 'start') {
      var max = s.end - min_gap;
      // Do not cross an accepted highlight
      sug_session.staged.forEach(function(st) {
        if(st.start >= s.end) {
          max = Math.min(max, st.start);
        }
      });
      s.start = Math.max(0, Math.min(b, max));
    } else {
      var min = s.start + min_gap;
      var tmax = sug_session.totalBytes;
      sug_session.staged.forEach(function(st) {
        if(st.end <= s.start) {
          min = Math.max(min, st.end);
        }
      });
      s.end = Math.min(tmax, Math.max(b, min));
    }
    s.modified = s.modified || s.start !== s.origStart || s.end !== s.origEnd;
    var now = Date.now();
    if(now - sug_drag.lastRender > 150) {
      sug_drag.lastRender = now;
      sugRenderPane(sug_drag.paneKey);
      // Keep the dragged bracket hidden while the cursor is down
      var el = document.querySelector(
        '.sug-bracket[data-sid="' + sid + '"][data-which="' + sug_drag.which + '"]');
      if(el) {
        el.classList.add('sug-dragging');
      }
    }
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    var drag = sug_drag;
    sug_drag = null;
    if(!drag) {
      return;
    }
    // Dragging onto another suggestion merges the two
    sugMergeIntoNeighbors(drag.paneKey, drag.s);
    sugRenderPane(drag.paneKey);
    sugUpdateCounts();
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
}


/*
 * Context menus
 */

var sug_menu_timer = null;
var sug_menu_pinned = false;

function sugMenuEl() {
  return document.getElementById('sug-menu');
}

function sugHideMenu() {
  if(sug_menu_timer) {
    window.clearTimeout(sug_menu_timer);
    sug_menu_timer = null;
  }
  sug_menu_pinned = false;
  var menu = sugMenuEl();
  if(menu) {
    menu.style.display = 'none';
  }
}

function sugShowMenu(html, clientX, clientY, pinned) {
  var menu = sugMenuEl();
  menu.innerHTML = html;
  menu.style.display = 'block';
  // Keep the menu inside the viewport
  var x = Math.min(clientX, window.innerWidth - menu.offsetWidth - 12);
  var y = Math.min(clientY, window.innerHeight - menu.offsetHeight - 12);
  menu.style.left = Math.max(4, x) + 'px';
  menu.style.top = Math.max(4, y) + 'px';
  sug_menu_pinned = !!pinned;
}

function sugSuggestionMenuHtml(sid) {
  var found = sugFindSuggestion(sid);
  if(!found) {
    return '';
  }
  var s = found.s;
  var pct = Math.round(sugEffPct(s) * 100);
  var title = s.clusterLabel
    ? gettext('Suggested highlight — theme %(theme)s (%(pct)d%% representative)',
              {theme: s.clusterLabel, pct: pct})
    : gettext('Suggested highlight (%(pct)d%% central)', {pct: pct});
  var revert = s.modified
    ? '<button type="button" class="btn btn-sm btn-outline-secondary" id="sug-menu-revert">' + gettext('Revert to algorithm suggestion') + '</button>'
    : '<button type="button" class="btn btn-sm btn-outline-secondary" disabled>' + gettext('Revert to algorithm suggestion') + '</button>';
  var theme_ops = '';
  if(s.clusterLabel) {
    var same = found.pane.suggestions.filter(function(x) {
      return x.clusterLabel === s.clusterLabel;
    });
    if(same.length > 1) {
      theme_ops = '<br/>' +
        '<button type="button" class="btn btn-sm btn-primary" id="sug-menu-accept-theme">' +
        gettext('Accept all of %(theme)s (%(n)s)', {theme: s.clusterLabel, n: same.length}) + '</button> ' +
        '<button type="button" class="btn btn-sm btn-outline-danger" id="sug-menu-discard-theme">' +
        gettext('Discard theme %(theme)s', {theme: s.clusterLabel}) + '</button>';
    }
  }
  return (
    '<div class="sug-menu-title">' + title + '</div>' +
    '<button type="button" class="btn btn-sm btn-primary" id="sug-menu-accept">' + gettext('Save as highlight') + '</button> ' +
    revert + ' ' +
    '<button type="button" class="btn btn-sm btn-outline-danger" id="sug-menu-discard">' + gettext('Discard suggestion') + '</button>' +
    theme_ops
  );
}

function sugShowSuggestionMenu(sid, clientX, clientY, pinned) {
  var html = sugSuggestionMenuHtml(sid);
  if(!html) {
    return;
  }
  sugShowMenu(html, clientX, clientY, pinned);
  var found = sugFindSuggestion(sid);
  document.getElementById('sug-menu-accept').addEventListener(
    'click', function() { sugAccept(sid); });
  document.getElementById('sug-menu-discard').addEventListener(
    'click', function() { sugDiscard(sid); });
  if(found && found.s.modified) {
    document.getElementById('sug-menu-revert').addEventListener(
      'click', function() { sugRevertToAlgo(sid); });
  }
  // Theme bulk operations (cluster mode)
  var accept_theme = document.getElementById('sug-menu-accept-theme');
  if(accept_theme) {
    accept_theme.addEventListener('click', function() {
      sugThemeSids(sid).forEach(sugAccept);
      sugUpdateCounts();
    });
  }
  var discard_theme = document.getElementById('sug-menu-discard-theme');
  if(discard_theme) {
    discard_theme.addEventListener('click', function() {
      sugThemeSids(sid).forEach(sugDiscard);
      sugUpdateCounts();
    });
  }
}

// All suggestion ids sharing the clicked suggestion's theme (same pane)
function sugThemeSids(sid) {
  var found = sugFindSuggestion(sid);
  if(!found || !found.s.clusterLabel) {
    return [];
  }
  var label = found.s.clusterLabel;
  return found.pane.suggestions
    .filter(function(x) { return x.clusterLabel === label; })
    .map(function(x) { return x.sid; });
}

function sugStagedMenuHtml(aid) {
  var st = null;
  sug_session.staged.forEach(function(s) { if(s.aid === aid) { st = s; } });
  if(!st) {
    return '';
  }
  var tag_names = st.tags.map(function(id) {
    return tags['' + id] ? tags['' + id].path : id;
  });
  var html = (
    '<div class="sug-menu-title">' + gettext('Accepted highlight') + '</div>' +
    (tag_names.length
      ? '<div class="sug-menu-tags">' + escapeHtml(tag_names.join(', ')) + '</div>'
      : '') +
    '<button type="button" class="btn btn-sm btn-outline-secondary" id="sug-menu-unaccept">' + gettext('Revert to suggestion') + '</button> ' +
    '<button type="button" class="btn btn-sm btn-outline-primary" id="sug-menu-addtag">' + gettext('Add tag') + '</button>'
  );
  return html;
}

function sugShowStagedMenu(aid, clientX, clientY, pinned) {
  var html = sugStagedMenuHtml(aid);
  if(!html) {
    return;
  }
  sugShowMenu(html, clientX, clientY, pinned);
  document.getElementById('sug-menu-unaccept').addEventListener(
    'click', function() { sugUnaccept(aid); });
  document.getElementById('sug-menu-addtag').addEventListener(
    'click', function() { sugShowTagPicker(aid); });
}

function sugShowTagPicker(aid) {
  var entries = Object.entries(tags);
  sortByKey(entries, function(e) { return e[1].path; });
  var st = null;
  sug_session.staged.forEach(function(s) { if(s.aid === aid) { st = s; } });
  if(!st) {
    return;
  }
  var html = '<div class="sug-menu-title">' + gettext('Add tag') + '</div><div class="sug-menu-taglist">';
  entries.forEach(function(e) {
    var id = e[0];
    html += (
      '<label><input type="checkbox" value="' + id + '"' +
      (st.tags.indexOf(parseInt(id)) !== -1 ? ' checked' : '') + '> ' +
      escapeHtml(e[1].path) + '</label>'
    );
  });
  html += (
    '</div><button type="button" class="btn btn-sm btn-primary" id="sug-menu-tagapply">' +
    gettext('Apply') + '</button>'
  );
  // Position near the existing menu
  var menu = sugMenuEl();
  sugShowMenu(html, window.parseInt(menu.style.left) || 100,
              window.parseInt(menu.style.top) || 100, true);
  document.getElementById('sug-menu-tagapply').addEventListener('click', function() {
    var checked = [];
    var boxes = menu.querySelectorAll('.sug-menu-taglist input[type="checkbox"]');
    for(var i = 0; i < boxes.length; ++i) {
      if(boxes[i].checked) {
        checked.push(parseInt(boxes[i].value));
      }
    }
    var st2 = null;
    sug_session.staged.forEach(function(s) { if(s.aid === aid) { st2 = s; } });
    if(st2) {
      st2.tags = checked;
    }
    sugShowStagedMenu(aid,
                      window.parseInt(menu.style.left) || 100,
                      window.parseInt(menu.style.top) || 100, true);
  });
}

// Hover/click wiring (delegated, survives re-rendering)
function sugOnMouseOver(e) {
  var span = e.target.closest ? e.target.closest('.sug-span, .hl-staged') : null;
  if(!span || sug_drag) {
    return;
  }
  if(sug_menu_timer) {
    window.clearTimeout(sug_menu_timer);
  }
  sug_menu_timer = window.setTimeout(function() {
    if(sug_drag) {
      return;
    }
    if(span.classList.contains('hl-staged')) {
      sugShowStagedMenu(parseInt(span.getAttribute('data-aid')),
                        e.clientX + 8, e.clientY + 8, false);
    } else {
      sugShowSuggestionMenu(parseInt(span.getAttribute('data-sid')),
                            e.clientX + 8, e.clientY + 8, false);
    }
  }, 250);
}

function sugOnMouseOut(e) {
  var span = e.target.closest ? e.target.closest('.sug-span, .hl-staged') : null;
  if(span && !sug_menu_pinned) {
    var to = e.relatedTarget;
    if(to && to.closest && to.closest('#sug-menu')) {
      return; // moving into the menu keeps it open
    }
    if(sug_menu_timer) {
      window.clearTimeout(sug_menu_timer);
    }
    sug_menu_timer = window.setTimeout(function() {
      if(!sug_menu_pinned) {
        sugHideMenu();
      }
    }, 200);
  }
}




/*
 * Split screen
 */

function sugSetSplit(on) {
  if(!sug_session || on === sug_session.split) {
    return;
  }
  var view = document.getElementById('document-view');
  var contents = document.getElementById('document-contents');
  var paneB = document.getElementById('document-contents-b');
  // Clear all session rendering (real highlights are handled below)
  sugUnwrapClass('sug-span');
  sugUnwrapClass('hl-staged');
  sugUnwrapClass('sug-qa-block');
  var qa_badges = document.querySelectorAll('.sug-qa-badge');
  for(var qb = 0; qb < qa_badges.length; ++qb) {
    if(qa_badges[qb].parentNode) {
      qa_badges[qb].parentNode.removeChild(qa_badges[qb]);
    }
  }
  var brackets = document.querySelectorAll('.sug-bracket');
  for(var i = 0; i < brackets.length; ++i) {
    brackets[i].parentNode.removeChild(brackets[i]);
  }
  // Unwrap real highlights, rebuild pane B, re-render everything
  var ids = Object.keys(highlights);
  ids.forEach(removeHighlight);
  if(on) {
    if(!paneB) {
      paneB = document.createElement('div');
      paneB.id = 'document-contents-b';
      view.appendChild(paneB);
    }
    paneB.innerHTML = '';
    chunk_offsets_b = chunk_offsets.slice();
    var chunks = contents.querySelectorAll('[id^="doc-offset-"]');
    for(i = 0; i < chunks.length; ++i) {
      var clone = chunks[i].cloneNode(true);
      clone.id = 'doc-offset-R' + chunks[i].id.substring(11);
      paneB.appendChild(clone);
    }
    view.classList.add('split');
    if(!sug_session.panes['R']) {
      sug_session.panes['R'] = {algo: sugOtherAlgo(sug_session.panes[''].algo),
                                candidates: null, suggestions: [],
                                clusterLabels: {}};
      sugSyncAlgoSelects();
    }
  } else {
    if(paneB) {
      paneB.parentNode.removeChild(paneB);
    }
    chunk_offsets_b = [];
    view.classList.remove('split');
  }
  sug_session.split = on;
  // Real highlights wrap in every pane via highlightSelection
  ids.forEach(function(id) { setHighlight(highlights[id]); });
  sug_session.staged.forEach(sugRenderStaged);
  sugQaRenderBlocks();
  if(on) {
    sugComputePane('R');
  } else {
    delete sug_session.panes['R'];
    sugSyncAlgoSelects();
    sugRenderPane('');
  }
}




/*
 * Session lifecycle
 */

function sugStart() {
  if(!current_document) {
    alert(gettext('Load a document first.'));
    return;
  }
  if(sug_session && sug_session.active) {
    return;
  }
  var index = sugBuildPlainIndex();
  if(index.totalBytes < 50) {
    alert(gettext('This document is too short to suggest highlights.'));
    return;
  }
  var cfg = sugLoadConfig();
  var mode = 'lexical';
  if(cfg && cfg.tested) {
    var saved_mode = window.localStorage.getItem('taguette_suggest_mode');
    if(saved_mode === 'centroid' || saved_mode === 'cluster') {
      mode = saved_mode;
    }
  }
  var trans = sugDetectTranscription(index.plainText);
  SUG_TRANSCRIPTION = trans;
  sug_session = {
    active: true,
    split: false,
    aggressiveness: 50,
    transcription: trans,
    expand: trans, // keyphrases expand to whole sentences in transcriptions
    rankMode: mode,
    useEmbeddings: mode !== 'lexical',
    plainText: index.plainText,
    byteOfChar: index.byteOfChar,
    totalBytes: index.totalBytes,
    sentences: sugSplitSentences(index.plainText),
    panes: {'': {algo: 'textrank', candidates: null, suggestions: [],
                 clusterLabels: {}}},
    staged: [],
    nextSid: 0,
    nextAid: 0,
    roles: null,          // classified speaker turns: [{start, end, text, role, prob}]
    answersOnly: true,
    editGen: 0,           // bumped on every document edit; guards async work
  };
  document.getElementById('suggest-launch').style.display = 'none';
  document.getElementById('suggest-panel').style.display = '';
  document.getElementById('sug-split').checked = false;
  document.getElementById('sug-slider').value = '50';
  sugUpdateSliderFeedback();
  document.getElementById('sug-trans').checked = trans;
  document.getElementById('sug-expand').checked = trans;
  document.getElementById('sug-expand').disabled = false;
  document.getElementById('sug-mode').value = mode;
  sugSyncAlgoSelects();
  if(trans) {
    sugSetStatus(gettext('Transcription mode detected'));
  }
  sugComputePane('');
}

function sugCleanup() {
  if(!sug_session) {
    return;
  }
  sugHideMenu();
  var wasSplit = sug_session.split;
  // Empty the state before the split teardown re-renders anything
  sug_session.staged = [];
  sugPaneKeys().forEach(function(k) {
    sug_session.panes[k].suggestions = [];
  });
  sugUnwrapClass('sug-span');
  sugUnwrapClass('hl-staged');
  sugUnwrapClass('sug-qa-block');
  var brackets = document.querySelectorAll('.sug-bracket');
  for(var i = 0; i < brackets.length; ++i) {
    brackets[i].parentNode.removeChild(brackets[i]);
  }
  var qa_badges = document.querySelectorAll('.sug-qa-badge');
  for(var qb = 0; qb < qa_badges.length; ++qb) {
    if(qa_badges[qb].parentNode) {
      qa_badges[qb].parentNode.removeChild(qa_badges[qb]);
    }
  }
  if(wasSplit) {
    sugSetSplit(false);
  }
  sug_session = null;
  document.getElementById('suggest-panel').style.display = 'none';
  var launch = document.getElementById('suggest-launch');
  if(current_document) {
    launch.style.display = '';
  }
  sugSetStatus('');
}

// POST the staged highlights with the regular API, then clean up
function sugSaveStaged(done) {
  var staged = sug_session ? sug_session.staged.slice() : [];
  if(staged.length === 0) {
    done();
    return;
  }
  showSpinner();
  var p = Promise.resolve();
  staged.forEach(function(st) {
    p = p.then(function() {
      return postJSON(
        '/api/project/' + project_id + '/document/' + current_document + '/highlight/new',
        {start_offset: st.start, end_offset: st.end, tags: st.tags}
      );
    });
  });
  p.then(function() {
    hideSpinner();
    done();
  })
  .catch(function(error) {
    hideSpinner();
    console.error('Failed to save highlights:', error);
    alert(gettext("Couldn't create highlight!") + '\n\n' + error);
    done();
  });
}

// Stop dialog: 0 = dismissed, 1 = saved, 2 = discarded
function sugStopDialog(onDone) {
  sugUpdateCounts();
  var modal = document.getElementById('suggest-stop-modal');
  $(modal).modal({backdrop: 'static'}).on('hidden.bs.modal', function() {
    $(modal).off('hidden.bs.modal');
  });
  document.getElementById('sug-stop-save').onclick = function() {
    $(modal).one('hidden.bs.modal', function() { sugSaveStaged(onDone); });
    $(modal).modal('hide');
  };
  document.getElementById('sug-stop-discard').onclick = function() {
    var n = sug_session ? sug_session.staged.length : 0;
    if(!window.confirm(gettext(
        'Discard all suggestions and %(n)s unsaved accepted highlight(s)? This cannot be undone.',
        {n: n}))) {
      return;
    }
    $(modal).one('hidden.bs.modal', function() { sugCleanup(); onDone(); });
    $(modal).modal('hide');
  };
}

function sugStopButton() {
  if(!sug_session) {
    return;
  }
  sugStopDialog(function() { /* stay on the document */ });
}

// Session for another document/tag view: save or discard before navigating
function sugStopBeforeNavigate(next) {
  if(!sug_session || !sug_session.active) {
    return next();
  }
  sugStopDialog(function() { sugCleanup(); next(); });
}


/*
 * Q/A (interviewer vs interviewee) modal
 */

function sugOpenQa() {
  var cfg = sugLoadQaConfig() || {provider: 'laya', layaUrl: 'http://localhost:8000',
                                  jevKey: '', jevModel: '~typesafe/jev-latest',
                                  jevUrl: 'https://openrouter.ai/api/alpha/decisions'};
  document.getElementById('sug-qa-provider').value = cfg.provider || '';
  document.getElementById('sug-qa-laya-url').value = cfg.layaUrl || 'http://localhost:8000';
  document.getElementById('sug-qa-jev-key').value = cfg.jevKey || '';
  document.getElementById('sug-qa-jev-model').value = cfg.jevModel || '~typesafe/jev-latest';
  document.getElementById('sug-qa-jev-url').value = cfg.jevUrl || 'https://openrouter.ai/api/alpha/decisions';
  document.getElementById('sug-qa-test-result').textContent = '';
  document.getElementById('sug-qa-answers-only').checked =
    sug_session ? !!sug_session.answersOnly : true;
  sugQaSyncProvider();
  $(document.getElementById('suggest-qa-modal')).modal().drags({handle: '.modal-header'});
}

function sugQaSyncProvider() {
  var provider = document.getElementById('sug-qa-provider').value;
  document.getElementById('sug-qa-laya-group').style.display =
    provider === 'laya' ? '' : 'none';
  document.getElementById('sug-qa-jev-group').style.display =
    provider === 'jev' ? '' : 'none';
  document.getElementById('sug-qa-run').disabled = !provider;
  document.getElementById('sug-qa-test').disabled = !provider;
}

function sugQaTest() {
  var result = document.getElementById('sug-qa-test-result');
  var cfg = sugQaConfigFromForm();
  result.textContent = gettext('Testing...');
  var t0 = Date.now();
  sugQaClassifyOne('So, how did you first get involved in this?', cfg)
    .then(function() {
      result.textContent = gettext('OK (%(ms)s ms)', {ms: Date.now() - t0});
    })
    .catch(function(error) {
      result.textContent = gettext('Failed:') + ' ' + error
        + (cfg.provider === 'jev'
           ? ' — ' + gettext('check the OpenRouter token and model')
           : ' — ' + gettext('check that laya-serve is running') + ' (laya-serve)');
    });
}

// Classify every speaker turn with the configured decision model
function sugQaRun() {
  if(!sug_session) {
    return;
  }
  var cfg = sugQaConfigFromForm();
  if(!cfg.provider) {
    return;
  }
  sugSaveQaConfig(cfg);
  var blocks = sugBlocks();
  var summary = document.getElementById('sug-qa-summary');
  if(blocks.length < 2) {
    summary.textContent = gettext('No speaker turns found: put each speaker\'s text on its own line first.');
    sug_session.roles = null;
    sugQaRenderBlocks();
    sugRefilter();
    return;
  }
  var done = 0;
  blocks.forEach(function(b) { b.role = null; b.prob = null; });
  sug_session.roles = blocks; // role stays null until classified; null never filters
  summary.textContent = gettext('Classifying %(n)s speaker turn(s)...', {n: blocks.length});
  sugQaRenderBlocks();
  sugQaClassifyAll(blocks, cfg, function(i, role, prob) {
    blocks[i].role = role;
    blocks[i].prob = prob;
    ++done;
    sugQaSetBlockDom(i);
    summary.textContent = gettext('Classifying %(n)s speaker turn(s)... %(d)s done',
                                  {n: blocks.length, d: done});
  })
  .then(function() {
    sugQaSummaryText();
    sugRefilter();
  })
  .catch(function(error) {
    summary.textContent = gettext('Failed:') + ' ' + error;
  });
}

function sugQaSummaryText() {
  var summary = document.getElementById('sug-qa-summary');
  if(!sug_session || !sug_session.roles) {
    summary.textContent = '';
    return;
  }
  var q = 0;
  sug_session.roles.forEach(function(b) {
    if(b.role === 'Q') {
      ++q;
    }
  });
  summary.textContent = gettext('%(n)s speaker turn(s): %(q)s interviewer, %(a)s interviewee',
    {n: sug_session.roles.length, q: q,
     a: sug_session.roles.length - q});
}

// Render the classified turns in the document itself: a light-shaded span
// per block plus a Q/A badge beside the text. The badge carries no text
// content (CSS paints it), so plainText offsets are never polluted.
function sugQaRenderBlocks() {
  sugUnwrapClass('sug-qa-block');
  var old = document.querySelectorAll('.sug-qa-badge');
  for(var i = 0; i < old.length; ++i) {
    if(old[i].parentNode) {
      old[i].parentNode.removeChild(old[i]);
    }
  }
  if(!sug_session || !sug_session.roles) {
    return;
  }
  var boc = sug_session.byteOfChar;
  sug_session.roles.forEach(function(b, i) {
    var mk = function() {
      var span = document.createElement('span');
      span.className = 'sug-qa-block';
      span.setAttribute('data-idx', i);
      span.setAttribute('data-role', b.role || '\u2026');
      span.title = b.role ? '' : gettext('Classifying...');
      return span;
    };
    var boxStart = (b.contentStart !== undefined) ? b.contentStart : b.start;
    var span = sugWrapOne('', boc[boxStart], boc[b.end], mk);
    if(!span) {
      // Range straddles an element edge (e.g. a suggestion crossing the
      // block): border the text fragments individually instead
      var wrapped = sugWrapRange('', boc[boxStart], boc[b.end], mk);
      span = wrapped && wrapped.first;
    }
    if(span) {
      var badge = document.createElement('i');
      badge.className = 'sug-qa-badge';
      badge.setAttribute('data-idx', i);
      badge.setAttribute('data-role', b.role || '\u2026');
      badge.title = gettext('Click to flip');
      span.parentNode.insertBefore(badge, span);
    }
  });
}

// Update one block's DOM (shading + badge) after its role changes
function sugQaSetBlockDom(i) {
  var role = sug_session.roles[i].role || '\u2026';
  var spans = document.querySelectorAll('.sug-qa-block[data-idx="' + i + '"]');
  for(var s = 0; s < spans.length; ++s) {
    spans[s].setAttribute('data-role', role);
  }
  var badges = document.querySelectorAll('.sug-qa-badge[data-idx="' + i + '"]');
  for(var b = 0; b < badges.length; ++b) {
    badges[b].setAttribute('data-role', role);
  }
}

// Fix a misclassification by hand; suggestions re-filter immediately
function sugFlipRole(i) {
  var b = sug_session.roles[i];
  if(!b || !b.role) {
    return;
  }
  b.role = b.role === 'Q' ? 'A' : 'Q';
  sugQaSetBlockDom(i);
  sugQaSummaryText();
  sugRefilter();
}

/*
 * Config screen
 */

function sugOpenConfig() {
  var cfg = sugLoadConfig() || {};
  document.getElementById('sug-cfg-url').value = cfg.url || 'https://openrouter.ai/api/v1/embeddings';
  document.getElementById('sug-cfg-token').value = cfg.token || '';
  document.getElementById('sug-cfg-model').value = cfg.model || '';
  document.getElementById('sug-cfg-test-result').textContent = '';
  $(document.getElementById('suggest-config-modal')).modal().drags({handle: '.modal-header'});
}

function sugSaveConfigFromForm() {
  var cfg = {
    url: document.getElementById('sug-cfg-url').value.trim(),
    token: document.getElementById('sug-cfg-token').value,
    model: document.getElementById('sug-cfg-model').value.trim(),
    tested: false,
  };
  var old = sugLoadConfig();
  if(old && old.url === cfg.url && old.token === cfg.token
     && old.model === cfg.model) {
    cfg.tested = old.tested;
  }
  sugSaveConfig(cfg);
  // Re-score with the (possibly new) endpoint/model; the embKey check inside
  // invalidates the old scores and only new texts get embedded
  if(sug_session && sug_session.useEmbeddings) {
    sugEnhanceEmbeddings();
  }
  $(document.getElementById('suggest-config-modal')).modal('hide');
}

function sugTestConfig() {
  var result = document.getElementById('sug-cfg-test-result');
  var cfg = {
    url: document.getElementById('sug-cfg-url').value.trim(),
    token: document.getElementById('sug-cfg-token').value,
    model: document.getElementById('sug-cfg-model').value.trim(),
    tested: false,
  };
  if(!cfg.url) {
    result.textContent = gettext('Enter an endpoint URL first.');
    return;
  }
  result.textContent = gettext('Testing...');
  var t0 = Date.now();
  sugEmbed(['test'], cfg, false)
  .then(function() {
    cfg.tested = true;
    sugSaveConfig(cfg);
    result.textContent = gettext('OK (%(ms)s ms)', {ms: Date.now() - t0});
  })
  .catch(function(error) {
    sugSaveConfig(cfg);
    result.textContent = gettext('Failed:') + ' ' + error +
      ' — ' + gettext('check the URL/token, and CORS (local Ollama needs OLLAMA_ORIGINS=*)');
  });
}


/*
 * Init
 */

function sugSyncAlgoSelects() {
  var b_wrap = document.getElementById('sug-algo-b-wrap');
  var split = document.getElementById('sug-split');
  if(sug_session) {
    document.getElementById('sug-algo-a').value = sug_session.panes[''].algo;
    b_wrap.style.display = sug_session.split ? '' : 'none';
    if(sug_session.panes['R']) {
      sug_session.panes['R'].clusterLabels = sug_session.panes['R'].clusterLabels || {};
      document.getElementById('sug-algo-b').value = sug_session.panes['R'].algo;
    }
    split.checked = sug_session.split;
  } else {
    b_wrap.style.display = 'none';
  }
}

var SUG_DUP_COS = 0.85; // within-theme near-duplicate threshold (cosine)
var SUG_SLIDER_TIMER = null;

// Live text next to the slider: what the current value actually controls
function sugUpdateSliderFeedback() {
  var el = document.getElementById('sug-slider-feedback');
  if(!el || !sug_session) {
    return;
  }
  var v = sug_session.aggressiveness;
  if(sug_session.rankMode === 'cluster') {
    var n = ((sug_session.panes[''] || {}).candidates || []).length;
    el.textContent = gettext('%(k)s themes × %(m)s each',
      {k: sugClusterK(n), m: sugClusterPer()});
  } else {
    el.textContent = v + '%';
  }
}

// Re-cluster (if needed) and re-filter after the slider settles. Debounced:
// k-means + a full pane re-render on every pixel would be janky.
function sugApplySlider() {
  if(SUG_SLIDER_TIMER) {
    clearTimeout(SUG_SLIDER_TIMER);
  }
  SUG_SLIDER_TIMER = setTimeout(function() {
    SUG_SLIDER_TIMER = null;
    if(!sug_session) {
      return;
    }
    if(sug_session.rankMode === 'cluster') {
      sugPaneKeys().forEach(sugReclusterPane);
    }
    sugRefilter();
  }, 250);
}

function sugInit() {
  var launch = document.getElementById('suggest-launch');
  if(!launch) {
    return; // not on the project page
  }

  launch.addEventListener('click', function(e) {
    e.preventDefault();
    sugStart();
  });

  document.getElementById('sug-algo-a').addEventListener('change', function(e) {
    if(!sug_session) {
      return;
    }
    sug_session.panes[''].algo = e.target.value;
    sugComputePane('');
  });
  document.getElementById('sug-algo-b').addEventListener('change', function(e) {
    if(!sug_session || !sug_session.panes['R']) {
      return;
    }
    sug_session.panes['R'].algo = e.target.value;
    sugComputePane('R');
  });
  document.getElementById('sug-split').addEventListener('change', function(e) {
    sugSetSplit(e.target.checked);
  });
  document.getElementById('sug-slider').addEventListener('input', function(e) {
    if(!sug_session) {
      return;
    }
    sug_session.aggressiveness = parseInt(e.target.value);
    sugUpdateSliderFeedback();
    sugApplySlider();
  });
  document.getElementById('sug-slider').addEventListener('change', function() {
    // Mouse released: apply now instead of waiting out the debounce
    if(SUG_SLIDER_TIMER) {
      clearTimeout(SUG_SLIDER_TIMER);
      SUG_SLIDER_TIMER = null;
      if(sug_session) {
        if(sug_session.rankMode === 'cluster') {
          sugPaneKeys().forEach(sugReclusterPane);
        }
        sugRefilter();
      }
    }
  });
  document.getElementById('sug-trans').addEventListener('change', function(e) {
    if(!sug_session) {
      return;
    }
    sug_session.transcription = e.target.checked;
    SUG_TRANSCRIPTION = e.target.checked;
    sugComputePane('');
    if(sug_session.split) {
      sugComputePane('R');
    }
  });
  document.getElementById('sug-expand').addEventListener('change', function(e) {
    if(!sug_session) {
      return;
    }
    sug_session.expand = e.target.checked;
    sugComputePane('');
    if(sug_session.split) {
      sugComputePane('R');
    }
  });
  document.getElementById('sug-mode').addEventListener('change', function(e) {
    if(!sug_session) {
      return;
    }
    var mode = e.target.value;
    if(mode !== 'lexical' && !sugLoadConfig()) {
      e.target.value = sug_session.rankMode;
      sugOpenConfig();
      return;
    }
    sug_session.rankMode = mode;
    sug_session.useEmbeddings = mode !== 'lexical';
    window.localStorage.setItem('taguette_suggest_mode', mode);
    sugUpdateSliderFeedback();
    if(mode === 'lexical') {
      sugRefilter();
    } else {
      sugEnhanceEmbeddings();
    }
  });
  document.getElementById('sug-config-btn').addEventListener('click', function(e) {
    e.preventDefault();
    sugOpenConfig();
  });
  document.getElementById('sug-qa-btn').addEventListener('click', function(e) {
    e.preventDefault();
    sugOpenQa();
  });
  // Badge clicks are delegated: badges are re-created on every re-render
  document.addEventListener('click', function(e) {
    var badge = e.target && e.target.closest ? e.target.closest('.sug-qa-badge') : null;
    if(badge && sug_session && sug_session.roles) {
      e.preventDefault();
      sugFlipRole(parseInt(badge.getAttribute('data-idx'), 10));
    }
  });
  document.getElementById('sug-qa-provider').addEventListener('change', sugQaSyncProvider);
  document.getElementById('sug-qa-test').addEventListener('click', function(e) {
    e.preventDefault();
    sugQaTest();
  });
  document.getElementById('sug-qa-save').addEventListener('click', function(e) {
    e.preventDefault();
    sugSaveQaConfig(sugQaConfigFromForm());
    $(document.getElementById('suggest-qa-modal')).modal('hide');
  });
  document.getElementById('sug-qa-run').addEventListener('click', function(e) {
    e.preventDefault();
    sugQaRun();
  });
  document.getElementById('sug-qa-answers-only').addEventListener('change', function(e) {
    if(!sug_session) {
      return;
    }
    sug_session.answersOnly = e.target.checked;
    sugRefilter();
  });
  document.getElementById('sug-stop').addEventListener('click', function(e) {
    e.preventDefault();
    sugStopButton();
  });

  // Config modal
  document.getElementById('sug-cfg-save').addEventListener('click', function(e) {
    e.preventDefault();
    sugSaveConfigFromForm();
  });
  document.getElementById('sug-cfg-test').addEventListener('click', function(e) {
    e.preventDefault();
    sugTestConfig();
  });

  // Delegated events over re-rendered spans and brackets
  document.addEventListener('mousedown', sugOnBracketMouseDown, true);
  document.addEventListener('mouseover', sugOnMouseOver);
  document.addEventListener('mouseout', sugOnMouseOut);
  document.addEventListener('click', function(e) {
    var span = e.target.closest ? e.target.closest('.sug-span, .hl-staged') : null;
    if(span) {
      e.preventDefault();
      if(span.classList.contains('hl-staged')) {
        sugShowStagedMenu(parseInt(span.getAttribute('data-aid')),
                          e.clientX + 8, e.clientY + 8, true);
      } else {
        sugShowSuggestionMenu(parseInt(span.getAttribute('data-sid')),
                              e.clientX + 8, e.clientY + 8, true);
      }
      return;
    }
    // Dismiss a pinned menu on any click outside the session UI
    if(sug_menu_pinned) {
      var t = e.target;
      if(!(t.closest && (t.closest('#sug-menu')
                         || t.closest('.sug-span') || t.closest('.hl-staged')))) {
        sugHideMenu();
      }
    }
  });
  document.addEventListener('keydown', function(e) {
    if(e.key === 'Escape') {
      sugHideMenu();
    }
  });
}

if(window.addEventListener) {
  window.addEventListener('load', sugInit);
}

// End or pause the session when navigating to another document / tag view.
// Wrapped at parse time (before taguette.js's setTimeout(0) auto-load) so the
// initial URL-opened document also goes through it.
(function() {
  if(typeof loadDocument !== 'function') {
    return;
  }
  var origLoadDocument = loadDocument;
  window.loadDocument = function(document_id, keep_scroll) {
    var go = function() {
      var p = origLoadDocument(document_id, keep_scroll);
      var launch = document.getElementById('suggest-launch');
      if(launch) {
        launch.style.display = document_id === null ? 'none' : '';
      }
      return p;
    };
    if(sug_session && document_id === current_document) {
      return go(); // same-document refresh (e.g. after a transcript edit)
    }
    return sugStopBeforeNavigate(go);
  };
  var origLoadTag = loadTag;
  window.loadTag = function(tag_path, page) {
    sugStopBeforeNavigate(function() {
      origLoadTag(tag_path, page);
      var launch = document.getElementById('suggest-launch');
      if(launch) {
        launch.style.display = 'none';
      }
    });
  };
})();


/*
 * Self-test: append ?suggest_selftest=1 to the project URL to run it.
 */

function sugSelfTest() {
  var failures = 0;
  function assert(cond, msg) {
    if(!cond) {
      console.error('SELFTEST FAIL:', msg);
      ++failures;
    }
  }
  var text = 'The cat sat on the mat. The cat was happy! ' +
             'Dogs and cats fought over the mat, and the dog was grumpy. ' +
             'Finally, everyone slept in the sun.';
  var sents = sugSplitSentences(text);
  assert(sents.length >= 3, 'sentence splitting finds >= 3 sentences');
  assert(sents[0].text.indexOf('cat') !== -1, 'first sentence keeps text');

  var toks = sugTokenize(text);
  assert(toks.length > 10, 'tokenizer finds tokens');
  assert(toks[0].start === 0 && toks[0].word === 'the', 'tokenizer offsets');

  ['textrank', 'lexrank', 'yake', 'rake'].forEach(function(algo) {
    var out = SUG_ALGOS[algo].run(text);
    assert(out.length > 0, algo + ' returns candidates');
    var ok = true;
    out.forEach(function(c) {
      if(!(c.start >= 0 && c.end > c.start && c.end <= text.length)) {
        ok = false;
      }
    });
    assert(ok, algo + ' spans are in bounds');
  });

  // Merge on overlap
  var merged = sugMergeOverlaps([
    {start: 0, end: 10, raw: 1, lexPct: 0.2, cStart: 0, cEnd: 10},
    {start: 5, end: 20, raw: 2, lexPct: 0.9, cStart: 5, cEnd: 20},
    {start: 30, end: 40, raw: 0.5, lexPct: 0.4, cStart: 30, cEnd: 40},
  ]);
  assert(merged.length === 2, 'overlap merge unions spans');
  assert(merged[0].start === 0 && merged[0].end === 20, 'merged span bounds');
  assert(merged[0].raw === 2, 'merged keeps max score');

  // Newlines are sentence boundaries (speaker turns)
  var turns = sugSplitSentences('One turn here.\nAnother turn without a period\nThird one.');
  assert(turns.length === 3, 'newline-split turns, got ' + turns.length);
  assert(turns[1].text.indexOf('Another turn') === 0, 'turn spans keep text');

  // Long unpunctuated runs are capped
  var long_line = '';
  for(i = 0; i < 100; ++i) {
    long_line += (i > 0 ? ' ' : '') + 'word' + i;
  }
  var capped = sugSplitSentences(long_line);
  assert(capped.length >= 2, 'long run capped into chunks, got ' + capped.length);
  var max_words = 0;
  capped.forEach(function(s) {
    max_words = Math.max(max_words, sugTokenize(s.text).length);
  });
  assert(max_words <= SUG_MAX_SENTENCE_WORDS, 'capped chunks respect the word limit');

  // Transcription mode: fillers + backchannels
  var saved_trans = SUG_TRANSCRIPTION;
  SUG_TRANSCRIPTION = false;
  assert(!sugIsStop('think'), '"think" is content in prose mode');
  SUG_TRANSCRIPTION = true;
  assert(sugIsStop('think'), '"think" is a filler in transcription mode');
  assert(sugIsBackchannel({text: 'Yeah.'}), 'backchannel detected');
  assert(sugIsBackchannel({text: 'I think so'}), 'thin hedge detected');
  assert(!sugIsBackchannel({text: 'The housing policy failed completely'}),
         'substantive sentence kept');
  var ranked = sugRankableSentences('Yeah. Right. The housing policy failed completely.');
  assert(ranked.length === 1, 'backchannels dropped from ranking, got ' + ranked.length);
  SUG_TRANSCRIPTION = saved_trans;

  assert(sugDetectTranscription('word word word word word word word word word'),
         'unpunctuated text detected as transcription');
  assert(!sugDetectTranscription(text), 'prose not detected as transcription');

  // Keyphrase expansion to the containing sentence
  var sentence_list = sugSplitSentences(text);
  var phrase = {start: sentence_list[0].start + 4, end: sentence_list[0].start + 7};
  sugExpandToSentences([phrase], sentence_list);
  assert(phrase.start === sentence_list[0].start
         && phrase.end === sentence_list[0].end,
         'keyphrase expanded to sentence');

  // k-means separates two well-separated groups (directions matter after
  // normalization: one group near the x-axis, one near the y-axis)
  var vecs = [[1, 0.02], [0.98, -0.01], [1.01, 0], [0.99, 0.03],
              [0.02, 1], [-0.01, 0.98], [0, 1.01], [0.03, 0.99]];
  var km = sugKMeans(vecs.map(sugNormalize), 2);
  var g0 = km.assignments[0], split_ok = true;
  for(i = 0; i < 8; ++i) {
    if((km.assignments[i] === g0) !== (i < 4)) {
      split_ok = false;
    }
  }
  assert(km.assignments.length === 8, 'kmeans assigns every vector');
  assert(split_ok, 'kmeans separates the two groups');
  var norm = sugNormalize([3, 4]);
  assert(Math.abs(norm[0] - 0.6) < 1e-9 && Math.abs(norm[1] - 0.8) < 1e-9,
         'normalize works');

  // Cluster k grows with the slider, capped
  sug_session = {aggressiveness: 0};
  var k_min = sugClusterK(60);
  sug_session = {aggressiveness: 100};
  var k_max = sugClusterK(60);
  assert(k_max >= k_min && k_max <= 16, 'cluster k monotonic and capped');
  sug_session = {aggressiveness: 100};
  assert(sugClusterPer() === 4, 'per-theme keep grows to 4');
  sug_session = {aggressiveness: 10};
  assert(sugClusterPer() === 1, 'conservative keeps 1 per theme');
  sug_session = saved;

  // Persistent vector cache keys: deterministic, model- and text-sensitive
  assert(sugTextKey('http://x|m1', 'hello') === sugTextKey('http://x|m1', 'hello'),
         'text key deterministic');
  assert(sugTextKey('http://x|m1', 'hello') !== sugTextKey('http://x|m2', 'hello'),
         'text key differs per model');
  assert(sugTextKey('http://x|m1', 'hello') !== sugTextKey('http://x|m1', 'hellO'),
         'text key differs per text');
  assert(sugTextKey('http://x|m1', 'a').length > 'http://x|m1|'.length,
         'text key includes hashes');

  // Speaker-role classification helpers
  var qa_plain = 'Q: how did it start?\n\nA: well we noticed the floods in 2019 and the city did nothing\nQ: and then what happened?\nA: so we organized the neighborhood committee ourselves';
  var qa_blocks = sugBlocksOfText(qa_plain);
  assert(qa_blocks.length === 4, 'one block per non-empty line');
  assert(qa_plain.slice(qa_blocks[1].start, qa_blocks[1].end)
         === 'A: well we noticed the floods in 2019 and the city did nothing',
         'block offsets point at trimmed text');

  // Prefix lines (speaker label / timestamp) merge into the next block
  var pre = sugBlocksOfText('Interviewer:\nCan you tell me about the flood?\n'
    + 'Respondent:\nIt destroyed our ground floor');
  assert(pre.length === 2, 'prefix lines merge forward: ' + pre.length);
  assert(pre[0].text === 'Interviewer:\nCan you tell me about the flood?',
         'merged block keeps prefix text');
  assert(pre[0].start === 0, 'merged block starts at the prefix');
  assert(pre[0].contentStart === 13, 'contentStart points at spoken text');
  assert(sugBlocksOfText('We met at 10:30\nand talked for hours').length === 2,
         'plain sentence with a time is not a prefix');
  assert(sugBlocksOfText('RESPONDENT [00:20]\nThe water rose fast').length === 1,
         'label with timestamp and no colon is a prefix');
  assert(sugIsPrefixLine('RESPONDENT [00:20]'), 'label + bracketed timestamp');
  assert(sugIsPrefixLine('Maria Silva (12:34)'), 'name + parenthesized time');
  assert(sugIsPrefixLine('Dr. Silva:'), 'name with an internal dot');
  assert(sugIsPrefixLine('00:00 --> 00:05'), 'subtitle cue range');
  assert(!sugIsPrefixLine('He said (12:30) was too late'),
         'long sentence mentioning a time is not a prefix');
  assert(sugIsPrefixLine('[00:12:33]'), 'bare timestamp is a prefix');
  assert(sugIsPrefixLine('JOÃO SILVA [00:12]:'), 'label with timestamp is a prefix');
  assert(!sugIsPrefixLine('The water rose fast that year.'), 'sentence is not a prefix');
  assert(!sugIsPrefixLine('Well the drains failed, obviously'),
         'colon-free line is not a prefix');
  var saved_roles = sug_session;
  sug_session = {roles: [qa_blocks[0], qa_blocks[1]]};
  qa_blocks[0].role = 'Q';
  qa_blocks[1].role = 'A';
  assert(sugIsQuestionSpan(0, 10), 'span inside Q block is a question');
  assert(!sugIsQuestionSpan(qa_blocks[1].start, qa_blocks[1].end),
         'span inside A block is not');
  assert(sugIsQuestionSpan(0, qa_blocks[1].start + 1),
         'majority-overlap span counts as question');
  assert(!sugIsQuestionSpan(0, qa_blocks[1].end),
         'minority-overlap span does not');
  sug_session = null;
  assert(!sugIsQuestionSpan(0, 10), 'no roles means no filtering');
  sug_session = saved_roles;
  var qq = sugQaQuestion();
  assert(qq.speaker.type === 'choice' && qq.speaker.criteria.interviewer
         && qq.speaker.criteria.interviewee, 'systemone choice question shape');
  assert(sugQaBase({provider: 'laya', layaUrl: 'http://x'})
         !== sugQaBase({provider: 'jev', jevModel: 'm'}),
         'qa cache keys differ per provider');

  // Percentile + cut-off
  var cands = [{raw: 1}, {raw: 2}, {raw: 3}];
  sugPercentiles(cands);
  assert(cands[2].lexPct === 1, 'percentile top');

  var fake_session = {aggressiveness: 100};
  var saved = sug_session;
  sug_session = fake_session;
  assert(sugCutoff() < 0.1, 'aggressive slider lowers cut-off');
  sug_session = {aggressiveness: 0};
  assert(sugCutoff() > 0.9, 'conservative slider raises cut-off');
  sug_session = saved;

  console.log(failures === 0
    ? 'SELFTEST OK'
    : 'SELFTEST: ' + failures + ' failure(s)');
  return failures;
}

if(typeof window !== 'undefined' && window.location
   && window.location.search.indexOf('suggest_selftest=1') !== -1) {
  window.addEventListener('load', sugSelfTest);
}
