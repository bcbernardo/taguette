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

// Inline speaker label opening a line: "NAME:", "NAME [00:12]:",
// "[00:12] NAME:" — the label before the colon. Lines whose whole text is
// just such a label are prefix lines (sugIsPrefixLine); this also matches
// label + spoken text on one line ("John: hello there").
function sugInlineLabel(line) {
  var m = new RegExp('^\\s*(?:[\\[]\\s*' + SUG_TS + '\\s*[\\]])?\\s*'
    + '([^\\n:()[\\]]{1,40}?)\\s*(?:[\\[]\\s*' + SUG_TS
    + '\\s*[\\]])?\\s*:').exec(line);
  if(!m) {
    return null;
  }
  var lab = (m[1] || '').trim();
  return (lab && /[A-Za-z\u00c0-\u024f\u0370-\u1fff_]/.test(lab)) ? lab : null;
}

// Any speaker label a line carries, including the standalone forms
// ("NAME [00:20]", "[00:12] NAME") that only appear on lines of their own.
// Permissive — it feeds the pre-scan hint, never a decision on its own.
function sugPrefixLabel(line) {
  var lab = sugInlineLabel(line);
  if(lab) {
    return lab;
  }
  var patterns = [
    new RegExp('^\\s*([^\\n:()[\\]]{1,40}?)\\s*[\\[(]\\s*' + SUG_TS
      + '\\s*[\\])]\\s*$'),
    new RegExp('^\\s*[\\[]\\s*' + SUG_TS + '\\s*[\\]]\\s+'
      + '([^\\n:()[\\]]{1,40}?)(\\s*[\\[]' + SUG_TS + '[\\]])?\\s*:?\\s*$'),
  ];
  for(var p = 0; p < patterns.length; ++p) {
    var m = patterns[p].exec(line);
    if(m && m[1]) {
      var lab2 = m[1].trim();
      if(lab2 && /[A-Za-z\u00c0-\u024f\u0370-\u1fff_]/.test(lab2)) {
        return lab2;
      }
    }
  }
  return null;
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

// Absorb continuation paragraphs into the open speaker turn: a turn
// starts at a prefix line (speaker/timestamp label on its own line) or at
// a line beginning with a speaker label ("John: …"), and runs until the
// next turn start — the common transcript layout where one label opens
// several paragraphs. Text before the first label stays standalone.
// Offsets index the same plainText, so highlight byte offsets stay valid.
function sugAbsorbContinuations(blocks, plain) {
  var turns = [];
  var open = null;
  blocks.forEach(function(b) {
    var starts = (b.contentStart !== undefined)
      || sugIsPrefixLine(b.text)
      || (!!sugInlineLabel(b.text.split('\n', 1)[0]));
    if(starts || !open) {
      turns.push({start: b.start, end: b.end,
                  contentStart: (b.contentStart !== undefined)
                    ? b.contentStart : b.start,
                  text: plain.slice(b.start, b.end)});
      open = turns[turns.length - 1];
    } else {
      open.end = b.end;
      open.text = plain.slice(open.start, open.end);
    }
  });
  return turns;
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

// Speaker turns over plain text (blocks + prefix folding + absorption)
function sugTurnsOfText(plain) {
  return sugAbsorbContinuations(sugBlocksOfText(plain), plain);
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

// The session's speaker turns over the loaded document (same block walk,
// plus continuation absorption — see sugAbsorbContinuations)
function sugSpeakerTurns() {
  return sugAbsorbContinuations(sugBlocks(), sug_session.plainText);
}

/*
 * Speaker segmentation
 *
 * Who speaks in each turn, for any number of speakers. A chat model (the
 * 'segmentation' task of the configuration screen) receives random
 * excerpts of the document and proposes, in ONE call, the speakers it
 * recognizes as label patterns; the patterns are validated (regex safety,
 * grounding in real turns), reviewed by the user in the "Speakers" modal,
 * and only then applied deterministically to every turn. Nothing reaches
 * the server: the confirmed profile (names, colors, rules, include flags)
 * lives in this browser's localStorage, keyed by document.
 *
 * Turn shape: {start, end, text, contentStart?, speaker: <id|null>,
 * source: 'auto'|'manual'|null}. sug_session.speakers is the ordered
 * profile; the FIRST speaker whose rule matches a turn's first line wins.
 * Unlabelled turns get speaker === null (grey "?" badge).
 */

var SUG_SPEAKER_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759',
                          '#76b7b2', '#b07aa1', '#a67c00', '#9c755f'];
var SUG_SPEAKER_STORE = 'taguette_speaker_profile_'; // + document id
var SUG_SPEAKER_DRAFT = null;  // working copy edited by the review modal
var SUG_SPEAKER_COUNT_TIMER = null;

// Profile persistence: tiny JSON in this browser only (no table, no
// endpoint), so reopening the document re-applies the rules for free
function sugSpeakerProfileSave() {
  try {
    window.localStorage.setItem(SUG_SPEAKER_STORE + current_document,
      JSON.stringify({version: 1, speakers: sug_session.speakers}));
  } catch(e) { /* private mode: the profile just won't persist */ }
}

function sugSpeakerProfileLoad(document_id) {
  try {
    var raw = window.localStorage.getItem(SUG_SPEAKER_STORE + document_id);
    var parsed = raw ? JSON.parse(raw) : null;
    if(parsed && parsed.version === 1 && parsed.speakers
       && typeof parsed.speakers.forEach === 'function') {
      return parsed.speakers;
    }
  } catch(e) { /* corrupted store: start fresh */ }
  return [];
}

// The label part of a turn: the merged prefix line, if any ('' otherwise —
// an inline label like "John: hi" is part of the first line and is only
// seen by the rules, not by this getter)
function sugSpeakerPrefix(b) {
  return (b.contentStart !== undefined && b.contentStart > b.start)
    ? b.text.slice(0, b.contentStart - b.start) : '';
}

// What speaker rules are tested against: the first line of the turn,
// capped — labels live at the start of a turn, never deep in the text
function sugSpeakerTarget(b) {
  return b.text.split('\n', 1)[0].slice(0, 80);
}

// Local pre-scan (no LLM): count repeated candidate speaker labels on the
// turns' first lines, and how many turns carry one. A hint for the model
// and the basis for building speakers by hand.
function sugPreScanPrefixes(turns) {
  var counts = {};
  var covered = 0;
  turns.forEach(function(b) {
    var label = sugPrefixLabel(b.text.split('\n', 1)[0]);
    if(!label) {
      return; // no name in it (bare timestamps, cue ranges, numbers)
    }
    var k = label.toLowerCase();
    if(!counts[k]) {
      counts[k] = {label: label, count: 0};
    }
    counts[k].count++;
    ++covered;
  });
  var labels = Object.keys(counts).map(function(k) { return counts[k]; });
  labels.sort(function(a, b) { return b.count - a.count; });
  return {labels: labels.slice(0, 15), covered: covered, total: turns.length};
}

// Random excerpts for the proposal: n turns (default 30, ~len characters
// each), shuffled so the model sees the whole document, first lines
// intact — that is where the labels live
function sugSpeakerSample(turns, n, len) {
  n = n || 30;
  len = len || 300;
  var idx = turns.map(function(_, i) { return i; });
  for(var i = idx.length - 1; i > 0; --i) { // Fisher-Yates
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx.slice(0, n).map(function(i) {
    return turns[i].text.slice(0, len);
  });
}

function sugSpeakerPrompt(excerpts, scan) {
  var listed = scan.labels.map(function(l) {
    return l.label + ' (' + l.count + ' turns)';
  }).join(', ');
  return 'You are helping a qualitative researcher label the speakers of '
    + 'one interview/focus-group/meeting transcript in Taguette.\n'
    + '\n'
    + 'Below are ' + excerpts.length + ' random excerpts from the document'
    + (listed
       ? ', followed by the speaker labels that appear most often at the '
         + 'start of its lines'
       : '')
    + '. Infer how many DIFFERENT speakers there are and how each one can '
      + 'be recognized from the beginning of a turn.\n'
    + '\n'
    + 'Answer with STRICT JSON only — no markdown fences, no commentary:\n'
    + '{"speakers":[{"name":"Name","role":"optional role in a few words",'
    + '"rules":[{"type":"literal","pattern":"John:",'
    + '"example":"John: good point"},{"type":"regex",'
    + '"pattern":"^\\\\[?\\\\d{1,2}:\\\\d{2}\\\\]?\\\\s+John",'
    + '"example":"[00:12] John: good point"}]}],'
    + '"notes":"short free-text observation or empty"}\n'
    + '\n'
    + 'Rules:\n'
    + '- A rule pattern is tested against the FIRST LINE of a turn (at '
      + 'most 80 characters), never the whole text.\n'
    + '- "literal" patterns match the start of that line, '
      + 'case-insensitively; "regex" patterns are JavaScript RegExp '
      + '(applied case-insensitively, no flags), at most 200 characters, '
      + 'and should start with ^.\n'
    + '- Give every speaker at least one rule that uses the exact spelling '
      + 'found in the document; prefer literal rules when a label is a '
      + 'plain name.\n'
    + '- Every rule MUST include an "example": a real beginning of a line '
      + 'from the excerpts that the pattern matches.\n'
    + '- Do NOT invent speakers you have no evidence for; if the transcript '
      + 'has no speaker labels at all, return {"speakers":[],"notes":"..."}.\n'
    + '\n'
    + 'Random excerpts:\n'
    + excerpts.map(function(t, i) {
        return '--- #' + (i + 1) + '\n' + t;
      }).join('\n')
    + (listed ? '\n\nMost frequent line-start labels: ' + listed : '')
    + '\n';
}

// Extract the JSON object from a model answer: strip reasoning blocks and
// markdown fences, then parse the outermost {...}
function sugSpeakerParseJson(text) {
  var t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  var start = t.indexOf('{');
  var end = t.lastIndexOf('}');
  if(start === -1 || end <= start) {
    throw new Error(gettext('The model answer contains no JSON object.'));
  }
  var parsed = JSON.parse(t.slice(start, end + 1)); // may throw SyntaxError
  if(!parsed || !parsed.speakers
     || typeof parsed.speakers.forEach !== 'function') {
    throw new Error(gettext('Unexpected JSON shape.'));
  }
  return parsed;
}

// Reject regex patterns that could hang the browser (ReDoS): anything
// longer than 200 characters, or a quantifier applied to a group that
// already ends in one ((a+)+, (a*)* ...). Character classes count as one
// atom; deliberately conservative — a rejected correct pattern is easy to
// rewrite, and the user reviews every rule anyway.
function sugRuleSafeRegex(pattern) {
  if(typeof pattern !== 'string' || pattern.length === 0
     || pattern.length > 200) {
    return false;
  }
  var flat = pattern.replace(/\\[\s\S]/g, '.')
    .replace(/\[[^\]]*\]/g, 'X');
  return !/[*+}]\s*\)\s*[*+{]/.test(flat);
}

// One rule from the model (or the user) -> normalized {type, pattern,
// example}, or null when unusable. Regexes are syntax- and ReDoS-checked
// here; grounding (matching something real) is checked by the caller.
function sugValidateRule(rule) {
  if(!rule || typeof rule !== 'object') {
    return null;
  }
  var type = rule.type === 'regex' ? 'regex' : 'literal';
  var pattern = String(rule.pattern || '').trim();
  if(!pattern) {
    return null;
  }
  if(type === 'literal') {
    if(pattern.length > 80) {
      return null;
    }
    return {type: 'literal', pattern: pattern,
            example: String(rule.example || '')};
  }
  if(!sugRuleSafeRegex(pattern)) {
    return null;
  }
  try {
    new RegExp(pattern, 'i');
  } catch(e) {
    return null;
  }
  return {type: 'regex', pattern: pattern,
          example: String(rule.example || '')};
}

function sugRuleMatches(rule, target) {
  if(!rule || !rule.pattern || !target) {
    return false;
  }
  if(rule.type === 'regex') {
    try {
      return new RegExp(rule.pattern, 'i').test(target);
    } catch(e) {
      return false;
    }
  }
  return target.toLowerCase().indexOf(rule.pattern.toLowerCase()) === 0;
}

// The first speaker (profile order) with a matching rule wins; null when
// none does
function sugSpeakerOf(turn, speakers) {
  var target = sugSpeakerTarget(turn);
  for(var i = 0; i < speakers.length; ++i) {
    var rules = speakers[i].rules || [];
    for(var r = 0; r < rules.length; ++r) {
      if(sugRuleMatches(rules[r], target)) {
        return speakers[i].id;
      }
    }
  }
  return null;
}

// Validated, grounded speakers out of the model's JSON. Every rule must
// match the example the model cited or at least one real turn, else it is
// dropped; speakers left without rules are dropped too. Profile speakers
// with the same (case-insensitive) name keep their id, color and include
// flag, so manual turn assignments survive a re-proposal.
function sugSpeakersFromProposal(parsed, turns) {
  var prev = {};
  ((sug_session && sug_session.speakers) || []).forEach(function(s) {
    var k = String(s.name || '').trim().toLowerCase();
    if(k) {
      prev[k] = s;
    }
  });
  var used = {};
  var out = [];
  var next_id = 1;
  (parsed.speakers || []).forEach(function(sp) {
    if(!sp || typeof sp !== 'object' || out.length >= 12) {
      return;
    }
    var name = String(sp.name || '').trim().slice(0, 60);
    if(!name) {
      return;
    }
    var rules = [];
    (Array.isArray(sp.rules) ? sp.rules : []).forEach(function(raw) {
      var rule = sugValidateRule(raw);
      if(!rule) {
        return;
      }
      // Grounding: the pattern must match the example the model cited or
      // at least one real turn
      var ok = rule.example
        && sugRuleMatches(rule, rule.example.split('\n', 1)[0].slice(0, 80));
      for(var t = 0; t < turns.length && !ok; ++t) {
        ok = sugRuleMatches(rule, sugSpeakerTarget(turns[t]));
      }
      if(ok) {
        rules.push(rule);
      }
    });
    if(!rules.length) {
      return;
    }
    var old = prev[name.toLowerCase()];
    if(old && used[old.id]) {
      old = null; // two proposed speakers with the same name
    }
    if(old) {
      used[old.id] = true;
    }
    out.push({
      id: old ? old.id : 'sp' + (next_id++) + '_' + Date.now(),
      name: name,
      color: old ? old.color
                 : SUG_SPEAKER_COLORS[out.length % SUG_SPEAKER_COLORS.length],
      include: old ? old.include !== false : true,
      rules: rules,
    });
  });
  return out;
}

// Deterministic assignment over the whole turn list: the first matching
// speaker wins. Turns already assigned by hand (source 'manual') are kept
// as-is, and so are manual assignments inherited by identical text
// (inherited: {turn text -> speaker id}) after a transcript edit.
function sugApplySpeakers(turns, speakers, inherited) {
  var known = {};
  speakers.forEach(function(s) { known[s.id] = true; });
  turns.forEach(function(t) {
    if(t.source === 'manual' && (t.speaker === null || known[t.speaker])) {
      return; // hands off the user's corrections
    }
    if(inherited && inherited[t.text] && known[inherited[t.text]]) {
      t.speaker = inherited[t.text];
      t.source = 'manual';
      return;
    }
    t.speaker = sugSpeakerOf(t, speakers);
    t.source = t.speaker ? 'auto' : null;
  });
  return turns;
}

// >half of [start, end) lies in turns of speakers whose "include" flag is
// off. Turns with no speaker count as included.
function sugIsExcludedSpan(start, end) {
  var turns = (sug_session && sug_session.turns) || null;
  if(!turns || !sug_session.speakers) {
    return false;
  }
  var excluded = {};
  var any = false;
  sug_session.speakers.forEach(function(s) {
    if(s.include === false) {
      excluded[s.id] = true;
      any = true;
    }
  });
  if(!any) {
    return false;
  }
  var total = end - start;
  if(total <= 0) {
    return false;
  }
  var hit = 0;
  for(var i = 0; i < turns.length; ++i) {
    var b = turns[i];
    if(!b.speaker || !excluded[b.speaker] || b.start >= end || b.end <= start) {
      continue;
    }
    hit += Math.min(end, b.end) - Math.max(start, b.start);
    if(2 * hit > total) {
      return true;
    }
  }
  return false;
}

// Short badge text: the speaker's name, trimmed to fit
function sugSpeakerBadgeLabel(s) {
  var name = (s && s.name ? s.name : '?').trim();
  return name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
}

// Render the speaker turns in the transcript: a light outline per turn in
// the speaker's color plus a badge with the speaker's name. The badge is
// textless (CSS paints attr(data-speaker)), so plainText offsets stay
// clean; click it to re-assign the turn by hand.
function sugSpeakerRenderBlocks() {
  sugUnwrapClass('sug-speaker-block');
  var old = document.querySelectorAll('.sug-speaker-badge');
  for(var i = 0; i < old.length; ++i) {
    if(old[i].parentNode) {
      old[i].parentNode.removeChild(old[i]);
    }
  }
  if(!sug_session || !sug_session.turns || !sug_session.speakers
     || !sug_session.speakers.length) {
    return;
  }
  var boc = sug_session.byteOfChar;
  var byId = {};
  sug_session.speakers.forEach(function(s) { byId[s.id] = s; });
  sug_session.turns.forEach(function(b, i) {
    var sp = b.speaker ? byId[b.speaker] : null;
    var color = sp ? sp.color : '';
    var mk = function() {
      var span = document.createElement('span');
      span.className = 'sug-speaker-block';
      span.setAttribute('data-idx', i);
      span.setAttribute('data-speaker-id', b.speaker || '');
      if(color) {
        span.style.setProperty('--sug-speaker-color', color);
      }
      span.title = sp ? ''
        : gettext('No speaker — click the badge to assign one');
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
      badge.className = 'sug-speaker-badge';
      badge.setAttribute('data-idx', i);
      badge.setAttribute('data-speaker', sugSpeakerBadgeLabel(sp));
      badge.setAttribute('data-speaker-id', b.speaker || '');
      if(color) {
        badge.style.setProperty('--sug-speaker-color', color);
      }
      span.parentNode.insertBefore(badge, span);
    }
  });
}

// Update one turn's outline + badge after a manual re-assignment
function sugSpeakerSetBlockDom(i) {
  var turn = sug_session && sug_session.turns && sug_session.turns[i];
  if(!turn) {
    return;
  }
  var sp = null;
  sug_session.speakers.forEach(function(s) {
    if(s.id === turn.speaker) {
      sp = s;
    }
  });
  var color = sp ? sp.color : '';
  var label = sugSpeakerBadgeLabel(sp);
  var sel = '[data-idx="' + i + '"]';
  var spans = document.querySelectorAll('.sug-speaker-block' + sel);
  for(var s = 0; s < spans.length; ++s) {
    spans[s].setAttribute('data-speaker-id', turn.speaker || '');
    if(color) {
      spans[s].style.setProperty('--sug-speaker-color', color);
    } else {
      spans[s].style.removeProperty('--sug-speaker-color');
    }
  }
  var badges = document.querySelectorAll('.sug-speaker-badge' + sel);
  for(var b = 0; b < badges.length; ++b) {
    badges[b].setAttribute('data-speaker', label);
    badges[b].setAttribute('data-speaker-id', turn.speaker || '');
    if(color) {
      badges[b].style.setProperty('--sug-speaker-color', color);
    } else {
      badges[b].style.removeProperty('--sug-speaker-color');
    }
  }
}

function sugSpeakerEscape(text) {
  var el = document.createElement('div');
  el.textContent = String(text);
  return el.innerHTML;
}

// Manual correction: the badge opens a menu of speakers. Assigning by hand
// marks the turn 'manual', so rule re-application and proposals never
// overwrite it.
function sugSpeakerMenu(i, clientX, clientY) {
  if(!sug_session || !sug_session.turns || !sug_session.turns[i]) {
    return;
  }
  var turn = sug_session.turns[i];
  var html = '<div class="sug-menu-title">'
    + gettext('Who speaks in this turn?') + '</div>';
  html += '<button type="button" class="btn btn-sm '
    + (turn.speaker === null ? 'btn-primary' : 'btn-outline-secondary')
    + ' sug-menu-speaker" data-spid=""'
    + ' style="display:block;margin-bottom:4px;">'
    + gettext('No speaker') + '</button>';
  sug_session.speakers.forEach(function(s) {
    var active = turn.speaker === s.id;
    html += '<button type="button" class="btn btn-sm '
      + (active ? 'btn-primary' : 'btn-outline-secondary')
      + ' sug-menu-speaker" data-spid="' + sugSpeakerEscape(s.id)
      + '" style="display:block;margin-bottom:4px;">'
      + '<span style="display:inline-block;width:0.8em;height:0.8em;'
      + 'border-radius:2px;background:' + s.color
      + ';margin-right:4px;"></span>'
      + sugSpeakerEscape(s.name) + '</button>';
  });
  html += '<button type="button" '
    + 'class="btn btn-sm btn-outline-primary sug-menu-speaker-edit" '
    + 'style="display:block;margin-top:4px;">'
    + gettext('Edit speakers\u2026') + '</button>';
  sugShowMenu(html, clientX, clientY, true);
  var menu = sugMenuEl();
  var buttons = menu.querySelectorAll('.sug-menu-speaker');
  for(var b = 0; b < buttons.length; ++b) {
    buttons[b].addEventListener('click', function() {
      var spid = this.getAttribute('data-spid') || null;
      turn.speaker = spid;
      turn.source = 'manual';
      sugSpeakerSetBlockDom(i);
      sugRefilter();
      sugHideMenu();
    });
  }
  var edit = menu.querySelector('.sug-menu-speaker-edit');
  if(edit) {
    edit.addEventListener('click', function() {
      sugHideMenu();
      sugOpenSpeakersModal();
    });
  }
}

/*
 * Speakers review modal: the model proposes, the user edits and confirms,
 * and only then are turns assigned. The draft is a working copy — Confirm
 * commits it to the session (and to the per-document profile), closing
 * the modal discards it.
 */

// The toolbar "Speakers" button. No session: straight to the model
// settings; with a session, the review modal (propose / edit / confirm)
function sugOpenSpeakers() {
  if(!sug_session) {
    taguOpenConfig('segmentation');
    return;
  }
  sugOpenSpeakersModal();
}

function sugOpenSpeakersModal() {
  if(!sug_session) {
    return;
  }
  if(!sug_session.turns) {
    sug_session.turns = sugSpeakerTurns();
  }
  SUG_SPEAKER_DRAFT = JSON.parse(JSON.stringify(sug_session.speakers));
  sugSpeakerRenderDraft();
  var modal = document.getElementById('suggest-speakers-modal');
  $(modal).modal({backdrop: 'static'}).on('hidden.bs.modal', function() {
    $(modal).off('hidden.bs.modal');
    SUG_SPEAKER_DRAFT = null;
  });
  $(modal).modal('show');
}

// Live counts while editing the draft: per-speaker matched turns and the
// unassigned remainder, computed exactly like the final assignment (first
// matching speaker wins; manual assignments untouched)
function sugSpeakerDraftStats() {
  var speakers = SUG_SPEAKER_DRAFT || [];
  var turns = (sug_session && sug_session.turns) || [];
  var per = {};
  var examples = {};
  var unassigned = 0;
  var unassigned_eg = [];
  turns.forEach(function(t) {
    var manual = t.source === 'manual'
      && (t.speaker === null
          || speakers.some(function(s) { return s.id === t.speaker; }));
    var spid = manual ? t.speaker : sugSpeakerOf(t, speakers);
    if(spid) {
      per[spid] = (per[spid] || 0) + 1;
      if(!examples[spid]) {
        examples[spid] = [];
      }
      if(examples[spid].length < 3) {
        examples[spid].push(sugSpeakerTarget(t));
      }
    } else {
      ++unassigned;
      if(unassigned_eg.length < 3) {
        unassigned_eg.push(sugSpeakerTarget(t));
      }
    }
  });
  return {per: per, examples: examples, unassigned: unassigned,
          unassigned_eg: unassigned_eg, total: turns.length};
}

// Refresh the modal's counters without re-rendering the inputs (kept
// cheap enough to run while typing, debounced below)
function sugSpeakerFillCounts() {
  var stats_el = document.getElementById('sug-speakers-stats');
  var un_el = document.getElementById('sug-speakers-unassigned');
  if(!stats_el || !SUG_SPEAKER_DRAFT || !sug_session || !sug_session.turns) {
    return;
  }
  var stats = sugSpeakerDraftStats();
  var assigned = stats.total - stats.unassigned;
  var pct = stats.total ? Math.round(100 * assigned / stats.total) : 0;
  stats_el.textContent = gettext(
    '%(total)s turn(s): %(assigned)s assigned (%(pct)s% coverage), '
    + '%(none)s with no speaker',
    {total: stats.total, assigned: assigned, pct: pct,
     none: stats.unassigned});
  if(stats.unassigned === 0) {
    un_el.textContent = gettext('Every turn has a speaker.');
  } else if(stats.unassigned_eg.length) {
    un_el.textContent = gettext('Turns with no speaker, e.g.:')
      + ' ' + stats.unassigned_eg.map(function(t) {
          return '"' + t.slice(0, 40) + '"';
        }).join(', ');
  } else {
    un_el.textContent = '';
  }
  SUG_SPEAKER_DRAFT.forEach(function(sp) {
    var el = stats_el.parentNode.querySelector(
      '.sug-speaker-count[data-count-for="' + sp.id + '"]');
    if(!el) {
      return;
    }
    var n = stats.per[sp.id] || 0;
    var text = n + ' ' + gettext('turn(s)');
    var eg = stats.examples[sp.id];
    if(eg && eg.length) {
      text += ' \u00b7 ' + gettext('e.g.') + ' ' + eg.map(function(t) {
        return '"' + t.slice(0, 30) + '"';
      }).join(', ');
    } else {
      text += ' \u00b7 ' + gettext('no match yet');
    }
    el.textContent = text;
  });
}

function sugSpeakerQueueCounts() {
  if(SUG_SPEAKER_COUNT_TIMER) {
    window.clearTimeout(SUG_SPEAKER_COUNT_TIMER);
  }
  SUG_SPEAKER_COUNT_TIMER = window.setTimeout(function() {
    SUG_SPEAKER_COUNT_TIMER = null;
    sugSpeakerFillCounts();
  }, 300);
}

// Full re-render of the modal's speaker rows. Structural changes (add,
// remove, merge, propose) go through here; text edits update the draft in
// place and only refresh the counters.
function sugSpeakerRenderDraft() {
  var box = document.getElementById('sug-speakers-list');
  if(!box || !SUG_SPEAKER_DRAFT) {
    return;
  }
  var error_el = document.getElementById('sug-speakers-error');
  if(error_el) {
    error_el.style.display = 'none';
    error_el.textContent = '';
  }
  var speakers = SUG_SPEAKER_DRAFT;
  box.textContent = '';
  if(!speakers.length) {
    box.appendChild(taguEl('p', 'text-muted', gettext(
      'No speakers yet: propose them from the document with AI, or add '
      + 'them by hand.')));
  }
  speakers.forEach(function(sp) {
    var row = taguEl('div', 'sug-speaker-row');
    row.setAttribute('data-sid', sp.id);

    var head = taguEl('div', 'form-row align-items-center');
    var col_color = taguEl('div', 'col-auto');
    var color = document.createElement('input');
    color.type = 'color';
    color.className = 'sug-speaker-color';
    color.value = sp.color;
    color.title = gettext('Color');
    color.addEventListener('change', function() {
      sp.color = color.value;
    });
    col_color.appendChild(color);
    head.appendChild(col_color);

    var col_name = taguEl('div', 'col');
    var name = taguEl('input', 'form-control form-control-sm');
    name.type = 'text';
    name.value = sp.name;
    name.placeholder = gettext('Speaker name');
    name.addEventListener('change', function() {
      var v = name.value.trim();
      if(v) {
        sp.name = v;
        name.value = v;
      } else {
        name.value = sp.name;
      }
    });
    col_name.appendChild(name);
    head.appendChild(col_name);

    var col_inc = taguEl('div', 'col-auto');
    var inc_label = taguEl('label', 'form-check-label mb-0');
    inc_label.title = gettext('Unchecked: highlights mostly inside this '
      + "speaker's turns are not suggested");
    var inc = document.createElement('input');
    inc.type = 'checkbox';
    inc.className = 'form-check-input';
    inc.checked = sp.include !== false;
    inc.addEventListener('change', function() {
      sp.include = inc.checked;
      sugSpeakerFillCounts();
    });
    inc_label.appendChild(inc);
    inc_label.appendChild(document.createTextNode(' ' + gettext('Include')));
    col_inc.appendChild(inc_label);
    head.appendChild(col_inc);

    var col_rm = taguEl('div', 'col-auto');
    var rm = taguEl('button', 'btn btn-sm btn-outline-danger', '\u00d7');
    rm.type = 'button';
    rm.title = gettext('Remove this speaker');
    rm.addEventListener('click', function() {
      sugSpeakerRemoveDraft(sp.id);
    });
    col_rm.appendChild(rm);
    head.appendChild(col_rm);
    row.appendChild(head);

    var rules_box = taguEl('div', 'mt-1');
    (sp.rules || []).forEach(function(rule) {
      rules_box.appendChild(sugSpeakerRuleRow(sp, rule));
    });
    row.appendChild(rules_box);

    var add_rule = taguEl('button', 'btn btn-sm btn-outline-secondary',
      gettext('+ pattern'));
    add_rule.type = 'button';
    add_rule.addEventListener('click', function() {
      sp.rules.push({type: 'literal', pattern: '', example: ''});
      sugSpeakerRenderDraft();
    });
    row.appendChild(add_rule);

    var foot = taguEl('div', 'sug-speaker-count text-muted mt-1');
    foot.setAttribute('data-count-for', sp.id);
    row.appendChild(foot);

    // Merge menu: moves this speaker's rules (and its manual turns) into
    // another one
    if(speakers.length > 1) {
      var merge = taguEl('select', 'form-control form-control-sm mt-1');
      merge.title = gettext('Merge this speaker into another');
      var opt0 = taguEl('option', null, gettext('Merge into\u2026'));
      opt0.value = '';
      merge.appendChild(opt0);
      speakers.forEach(function(other) {
        if(other.id !== sp.id) {
          var o = taguEl('option', null, other.name || '?');
          o.value = other.id;
          merge.appendChild(o);
        }
      });
      merge.addEventListener('change', function() {
        if(merge.value) {
          sugSpeakerMergeDraft(sp.id, merge.value);
        }
      });
      row.appendChild(merge);
    }

    box.appendChild(row);
  });
  sugSpeakerFillCounts();
}

// One pattern row: type (literal text / regex) + pattern + remove. Input
// events update the draft in place (no re-render, so typing keeps focus);
// the change event also refreshes the counters.
function sugSpeakerRuleRow(sp, rule) {
  var rrow = taguEl('div', 'sug-speaker-rule');
  var type = taguEl('select', 'form-control form-control-sm');
  [['literal', gettext('text')], ['regex', gettext('regex')]]
    .forEach(function(pair) {
      var option = taguEl('option', null, pair[1]);
      option.value = pair[0];
      type.appendChild(option);
    });
  type.value = rule.type === 'regex' ? 'regex' : 'literal';
  type.addEventListener('change', function() {
    rule.type = type.value;
    pat.placeholder = rule.type === 'regex'
      ? '^regex against the first line'
      : gettext('text at the start of the first line');
    sugSpeakerFillCounts();
  });
  rrow.appendChild(type);
  var pat = taguEl('input', 'form-control form-control-sm');
  pat.type = 'text';
  pat.value = rule.pattern;
  pat.placeholder = rule.type === 'regex'
    ? '^regex against the first line'
    : gettext('text at the start of the first line');
  pat.addEventListener('input', function() {
    rule.pattern = pat.value.trim();
    pat.classList.toggle('sug-speaker-bad',
      !!rule.pattern && !sugValidateRule(rule));
    sugSpeakerQueueCounts();
  });
  pat.addEventListener('change', function() {
    rule.pattern = pat.value.trim();
    pat.classList.toggle('sug-speaker-bad',
      !!rule.pattern && !sugValidateRule(rule));
    sugSpeakerFillCounts();
  });
  rrow.appendChild(pat);
  var del = taguEl('button', 'btn btn-sm btn-outline-secondary', '\u00d7');
  del.type = 'button';
  del.title = gettext('Remove this pattern');
  del.addEventListener('click', function() {
    sp.rules.splice(sp.rules.indexOf(rule), 1);
    sugSpeakerRenderDraft();
  });
  rrow.appendChild(del);
  return rrow;
}

function sugSpeakerAddDraft() {
  if(!SUG_SPEAKER_DRAFT) {
    return;
  }
  SUG_SPEAKER_DRAFT.push({
    id: 'sp_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    name: gettext('Speaker') + ' ' + (SUG_SPEAKER_DRAFT.length + 1),
    color: SUG_SPEAKER_COLORS[SUG_SPEAKER_DRAFT.length
           % SUG_SPEAKER_COLORS.length],
    include: true,
    rules: [{type: 'literal', pattern: '', example: ''}],
  });
  sugSpeakerRenderDraft();
}

// Merge one draft speaker into another: the rules move over, manual turn
// assignments re-point, the excluded flag pulls down
function sugSpeakerMergeDraft(fromId, intoId) {
  var draft = SUG_SPEAKER_DRAFT;
  if(!draft) {
    return;
  }
  var from = null, into = null, from_idx = -1;
  draft.forEach(function(sp, i) {
    if(sp.id === fromId) {
      from = sp;
      from_idx = i;
    }
    if(sp.id === intoId) {
      into = sp;
    }
  });
  if(!from || !into) {
    return;
  }
  into.rules = (into.rules || []).concat(from.rules || []);
  if(from.include === false) {
    into.include = false;
  }
  draft.splice(from_idx, 1);
  if(sug_session && sug_session.turns) {
    sug_session.turns.forEach(function(t) {
      if(t.source === 'manual' && t.speaker === fromId) {
        t.speaker = intoId;
      }
    });
  }
  sugSpeakerRenderDraft();
}

function sugSpeakerRemoveDraft(id) {
  var draft = SUG_SPEAKER_DRAFT;
  if(!draft) {
    return;
  }
  var idx = -1;
  draft.forEach(function(sp, i) {
    if(sp.id === id) {
      idx = i;
    }
  });
  if(idx === -1) {
    return;
  }
  if(!window.confirm(gettext(
      'Remove speaker %(name)s? Its turns become "no speaker".',
      {name: draft[idx].name || '?'}))) {
    return;
  }
  draft.splice(idx, 1);
  if(sug_session && sug_session.turns) {
    sug_session.turns.forEach(function(t) {
      if(t.source === 'manual' && t.speaker === id) {
        t.speaker = null;
      }
    });
  }
  sugSpeakerRenderDraft();
}

// Commit the draft: validate once more, store the profile, apply the
// rules to every turn and re-render. Manual assignments survive.
function sugSpeakerConfirm() {
  if(!sug_session) {
    return;
  }
  var draft = SUG_SPEAKER_DRAFT || [];
  draft.forEach(function(sp) {
    if(!String(sp.name || '').trim()) {
      sp.name = gettext('Speaker');
    }
    sp.rules = (sp.rules || []).filter(function(r) {
      return !!sugValidateRule(r);
    });
  });
  sug_session.speakers = draft.filter(function(sp) {
    return sp.rules.length;
  });
  SUG_SPEAKER_DRAFT = null;
  sugSpeakerProfileSave();
  if(!sug_session.turns) {
    sug_session.turns = sugSpeakerTurns();
  }
  sugApplySpeakers(sug_session.turns, sug_session.speakers);
  sugSpeakerRenderBlocks();
  sugRefilter();
  $(document.getElementById('suggest-speakers-modal')).modal('hide');
}

// One LLM call: random excerpts + the pre-scanned labels in, validated
// speaker rules out. The answer is untrusted: everything is re-checked
// before it reaches the draft.
function sugSpeakerPropose() {
  var error_el = document.getElementById('sug-speakers-error');
  var propose_btn = document.getElementById('sug-speakers-propose');
  if(!sug_session || !error_el) {
    return;
  }
  var cfg = tagAiLLMConfig('segmentation');
  if(!cfg) {
    error_el.className = 'text-danger mb-0 mt-2';
    error_el.textContent = gettext(
      'Pick a chat model first: open \u2699 Settings \u2192 Segmentation.');
    error_el.style.display = '';
    return;
  }
  if(!sug_session.turns) {
    sug_session.turns = sugSpeakerTurns();
  }
  var turns = sug_session.turns;
  if(!turns.length) {
    error_el.className = 'text-danger mb-0 mt-2';
    error_el.textContent = gettext(
      "No speaker turns found: put each speaker's text on its own line "
      + 'first.');
    error_el.style.display = '';
    return;
  }
  var scan = sugPreScanPrefixes(turns);
  if(scan.total && scan.covered / scan.total < 0.2) {
    console.warn('Suggest: only ' + scan.covered + '/' + scan.total
      + ' turns carry a recognizable label; the proposal may be weak');
  }
  propose_btn.disabled = true;
  propose_btn.textContent = gettext('Proposing\u2026');
  error_el.className = 'text-muted mb-0 mt-2';
  error_el.textContent = gettext('Asking the model for speaker patterns\u2026');
  error_el.style.display = '';
  tagAiChat(cfg, sugSpeakerPrompt(sugSpeakerSample(turns, 30, 300), scan),
            2000)
    .then(function(answer) {
      var proposed = sugSpeakersFromProposal(
        sugSpeakerParseJson(answer), turns);
      if(!proposed.length) {
        throw new Error(gettext(
          'The model found no usable speaker patterns.'));
      }
      SUG_SPEAKER_DRAFT = proposed;
      sugSpeakerRenderDraft();
    })
    .catch(function(error) {
      error_el.className = 'text-danger mb-0 mt-2';
      error_el.textContent = gettext('Failed:') + ' ' + error + ' '
        + gettext('You can add speakers by hand below.');
      console.error('Speaker proposal failed:', error);
    })
    .then(function() {
      propose_btn.disabled = false;
      propose_btn.textContent = gettext('Propose with AI');
    });
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
 * Embedding client (OpenAI-compatible /embeddings endpoint). Configuration
 * lives in the Taguette configuration screen ("Embeddings" tab, see
 * config.js): a saved API key, a local service, or a custom endpoint.
 */

function sugLoadConfig() {
  var r = taguTaskResolve('embeddings', '/embeddings');
  if(!r || !r.url || (r.local && r.local.kind !== 'embeddings')) {
    return null;
  }
  return {url: r.url, token: r.token, model: r.model,
          authHeader: r.authHeader, authScheme: r.authScheme};
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
    taguApplyAuth(headers, cfg);
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
  var hidden = 0;
  (sug_session.speakers || []).forEach(function(s) {
    if(s.include === false) {
      ++hidden;
    }
  });
  var suffix = hidden > 0
    ? ' · ' + gettext('%(n)s speaker(s) hidden', {n: hidden}) : '';
  if(sug_session.rankMode === 'cluster' && themes > 0) {
    return gettext('%(n)s suggestion(s) in %(k)s theme(s)', {n: n, k: themes})
      + suffix;
  }
  return gettext('%(n)s suggestion(s)', {n: n}) + suffix;
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
  // Speaker filter: drop candidates that mostly sit inside the turns of
  // speakers excluded from the suggestions (turns with no speaker count
  // as included)
  var cands = pane.candidates;
  var any_excluded = false;
  (sug_session.speakers || []).forEach(function(s) {
    if(s.include === false) {
      any_excluded = true;
    }
  });
  if(any_excluded) {
    cands = cands.filter(function(c) {
      return !sugIsExcludedSpan(c.cStart, c.cEnd);
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
  if(SUG_EDIT) {
    return; // DOM is being edited; reload re-renders after commit
  }
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
  if(SUG_EDIT) {
    return; // DOM is being edited; reload re-renders after commit
  }
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
  // The highlight boundary-editing UI doesn't survive the pane rebuild
  if(typeof hlSelectClear === 'function') {
    hlSelectClear();
  }
  // Clear all session rendering (real highlights are handled below)
  sugUnwrapClass('sug-span');
  sugUnwrapClass('hl-staged');
  sugUnwrapClass('sug-speaker-block');
  var sp_badges = document.querySelectorAll('.sug-speaker-badge');
  for(var qb = 0; qb < sp_badges.length; ++qb) {
    if(sp_badges[qb].parentNode) {
      sp_badges[qb].parentNode.removeChild(sp_badges[qb]);
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
  sugSpeakerRenderBlocks();
  if(on) {
    sugComputePane('R');
  } else {
    delete sug_session.panes['R'];
    sugSyncAlgoSelects();
    sugRenderPane('');
  }
}


/*
 * Transcript edit mode
 *
 * Automated transcripts routinely misattribute turns. Double-click a
 * paragraph to fix its text in place: the edit is committed to the
 * SERVER (single-user deployments only), so the corrected transcript is
 * the shared source of truth for highlights, exports and every other
 * client. On commit the document is reloaded from the server; if a
 * suggest session is running, its state is remapped and recomputed on
 * the corrected text.
 */

var SUG_EDIT = null; // live edit: {el, para, oldHTML, segs, scrollY}

var SUG_BLOCK_RE = /^(P|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE|DIV|TD|TH|DT|DD|FIGCAPTION|SECTION|ARTICLE|ASIDE|MAIN)$/;

// Split a chunk's text into block segments (paragraph-level units), each
// with its byte range in server coordinates (chunk base + text walk) and
// the block element it belongs to. Inline markup stays inside the current
// segment; block elements cut it.
function sugEditSegments(root, base) {
  var segs = [], cur = null, byte = 0;
  function push(node, levelEl) {
    var t = node.nodeValue;
    if(!t) {
      return;
    }
    if(!cur || cur.el !== levelEl) {
      cur = {el: levelEl, text: '', byteStart: base + byte};
      segs.push(cur);
    }
    cur.text += t;
    byte += lengthUTF8(t);
  }
  function walk(node, levelEl) {
    for(var c = node.firstChild; c; c = c.nextSibling) {
      if(c.nodeType === 3) {
        push(c, levelEl);
      } else if(c.nodeType === 1) {
        if(c.classList && c.classList.contains('sug-speaker-badge')) {
          continue; // textless UI chrome
        }
        if(SUG_BLOCK_RE.test(c.tagName)) {
          cur = null;
          walk(c, c);
          cur = null;
        } else {
          walk(c, levelEl); // inline: stays in the current segment
        }
      }
    }
  }
  walk(root, root);
  for(var i = 0; i < segs.length; ++i) {
    segs[i].byteEnd = segs[i].byteStart + lengthUTF8(segs[i].text);
    // filler whitespace between blocks: counts toward the byte offsets,
    // but is never an editable block (it belongs to no element of its
    // own, so treating it as one corrupts the op generation)
    segs[i].ws = !/[^\u0009\u000a\u000d\u0020]/.test(segs[i].text);
  }
  return segs;
}

// Text directly inside a block element: its own text nodes and inline
// markup, excluding nested blocks (those are segments of their own)
function sugEditTextAtLevel(el) {
  var out = '';
  function walk(node) {
    for(var c = node.firstChild; c; c = c.nextSibling) {
      if(c.nodeType === 3) {
        out += c.nodeValue;
      } else if(c.nodeType === 1) {
        if(c.classList && c.classList.contains('sug-speaker-badge')) {
          continue;
        }
        if(!SUG_BLOCK_RE.test(c.tagName)) {
          walk(c);
        }
      }
    }
  }
  walk(el);
  return out;
}

// Turn an editing session into edit ops by matching block elements:
// the browser keeps a paragraph's DOM node when its text is edited or
// another paragraph is merged into it, and drops the node of a paragraph
// that was merged away or deleted. So: a surviving element with changed
// text becomes a replacement, a dropped element a deletion, and
// brand-new elements (Shift+Enter splits, new paragraphs) fold into the
// op of the old block they sit next to, joined with '\n' -- which the
// server turns into paragraph breaks. Ops are ascending and
// non-overlapping, ready to be applied one after another.
function sugEditOps(chunkEl, oldSegs, newSegs) {
  var ops = [];
  var alive = [];
  var i, j;
  for(i = 0; i < oldSegs.length; ++i) {
    oldSegs[i].alive = chunkEl.contains(oldSegs[i].el);
    if(oldSegs[i].alive) {
      alive.push(oldSegs[i]);
    }
  }
  // New blocks: either inside a surviving element (nested blocks join
  // its replacement text, separated by '\n') or standalone, where they
  // anchor to the nearest old block before/after them and join its op
  // text with a '\n' paragraph break
  function segOfEl(el) {
    for(var k = 0; k < oldSegs.length; ++k) {
      if(oldSegs[k].el === el) {
        return oldSegs[k];
      }
    }
    return null;
  }
  function anchorOf(el) {
    for(var s = el.previousElementSibling; s; s = s.previousElementSibling) {
      if(SUG_BLOCK_RE.test(s.tagName)) {
        var seg = segOfEl(s);
        if(seg) {
          return {seg: seg, after: true};
        }
      }
    }
    for(var s = el.nextElementSibling; s; s = s.nextElementSibling) {
      if(SUG_BLOCK_RE.test(s.tagName)) {
        var seg = segOfEl(s);
        if(seg) {
          return {seg: seg, after: false};
        }
      }
    }
    return null;
  }
  for(i = 0; i < newSegs.length; ++i) {
    var ns = newSegs[i], host = null;
    if(ns.ws) {
      continue; // filler between blocks, not an editable block
    }
    for(j = 0; j < oldSegs.length; ++j) {
      // ws segments belong to the chunk itself: everything is "inside"
      // them, so they must not host anything
      if(oldSegs[j].alive && !oldSegs[j].ws && oldSegs[j].el !== ns.el
          && oldSegs[j].el.contains(ns.el)) {
        host = oldSegs[j];
        break;
      }
    }
    if(host) {
      host.extra = host.extra ? host.extra + '\n' + ns.text : ns.text;
      continue;
    }
    if(alive.some(function(s) { return s.el === ns.el; })) {
      continue; // unchanged survivor, not new
    }
    var anchor = anchorOf(ns.el)
      || (oldSegs.length ? {seg: oldSegs[oldSegs.length - 1], after: true}
                         : null);
    if(anchor) {
      if(anchor.after) {
        anchor.seg.post = anchor.seg.post !== undefined
          ? anchor.seg.post + '\n' + ns.text : ns.text;
      } else {
        anchor.seg.pre = anchor.seg.pre !== undefined
          ? ns.text + '\n' + anchor.seg.pre : ns.text;
      }
    }
  }
  var lastEnd = null, emitted = [], lastOp = null, lastIdx = -1;
  function emit(op, idx) {
    // A pure deletion right after another op, with only filler between,
    // is a paragraph merged into the previous one: fold it into that op
    // so the server's diff maps the merged paragraph's highlights onto
    // the surviving text instead of deleting them with the emptied range
    if(lastOp && op.text === '') {
      var gapWs = true;
      for(var g = lastIdx + 1; g < idx; ++g) {
        if(!oldSegs[g].ws) {
          gapWs = false;
          break;
        }
      }
      if(gapWs) {
        lastOp.bEnd = op.bEnd;
        lastIdx = idx;
        return;
      }
    }
    ops.push(op);
    lastOp = op;
    lastIdx = idx;
  }
  for(i = 0; i < oldSegs.length; ++i) {
    var o = oldSegs[i];
    if(o.ws) {
      lastEnd = o.byteEnd;
      continue; // filler between blocks, not an editable block
    }
    if(o.alive) {
      if(emitted.indexOf(o.el) === -1) {
        emitted.push(o.el); // mixed-level DOMs: one op per element
        var text = sugEditTextAtLevel(o.el);
        if(o.extra !== undefined) {
          text += (text ? '\n' : '') + o.extra;
        }
        if(o.post !== undefined) {
          text += '\n' + o.post;
        }
        if(o.pre !== undefined) {
          text = o.pre + '\n' + text;
        }
        if(text !== o.text) {
          emit({bStart: o.byteStart, bEnd: o.byteEnd, text: text}, i);
        } else {
          lastOp = null; // untouched block: never fold across it
        }
      }
    } else {
      var dtext = (o.pre || '') + (o.post || '');
      emit({bStart: o.byteStart, bEnd: o.byteEnd, text: dtext}, i);
    }
    lastEnd = o.byteEnd;
  }
  return ops;
}

// Shift span lists past an edit; drop spans overlapping the edited text
function sugRemapSpans(list, a, b, delta, tlen) {
  // Same semantics as the server: before the edit unchanged, after it
  // shifted, overlapping it resized to cover the new text (a..a+tlen);
  // dropped only if the edit removed all of the span's text
  for(var i = list.length - 1; i >= 0; --i) {
    var s = list[i];
    if(s.end <= a) {
      ; // before the edit: unchanged
    } else if(s.start >= b) {
      s.start += delta;
      s.end += delta;
    } else {
      var ns = s.start <= a ? s.start : a + tlen;
      var ne = s.end >= b ? s.end + delta : a + tlen;
      if(ne <= ns) {
        list.splice(i, 1); // no text left
      } else {
        s.start = ns;
        s.end = ne;
      }
    }
  }
}

function sugMaybeEdit(e) {
  if(!window.tagu_edit_documents || !current_document || SUG_EDIT) {
    return;
  }
  var contents = document.getElementById('document-contents');
  var target = e.target;
  if(!contents || !target || !contents.contains(target)) {
    return;
  }
  if(target.closest('.sug-menu') || target.closest('.sug-speaker-badge')) {
    return; // controls, not text
  }
  var chunk = target.closest('[id^="doc-offset-"]');
  if(!chunk || chunk.id.indexOf('doc-offset-R') === 0) {
    return; // only the main pane is editable
  }
  var para = target.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, div, td');
  if(!para || para === contents || !para.textContent) {
    return;
  }
  // The whole chunk is editable, so Backspace merges paragraphs and
  // selecting + deleting removes them; the outline marks the target
  SUG_EDIT = {el: chunk, para: para, oldHTML: chunk.innerHTML,
              segs: sugEditSegments(chunk, parseInt(chunk.id.substring(11)) || 0),
              scrollY: window.pageYOffset || 0};
  chunk.setAttribute('contenteditable', 'true');
  para.classList.add('sug-editing');
  chunk.addEventListener('keydown', sugEditKey);
  chunk.addEventListener('blur', sugEditBlur);
  chunk.focus();
}

function sugEditKey(e) {
  if(!SUG_EDIT) {
    return;
  }
  if(e.keyCode === 27) { // Esc
    e.preventDefault();
    sugExitEdit(true);
  } else if(e.keyCode === 13 && e.shiftKey) { // Shift+Enter: new paragraph
    e.preventDefault();
    sugSplitParagraph();
  } else if(e.keyCode === 13) { // Enter
    e.preventDefault();
    sugExitEdit(false);
  }
}

// Split the paragraph at the caret: everything after the caret moves
// into a new block of the same kind after it, and the caret moves to
// the start of that block (the commit diff sees a brand-new block and
// folds it into the previous block's op with a '\n')
function sugSplitParagraph() {
  var ed = SUG_EDIT;
  var sel = window.getSelection();
  if(!ed || !sel || !sel.rangeCount) {
    return;
  }
  var range = sel.getRangeAt(0);
  if(!ed.el.contains(range.startContainer)) {
    return;
  }
  var node = range.startContainer;
  var blk = node.nodeType === 1 ? node : node.parentNode;
  while(blk && blk !== ed.el && !SUG_BLOCK_RE.test(blk.tagName)) {
    blk = blk.parentNode;
  }
  if(!blk || blk === ed.el) {
    return; // caret not inside a block (empty chunk?)
  }
  var tail = document.createRange();
  tail.selectNodeContents(blk);
  tail.setStart(range.startContainer, range.startOffset);
  var freshEl = document.createElement(blk.tagName);
  freshEl.appendChild(tail.extractContents());
  blk.parentNode.insertBefore(freshEl, blk.nextSibling);
  // Empty blocks need a <br> to stay visible and caret-able
  if(!freshEl.textContent) {
    freshEl.appendChild(document.createElement('br'));
  }
  if(!blk.textContent) {
    blk.appendChild(document.createElement('br'));
  }
  var caret = document.createRange();
  caret.setStart(freshEl.firstChild || freshEl, 0);
  caret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caret);
}

function sugEditBlur() {
  if(SUG_EDIT) {
    sugExitEdit(false);
  }
}

function sugExitEdit(cancel) {
  var ed = SUG_EDIT;
  if(!ed) {
    return;
  }
  SUG_EDIT = null; // clear first: our own DOM changes must not re-trigger
  ed.el.removeEventListener('keydown', sugEditKey);
  ed.el.removeEventListener('blur', sugEditBlur);
  ed.el.removeAttribute('contenteditable');
  if(ed.para && ed.para.parentNode) {
    ed.para.classList.remove('sug-editing');
  }
  if(cancel) {
    ed.el.innerHTML = ed.oldHTML; // restore nested markup untouched
    return;
  }
  sugCommitEdit(ed);
}

// POST the edits to the server, then reload the document from the truth.
// Several paragraphs may have changed (or merged/deleted) in one editing
// session, so ops are applied one after another, each shifting the next.
function sugCommitEdit(ed) {
  var ops = sugEditOps(ed.el, ed.segs, sugEditSegments(ed.el, 0));
  if(!ops.length) {
    return; // nothing changed
  }
  var deleted = 0;
  function run(idx) {
    if(idx >= ops.length) {
      return Promise.resolve();
    }
    var op = ops[idx];
    return postJSON(
      '/api/project/' + project_id + '/document/' + current_document + '/edit',
      {start_offset: op.bStart, end_offset: op.bEnd, text: op.text,
       paragraphs: true}
    )
    .then(function(resp) {
      deleted += (resp.deleted_highlights || []).length;
      for(var k = idx + 1; k < ops.length; ++k) {
        ops[k].bStart += resp.delta;
        ops[k].bEnd += resp.delta;
      }
      if(sug_session) {
        // Keep client-side spans in step with the new server offsets
        // (newlines became paragraph breaks: they carry no bytes)
        var tlen = lengthUTF8(op.text.replace(/\n/g, ''));
        sugRemapSpans(sug_session.staged, op.bStart, op.bEnd, resp.delta,
                      tlen);
        var panes = sug_session.panes;
        for(var pk in panes) {
          if(panes[pk].savedSuggestions) {
            for(var ak in panes[pk].savedSuggestions) {
              sugRemapSpans(panes[pk].savedSuggestions[ak],
                            op.bStart, op.bEnd, resp.delta,
                            tlen);
            }
          }
        }
      }
    })
    .then(function() { return run(idx + 1); });
  }
  run(0)
  .then(function() {
    if(deleted) {
      alert(gettext(
        'Text updated. %(n)s highlight(s) overlapped the edit and were removed.',
        {n: deleted}));
    }
    if(sug_session) {
      sug_session.editGen += 1;
    }
    // Detach the comparison pane: loadDocument refreshes the main pane,
    // and highlightSelection would wrap into stale clones otherwise
    var paneB = document.getElementById('document-contents-b');
    if(paneB && paneB.parentNode) {
      paneB.parentNode.removeChild(paneB);
    }
    chunk_offsets_b = [];
    return loadDocument(current_document, true); // keep the scroll position
  })
  .then(function() {
    window.scrollTo(0, ed.scrollY);
    if(!sug_session) {
      return;
    }
    sugSyncPaneB();
    sugRebuildAfterReload();
  })
  .catch(function(error) {
    console.error('Failed to edit document:', error);
    alert(gettext("Couldn't edit the document!") + '\n\n' + error);
    loadDocument(current_document, true).then(function() {
      window.scrollTo(0, ed.scrollY);
      if(sug_session) {
        sugSyncPaneB();
        sugRebuildAfterReload();
      }
    });
  });
}

// Rebuild the comparison pane from the freshly loaded main pane
function sugSyncPaneB() {
  if(!sug_session || !sug_session.split) {
    return;
  }
  var view = document.getElementById('document-view');
  var contents = document.getElementById('document-contents');
  var paneB = document.getElementById('document-contents-b');
  if(!paneB) {
    paneB = document.createElement('div');
    paneB.id = 'document-contents-b';
    view.appendChild(paneB);
  }
  paneB.innerHTML = '';
  chunk_offsets_b = chunk_offsets.slice();
  var chunks = contents.querySelectorAll('[id^="doc-offset-"]');
  for(var i = 0; i < chunks.length; ++i) {
    var clone = chunks[i].cloneNode(true);
    clone.id = 'doc-offset-R' + chunks[i].id.substring(11);
    paneB.appendChild(clone);
  }
  // Unwrap and re-wrap the real highlights so both panes carry them
  var ids = Object.keys(highlights);
  ids.forEach(removeHighlight);
  ids.forEach(function(id) { setHighlight(highlights[id]); });
}

// Recompute the session state after the document changed underneath it
function sugRebuildAfterReload() {
  // Manual speaker assignments are inherited by identical turn text
  var oldByText = {};
  if(sug_session.turns) {
    sug_session.turns.forEach(function(t) {
      if(t.speaker) {
        oldByText[t.text] = t.speaker;
      }
    });
  }
  var index = sugBuildPlainIndex();
  sug_session.plainText = index.plainText;
  sug_session.byteOfChar = index.byteOfChar;
  sug_session.totalBytes = index.totalBytes;
  sug_session.sentences = sugSplitSentences(index.plainText);
  SUG_ALGO_CACHE[current_document] = {};
  if(sug_session.speakers && sug_session.speakers.length) {
    // Recompute the turns on the corrected text and re-apply the profile;
    // manual assignments survive through identical turn texts
    var turns = sugSpeakerTurns();
    sugApplySpeakers(turns, sug_session.speakers, oldByText);
    sug_session.turns = turns;
  } else {
    sug_session.turns = null;
  }
  Object.keys(sug_session.panes).forEach(function(pk) {
    sug_session.panes[pk].candidates = null;
    sugComputePane(pk);
  });
  sug_session.staged.forEach(sugRenderStaged);
  sugSpeakerRenderBlocks();
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
    speakers: [],        // speaker profile: [{id, name, color, include, rules}]
    turns: null,         // speaker turns: [{start, end, text, speaker, source}]
    editGen: 0,          // bumped on every document edit; guards async work
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
  // A saved speaker profile re-applies for free: the turns are recomputed
  // and the rules matched again, with no LLM call
  var profile = sugSpeakerProfileLoad(current_document);
  if(profile.length) {
    sug_session.speakers = profile;
    sug_session.turns = sugSpeakerTurns();
    sugApplySpeakers(sug_session.turns, sug_session.speakers);
    sugSpeakerRenderBlocks();
  }
}

function sugCleanup() {
  if(!sug_session) {
    return;
  }
  if(SUG_EDIT) {
    sugExitEdit(true); // never leave a paragraph editable behind
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
  sugUnwrapClass('sug-speaker-block');
  var brackets = document.querySelectorAll('.sug-bracket');
  for(var i = 0; i < brackets.length; ++i) {
    brackets[i].parentNode.removeChild(brackets[i]);
  }
  var sp_badges = document.querySelectorAll('.sug-speaker-badge');
  for(var qb = 0; qb < sp_badges.length; ++qb) {
    if(sp_badges[qb].parentNode) {
      sp_badges[qb].parentNode.removeChild(sp_badges[qb]);
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
 * Config screen: the "Embeddings" button in the suggest toolbar and the
 * ranking-mode fallback open the configuration screen on the embeddings
 * tab (the old dedicated modal was folded into that screen).
 */

function sugOpenConfig() {
  taguOpenConfig('embeddings');
}

// The tab itself: endpoint + model for the embeddings task
function sugConfigTabBuild(el) {
  var intro = taguEl('p', 'text-muted', gettext(
    'Embedding service for semantic ranking, themes and tag search. Any OpenAI-compatible /embeddings endpoint works: pick one of your API keys, a local service, or a custom endpoint.'));
  el.appendChild(intro);
  taguTaskPanel(el, {
    task: 'embeddings',
    locals: ['ollama', 'llamacpp', 'tei'],
    defaultPath: '/embeddings',
    modelPlaceholder: function(src) {
      var key = src.indexOf('key:') === 0 ? taguKeyById(src.slice(4)) : null;
      if(key) {
        var ph = {
          openai: 'text-embedding-3-small',
          openrouter: 'openai/text-embedding-3-small',
          gemini: 'gemini-embedding-001',
          qwen: 'text-embedding-v3',
          zai: 'embedding-3',
        }[key.provider];
        if(ph) {
          return ph;
        }
        return null; // generic placeholder
      }
      if(src === 'local:ollama') {
        return 'all-minilm';
      }
      if(src === 'local:llamacpp') {
        return 'nomic-embed-text';
      }
      if(src === 'local:tei') {
        return 'BAAI/bge-small-en-v1.5';
      }
      return null;
    },
    test: function(resolved) {
      return sugEmbed(['test'], {
        url: resolved.url, token: resolved.token, model: resolved.model,
        authHeader: resolved.authHeader, authScheme: resolved.authScheme,
      }, false);
    },
    changed: function() {
      // Re-score with the (possibly new) endpoint/model; the embKey check
      // inside sugEnhanceEmbeddings invalidates the old scores and only new
      // texts get embedded
      if(sug_session && sug_session.useEmbeddings) {
        sugEnhanceEmbeddings();
      }
    },
  });

  // Number of suggested tags in the highlight form (a tags-ai.js feature;
  // the setting lives here because the suggestions are embedding-based)
  if(typeof tagAiModalView === 'function') {
    var group = taguEl('div', 'form-group mt-3 mb-0');
    var label = taguEl('label', 'mb-1',
      gettext('Tag suggestions in the highlight form'));
    label.setAttribute('for', 'sug-tag-suggestions');
    var input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '100';
    input.step = '1';
    input.className = 'form-control';
    input.id = 'sug-tag-suggestions';
    input.value = tagAiTopN();
    input.addEventListener('change', function() {
      var n = parseInt(input.value, 10);
      if(isNaN(n) || n < 1 || n > 100) {
        input.value = tagAiTopN();
        return;
      }
      var cfg = taguConfig();
      cfg.tasks.embeddings = cfg.tasks.embeddings || {};
      cfg.tasks.embeddings.tag_suggestions = n;
      taguConfigSave(cfg);
    });
    group.appendChild(label);
    group.appendChild(input);
    group.appendChild(taguEl('small', 'form-text text-muted', gettext(
      'Number of suggested tags shown for a new highlight before "Show all tags".')));
    el.appendChild(group);
  }
}

taguConfigRegisterTab({
  id: 'embeddings', title: gettext('Embeddings'), order: 200,
  build: sugConfigTabBuild,
});


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
  document.addEventListener('dblclick', sugMaybeEdit);

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
  document.getElementById('sug-speakers-btn').addEventListener('click', function(e) {
    e.preventDefault();
    sugOpenSpeakers();
  });
  // Speakers review modal (static markup, wired once)
  document.getElementById('sug-speakers-add').addEventListener('click', function() {
    sugSpeakerAddDraft();
  });
  document.getElementById('sug-speakers-propose').addEventListener('click', function() {
    sugSpeakerPropose();
  });
  document.getElementById('sug-speakers-confirm').addEventListener('click', function() {
    sugSpeakerConfirm();
  });
  // Badge clicks are delegated: badges are re-created on every re-render
  document.addEventListener('click', function(e) {
    var badge = e.target && e.target.closest
      ? e.target.closest('.sug-speaker-badge') : null;
    if(badge && sug_session && sug_session.turns) {
      e.preventDefault();
      sugSpeakerMenu(parseInt(badge.getAttribute('data-idx'), 10),
                     e.clientX + 8, e.clientY + 8);
    }
  });
  document.getElementById('sug-stop').addEventListener('click', function(e) {
    e.preventDefault();
    sugStopButton();
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

  // Speaker segmentation helpers: prefixes, pre-scan, rules, assignment
  var seg_plain = 'Interviewer:\nCan you tell me about the flood?\n'
    + 'Maria:\nIt destroyed our ground floor in 2019\n'
    + 'Interviewer:\nAnd then what happened?\n'
    + '[00:20] JOHN\nThe water rose fast\n'
    + 'Maria:\nWe organized the committee ourselves';
  var seg_blocks = sugTurnsOfText(seg_plain);
  assert(seg_blocks.length === 5, 'one turn per label+content pair, got '
         + seg_blocks.length);
  assert(sugSpeakerPrefix(seg_blocks[0]) === 'Interviewer:\n'
         && sugSpeakerPrefix(seg_blocks[1]) === 'Maria:\n',
         'sugSpeakerPrefix exposes the merged prefix line');
  var inline_blocks = sugBlocksOfText('John: hello there\nMaria: hi there');
  assert(inline_blocks.length === 2, 'inline labels keep one block per line');
  assert(inline_blocks[0].contentStart === undefined
         && sugSpeakerPrefix(inline_blocks[0]) === '',
         'inline-labelled turns have no separate prefix');
  assert(sugSpeakerTarget(inline_blocks[0]) === 'John: hello there',
         'rules see the first line of the turn');
  assert(sugSpeakerTarget({text: 'x'.repeat(100) + '\nmore'}).length === 80,
         'rules never see more than 80 characters');

  // Continuation paragraphs absorb into the open turn until the next
  // speaker/timestamp prefix (or inline label)
  var abs_plain = 'Preamble about the project.\n'
    + 'Interviewer:\nFirst question, tell me more.\n'
    + 'Still the interviewer, a second paragraph.\n'
    + 'Maria:\nSure, the basement flooded.\n'
    + 'And we lost everything in it.\n'
    + 'John: I helped with the pump\n'
    + 'again after midnight\n'
    + 'John: and again at dawn';
  var abs_turns = sugTurnsOfText(abs_plain);
  assert(abs_turns.length === 5, 'turns absorb continuations, got '
         + abs_turns.length);
  assert(abs_turns[0].text === 'Preamble about the project.',
         'text before the first label stays standalone');
  assert(abs_turns[1].text.indexOf('second paragraph') !== -1
         && abs_turns[1].contentStart === abs_plain.indexOf('First question'),
         'a turn runs until the next prefix line');
  assert(abs_turns[2].text.indexOf('lost everything') !== -1,
         'the next prefix opens a new turn that absorbs again');
  assert(abs_turns[3].text === 'John: I helped with the pump\n'
         + 'again after midnight',
         'inline labels open turns that absorb continuations');
  assert(abs_turns[4].text === 'John: and again at dawn',
         'each inline-labelled line starts its own turn');
  assert(sugSpeakerPrefix(abs_turns[1]) === 'Interviewer:\n'
         && sugSpeakerPrefix(abs_turns[3]) === '',
         'absorbed turns keep their prefix exposed');
  var qa_turns = sugTurnsOfText('Q: how did it start?\nA: with the rains\n'
                                + 'Q: and then?');
  assert(qa_turns.length === 3, 'single-letter labels turn too, got '
         + qa_turns.length);

  assert(seg_blocks[0].start === 0, 'merged turn starts at the prefix');
  assert(seg_plain.slice(seg_blocks[1].start, seg_blocks[1].end)
         === 'Maria:\nIt destroyed our ground floor in 2019',
         'turn offsets point at trimmed text');

  // Prefix lines (speaker label / timestamp) still fold into the next turn
  var pre = sugBlocksOfText('Interviewer:\nCan you tell me about the flood?\n'
    + 'Respondent:\nIt destroyed our ground floor');
  assert(pre.length === 2, 'prefix lines merge forward: ' + pre.length);
  assert(pre[0].text === 'Interviewer:\nCan you tell me about the flood?',
         'merged block keeps prefix text');
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

  var scan = sugPreScanPrefixes(seg_blocks);
  var by_label = {};
  scan.labels.forEach(function(l) {
    by_label[l.label.toLowerCase()] = l.count;
  });
  assert(by_label['maria'] === 2 && by_label['interviewer'] === 2
         && by_label['john'] === 1, 'pre-scan counts the labels');
  assert(scan.covered === 5 && scan.total === 5,
         'pre-scan coverage counts labelled turns');
  var scan2 = sugPreScanPrefixes(sugBlocksOfText(
    'Just prose, no labels at all here.\nSecond line also plain.'));
  assert(scan2.covered === 0, 'label-free prose produces no candidates');

  // Rule validation (the model is untrusted)
  assert(sugValidateRule({type: 'regex',
                          pattern: '^\\[?\\d{1,2}:\\d{2}\\]?\\s+JOHN'})
         !== null, 'valid regex rule accepted');
  assert(sugValidateRule({type: 'regex', pattern: '([a+]+)+'}) === null,
         'nested-quantifier regex rejected (ReDoS)');
  assert(sugValidateRule({type: 'regex', pattern: '([unclosed'}) === null,
         'syntactically invalid regex rejected');
  assert(sugValidateRule({type: 'regex', pattern: 'x'.repeat(201)}) === null,
         'over-long regex rejected');
  var lit = sugValidateRule({type: 'literal', pattern: 'John:',
                             example: 'John: hi'});
  assert(lit && lit.type === 'literal' && lit.pattern === 'John:',
         'literal rule normalized');
  assert(sugValidateRule({type: 'literal', pattern: ''}) === null,
         'empty literal rejected');
  assert(sugValidateRule({type: 'literal', pattern: 'x'.repeat(81)}) === null,
         'over-long literal rejected');
  assert(sugRuleMatches({type: 'literal', pattern: 'John'}, 'John: hello'),
         'literal matches the start, case-insensitively');
  assert(!sugRuleMatches({type: 'literal', pattern: 'John'}, 'Dr. John:'),
         'literal does not match mid-line');
  assert(!sugRuleMatches({type: 'literal', pattern: ''}, 'anything'),
         'empty patterns match nothing');
  assert(sugRuleMatches({type: 'regex',
                         pattern: '^\\[?\\d{1,2}:\\d{2}\\]?\\s+John'},
                        '[00:20] John'), 'regex rule matches');

  // Proposal parsing and grounding
  var parsed = sugSpeakerParseJson('Sure!\n```json\n'
    + '{"speakers":[{"name":"X","rules":[{"type":"literal",'
    + '"pattern":"X:","example":"X: hi"}]}]}\n```\nDone');
  assert(parsed.speakers.length === 1, 'JSON extracted from a fenced answer');
  var threw = false;
  try {
    sugSpeakerParseJson('no json at all');
  } catch(e) {
    threw = true;
  }
  assert(threw, 'missing JSON raises');
  var built = sugSpeakersFromProposal({speakers: [
    {name: 'Ghost', rules: [{type: 'literal', pattern: 'GHOSTLY:',
                             example: 'nope'}]},
    {name: 'Real', rules: [{type: 'literal', pattern: 'Maria:',
                            example: 'Maria: ok'}]},
  ]}, seg_blocks);
  assert(built.length === 1 && built[0].name === 'Real',
         'ungrounded rules and speakers are dropped');

  // Deterministic assignment, first match wins, manual assignments kept
  var speakers = [
    {id: 's1', name: 'Interviewer', color: '#4e79a7', include: true,
     rules: [{type: 'literal', pattern: 'Interviewer'}]},
    {id: 's2', name: 'Maria', color: '#59a14f', include: true,
     rules: [{type: 'literal', pattern: 'Maria'}]},
    {id: 's3', name: 'John', color: '#f28e2b', include: true,
     rules: [{type: 'regex', pattern: '^\\[?\\d{1,2}:\\d{2}\\]?\\s+JOHN'}]},
  ];
  sugApplySpeakers(seg_blocks, speakers);
  assert(seg_blocks[0].speaker === 's1' && seg_blocks[2].speaker === 's1',
         'assignment: interviewer turns');
  assert(seg_blocks[1].speaker === 's2' && seg_blocks[4].speaker === 's2',
         'assignment: Maria turns');
  assert(seg_blocks[3].speaker === 's3',
         'assignment: regex rule catches the timestamped label');
  var dup = [
    {id: 'a', name: 'M1', color: '#111', include: true,
     rules: [{type: 'literal', pattern: 'Maria'}]},
    {id: 'b', name: 'M2', color: '#222', include: true,
     rules: [{type: 'literal', pattern: 'Maria'}]},
  ];
  assert(sugSpeakerOf(seg_blocks[1], dup) === 'a',
         'first matching speaker wins');
  seg_blocks[4].speaker = 's3';
  seg_blocks[4].source = 'manual';
  sugApplySpeakers(seg_blocks, speakers);
  assert(seg_blocks[4].speaker === 's3' && seg_blocks[4].source === 'manual',
         'manual assignment not overwritten');
  seg_blocks[0].speaker = null;
  seg_blocks[0].source = 'manual';
  sugApplySpeakers(seg_blocks, speakers);
  assert(seg_blocks[0].speaker === null, 'manual no-speaker kept');
  seg_blocks[0].speaker = 's1';
  seg_blocks[0].source = null;
  var inherited = {};
  inherited[seg_blocks[1].text] = 's3';
  sugApplySpeakers(seg_blocks, speakers, inherited);
  assert(seg_blocks[1].speaker === 's3' && seg_blocks[1].source === 'manual',
         'identical text inherits the manual assignment');
  seg_blocks[1].speaker = 's2';
  seg_blocks[1].source = 'auto';

  // Merging a speaker into another re-points manual turns and moves rules
  sug_session = {speakers: [], turns: seg_blocks};
  SUG_SPEAKER_DRAFT = [
    {id: 's2', name: 'Maria', color: '#59a14f', include: true,
     rules: [{type: 'literal', pattern: 'Maria'}]},
    {id: 's3', name: 'John', color: '#f28e2b', include: true,
     rules: [{type: 'literal', pattern: 'JOHN'}]},
  ];
  sugSpeakerMergeDraft('s3', 's2');
  assert(SUG_SPEAKER_DRAFT.length === 1
         && SUG_SPEAKER_DRAFT[0].rules.length === 2,
         'merge moves the rules into the target');
  assert(seg_blocks[4].speaker === 's2',
         'merge re-points manual assignments');
  SUG_SPEAKER_DRAFT = null;

  // Per-speaker filter: >half of the span in an excluded speaker's turns
  var saved_s = sug_session;
  sug_session = {speakers: speakers, turns: seg_blocks};
  speakers[1].include = false; // Maria excluded
  var m_start = seg_blocks[1].start, m_end = seg_blocks[1].end;
  assert(sugIsExcludedSpan(m_start, m_end),
         'span inside an excluded speaker is excluded');
  assert(!sugIsExcludedSpan(seg_blocks[0].start, seg_blocks[0].end),
         'span in an included speaker is kept');
  assert(sugIsExcludedSpan(m_start - 1, m_end),
         'majority overlap counts as excluded');
  assert(!sugIsExcludedSpan(m_end - 1, m_end + 40),
         'minority overlap does not');
  seg_blocks[3].speaker = null;
  assert(!sugIsExcludedSpan(seg_blocks[3].start, seg_blocks[3].end),
         'turns with no speaker stay included');
  seg_blocks[3].speaker = 's3';
  speakers[1].include = true;
  sug_session = saved_s;
  assert(!sugIsExcludedSpan(0, 10), 'no session state means no filtering');

  // Configuration screen: migration, task resolution, auth headers
  assert(typeof taguTaskResolve === 'function', 'config.js is loaded');
  assert(typeof tagAiLLMConfig === 'function', 'tags-ai.js is loaded');
  var provs = Object.keys(TAGU_PROVIDERS);
  ['anthropic', 'deepseek', 'gemini', 'minimax', 'openai', 'openrouter',
   'qwen', 'zai', 'custom'].forEach(function(p) {
    assert(provs.indexOf(p) !== -1, 'provider catalog has ' + p);
  });
  var mig = taguMigrateLegacy(
    {url: 'https://example.com/v1/embeddings', token: 'tok', model: 'm1'},
    {provider: 'jev', jevKey: 'or-1', jevModel: '~typesafe/jev-latest',
     jevUrl: 'https://openrouter.ai/api/alpha/decisions'});
  assert(mig.tasks.embeddings.source === 'custom'
         && mig.tasks.embeddings.url === 'https://example.com/v1/embeddings'
         && mig.tasks.embeddings.token === 'tok',
         'legacy embedding config migrates to a custom task');
  assert(mig.keys.length === 1 && mig.keys[0].provider === 'openrouter'
         && mig.keys[0].token === 'or-1'
         && mig.tasks.decisions.source === 'key:' + mig.keys[0].id,
         'legacy jev config migrates to a key-based decisions task');
  var mig2 = taguMigrateLegacy(null, {provider: 'laya', layaUrl: 'http://localhost:8000'});
  assert(mig2.tasks.decisions.source === 'local:laya'
         && mig2.tasks.decisions.url === 'http://localhost:8000/v1/systemone',
         'legacy laya config migrates to the local service');
  assert(taguMigrateLegacy(null, null).tasks.embeddings === undefined,
         'no legacy config means no tasks');
  var auth_bearer = taguKeyAuth({provider: 'openrouter', headerFormat: 'bearer'});
  assert(auth_bearer.header === 'Authorization' && auth_bearer.scheme === 'Bearer ',
         'default auth is Authorization: Bearer');
  assert(taguKeyAuth({provider: 'anthropic'}).header === 'x-api-key',
         'anthropic keys use x-api-key');
  assert(taguKeyAuth({provider: 'gemini'}).header === 'x-goog-api-key',
         'gemini keys use x-goog-api-key');
  assert(taguKeyAuth({provider: 'custom', headerFormat: 'x-api-key'}).header
         === 'x-api-key', 'custom providers can override the header format');
  assert(taguKeyBase({provider: 'qwen'})
         === 'https://dashscope.aliyuncs.com/compatible-mode/v1',
         'qwen base url');
  assert(taguKeyBase({provider: 'custom', baseUrl: 'https://x.example/v1/'})
         === 'https://x.example/v1', 'custom base url trailing slash stripped');
  // Task resolution through the real store, saved and restored around the
  // asserts so the user's actual configuration is untouched
  var ls = window.localStorage;
  var saved_store = ls.getItem('taguette_config');
  try {
    ls.setItem('taguette_config', JSON.stringify({version: 1,
      keys: [{id: 'kA', provider: 'openrouter', name: 'OR', token: 'tA'},
             {id: 'kB', provider: 'custom', name: 'Mine', token: 'tB',
              baseUrl: 'https://my.example/v1', headerFormat: 'x-api-key'}],
      tasks: {
        embeddings: {source: 'key:kA', url: '', token: '', model: 'm'},
        decisions: {source: 'key:kB', url: '', token: '', model: ''},
      }}));
    var emb = sugLoadConfig();
    assert(emb && emb.url === 'https://openrouter.ai/api/v1/embeddings'
           && emb.token === 'tA' && emb.model === 'm'
           && emb.authHeader === 'Authorization',
           'embeddings task resolves a key to base + /embeddings');
    ls.setItem('taguette_config', JSON.stringify({version: 1,
      keys: [{id: 'kA', provider: 'openrouter', name: 'OR', token: 'tA'}],
      tasks: {segmentation: {source: 'key:kA', url: '', token: '',
                             model: ''}}}));
    var seg_res = taguResolveTask(taguConfig().tasks.segmentation,
                                  '/chat/completions');
    assert(seg_res
           && seg_res.url === 'https://openrouter.ai/api/v1/chat/completions'
           && seg_res.token === 'tA',
           'segmentation keys default to the OpenAI-compatible chat endpoint');
    var seg_cfg = tagAiLLMConfig('segmentation');
    assert(seg_cfg
           && seg_cfg.url === 'https://openrouter.ai/api/v1/chat/completions'
           && typeof seg_cfg.temperature === 'number',
           'tagAiLLMConfig generalizes to the segmentation task');
    assert(tagAiLLMConfig('llm') === null, 'the AI-tags task stays independent');
    ls.setItem('taguette_config', JSON.stringify({version: 1,
      keys: [{id: 'kB', provider: 'custom', name: 'Mine', token: 'tB',
              baseUrl: 'https://my.example/v1', headerFormat: 'x-api-key'}],
      tasks: {segmentation: {source: 'key:kB',
                             url: 'https://my.example/v1/chat', token: '',
                             model: 'm9'}}}));
    seg_cfg = tagAiLLMConfig('segmentation');
    assert(seg_cfg && seg_cfg.url === 'https://my.example/v1/chat'
           && seg_cfg.token === 'tB' && seg_cfg.authHeader === 'x-api-key'
           && seg_cfg.model === 'm9',
           'segmentation task resolves a custom key with a URL override');
    ls.setItem('taguette_config', JSON.stringify({version: 1, keys: [],
      tasks: {embeddings: {source: 'local:ollama', url: '', token: '',
                           model: 'all-minilm'}}}));
    emb = sugLoadConfig();
    assert(emb && emb.url === 'http://localhost:11434/v1/embeddings'
           && !emb.token && emb.model === 'all-minilm',
           'local ollama resolves to its default endpoint');
    ls.setItem('taguette_config', JSON.stringify({version: 1, keys: [],
      tasks: {embeddings: {source: 'local:laya', url: '', token: '', model: ''}}}));
    assert(sugLoadConfig() === null, 'a local service without an embeddings '
           + 'path cannot resolve for embeddings');
    ls.setItem('taguette_config', JSON.stringify({version: 1, keys: [],
      tasks: {segmentation: {source: 'local:ollama_chat', url: '', token: '',
                             model: 'llama3.1'}}}));
    seg_cfg = tagAiLLMConfig('segmentation');
    assert(seg_cfg && seg_cfg.url
           === 'http://localhost:11434/v1/chat/completions'
           && seg_cfg.model === 'llama3.1',
           'local chat services resolve for segmentation');
    ls.setItem('taguette_config', JSON.stringify({version: 1, keys: [],
      tasks: {embeddings: {source: '', url: '', token: '', model: ''},
              segmentation: {source: '', url: '', token: '', model: ''}}}));
    assert(sugLoadConfig() === null, 'off embeddings resolves to null');
    assert(tagAiLLMConfig('segmentation') === null,
           'off segmentation resolves to null');
  } finally {
    if(saved_store !== null) {
      ls.setItem('taguette_config', saved_store);
    } else {
      ls.removeItem('taguette_config');
    }
  }

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
