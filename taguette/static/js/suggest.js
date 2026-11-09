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

var SUG_ALGO_OPTIONS = ['textrank', 'lexrank', 'yake', 'rake', 'segmented'];

// Textless UI chrome inserted into the document text (speaker badges from
// this file, section separators from segments-ui.js). Edit/offset walks skip
// it and teardown removes it
var SUG_MARKER_SELECTOR = '.sug-speaker-badge, .seg-separator';

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
  // Unbracketed timestamp + name-like label, either order: "0:00 - Huw
  // Evans (kayaguides.com)", "Speaker 1  0:03", "Maria Silva - 00:12:34"
  return sugTimedLabel(t) !== null;
}

// Lowercase words allowed inside a name ("Maria da Silva")
var SUG_NAME_PARTICLES = {da: 1, de: 1, di: 1, 'do': 1, dos: 1, das: 1,
                          del: 1, della: 1, van: 1, von: 1, der: 1, den: 1,
                          la: 1, le: 1, du: 1, bin: 1, al: 1, e: 1};

// Short name-like label: <= 6 words outside parentheses, each capitalized,
// a digit ("Speaker 1") or a name particle; parenthesized affiliations
// ("(kayaguides.com)") are allowed. Rejects ordinary sentences
// ("We met at", "and then at").
function sugNameLike(label) {
  var bare = label.replace(/\([^()]*\)/g, ' ').trim();
  if(!bare || /[()[\]:]/.test(bare)) {
    return false;
  }
  var words = bare.split(/\s+/);
  if(words.length > 6) {
    return false;
  }
  for(var i = 0; i < words.length; ++i) {
    var w = words[i], c = w.charAt(0);
    if(/[0-9]/.test(c) || (c !== c.toLowerCase())) {
      continue;
    }
    if(i > 0 && SUG_NAME_PARTICLES[w]) {
      continue;
    }
    return false;
  }
  return /[A-Za-zÀ-ɏͰ-῿_]/.test(bare);
}

// Line made of an unbracketed (or bracketed) timestamp and a name-like
// label, in either order, with an optional dash separator. Returns the
// label without its parenthesized affiliation, or null.
function sugTimedLabel(line) {
  var t = line.trim();
  if(t.length === 0 || t.length > 80) {
    return null;
  }
  var ts = '[\\[(]?' + SUG_TS + '[\\])]?';
  var sep = '(?:\\s*[-\\u2013\\u2014|]\\s*|\\s+)';
  var m = new RegExp('^' + ts + sep + '(.+?)\\s*:?$').exec(t)
    || new RegExp('^(.+?)' + sep + ts + '\\s*:?$').exec(t);
  if(!m || !sugNameLike(m[1])) {
    return null;
  }
  var lab = m[1].replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return lab || null;
}

// Inline speaker label opening a line: "NAME:", "NAME [00:12]:",
// "[00:12] NAME:" — the label before the colon. Lines whose whole text is
// just such a label are prefix lines (sugIsPrefixLine); this also matches
// label + spoken text on one line ("John: hello there").
function sugInlineLabelMatch(line) {
  var m = new RegExp('^\\s*(?:[\\[]\\s*' + SUG_TS + '\\s*[\\]])?\\s*'
    + '([^\\n:()[\\]]{1,40}?)\\s*(?:[\\[]\\s*' + SUG_TS
    + '\\s*[\\]])?\\s*:(?!\\d{2})').exec(line);
  if(!m) {
    return null;
  }
  var lab = (m[1] || '').trim();
  return (lab && /[A-Za-z\u00c0-\u024f\u0370-\u1fff_]/.test(lab))
    ? {label: lab, length: m[0].length} : null;
}

function sugInlineLabel(line) {
  var m = sugInlineLabelMatch(line);
  return m ? m.label : null;
}

// Timed inline label opening a line ("0:57 - Huw Evans: Wonderful.",
// "[00:12] Maria Silva (Acme): ..."): the unbracketed/bracketed timestamp,
// an optional dash and a name-like label up to the colon. Returns
// {label, length} (length = chars up to and including the colon) or null.
function sugTimedInlineMatch(line) {
  var m = new RegExp('^\\s*[\\[(]?' + SUG_TS + '[\\])]?'
    + '(?:\\s*[-\\u2013\\u2014|]\\s*|\\s+)([^\\n:]{1,60}?)\\s*:(?!\\d{2})')
    .exec(line);
  if(!m || !sugNameLike(m[1])) {
    return null;
  }
  var lab = m[1].replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return lab ? {label: lab, length: m[0].length} : null;
}

// Any speaker label a line carries, including the standalone forms
// ("NAME [00:20]", "[00:12] NAME") that only appear on lines of their own.
// Permissive — it feeds the pre-scan hint, never a decision on its own.
function sugPrefixLabel(line) {
  var lab = sugTimedLabel(line) || sugInlineLabel(line);
  if(lab) {
    return lab;
  }
  var tim = sugTimedInlineMatch(line);
  if(tim) {
    return tim.label;
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

// The label part of a block: its folded prefix line when it has one (in
// rendered documents paragraphs are not newline-separated in plainText, so
// the "first line" would run on into the speech), else its first line
function sugTurnHead(b) {
  if(b.contentStart !== undefined && b.contentStart > b.start) {
    return b.text.slice(0, b.contentStart - b.start).trim();
  }
  return b.text.split('\n', 1)[0];
}

// Absorb continuation paragraphs into the open speaker turn: a turn
// starts at a prefix line (speaker/timestamp label on its own line) or at
// a line beginning with a speaker label ("John: …"), and runs until the
// next turn start — the common transcript layout where one label opens
// several paragraphs. Text before the first label stays standalone.
// Offsets index the same plainText, so highlight byte offsets stay valid.
//
// Only corroborated starts absorb: the label line carries a timestamp, or
// its label recurs elsewhere in the document. A one-off label-looking line
// (a header such as "VIEW RECORDING - 119 mins:", a sentence ending in a
// colon) closes the open turn but stands alone, so a single false
// positive can never swallow the rest of the document.
function sugAbsorbContinuations(blocks, plain) {
  var tsRe = new RegExp(SUG_TS);
  var info = blocks.map(function(b) {
    var first = sugTurnHead(b);
    var candidate = (b.contentStart !== undefined)
      || sugIsPrefixLine(b.text)
      || !!sugTimedLabel(first)
      || !!sugInlineLabel(first)
      || !!sugTimedInlineMatch(first);
    if(!candidate) {
      return null;
    }
    var label = sugPrefixLabel(first);
    return {timed: tsRe.test(first),
            key: label ? label.toLowerCase() : null};
  });
  var counts = {};
  info.forEach(function(c) {
    if(c && c.key) {
      counts[c.key] = (counts[c.key] || 0) + 1;
    }
  });
  var turns = [];
  var open = null;
  blocks.forEach(function(b, i) {
    var c = info[i];
    if(!c && open) {
      open.end = b.end; // continuation paragraph
      open.text = plain.slice(open.start, open.end);
      return;
    }
    turns.push({start: b.start, end: b.end,
                contentStart: (b.contentStart !== undefined)
                  ? b.contentStart : b.start,
                text: plain.slice(b.start, b.end)});
    var strong = c && (c.timed || (c.key && counts[c.key] >= 2));
    open = strong ? turns[turns.length - 1] : null;
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
  return sugBlocksFrom(document.getElementById('document-contents'),
                       sug_session.plainText);
}

// The same walk over any root holding the document's chunks (the open
// document, or a detached copy of another one)
function sugBlocksFrom(root, plain) {
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

// Where the spoken text of a turn starts (absolute char index in plainText):
// after its merged prefix line, or after an inline label ("John: ...",
// "0:57 - Huw Evans: Wonderful."), skipping the whitespace that follows. A
// turn without a label returns turn.start; a turn that is only a prefix line
// returns turn.end. Uses the same detection as the turn building above.
function sugTurnLabelEnd(turn) {
  var text = turn.text || '';
  var rel = 0;
  if(turn.contentStart !== undefined && turn.contentStart > turn.start) {
    rel = turn.contentStart - turn.start;
  } else {
    var nl = text.indexOf('\n');
    var first = nl < 0 ? text : text.slice(0, nl);
    var m = sugTimedInlineMatch(first);
    if(m) {
      rel = m.length;
    } else if(nl < 0 && sugIsPrefixLine(first)) {
      rel = text.length; // a lone prefix line with no content after it
    } else {
      m = sugInlineLabelMatch(first);
      if(m && m.label.split(/\s+/).length <= 4 && !/[,.;!?]/.test(m.label)
         && sugNameLike(m.label)) {
        rel = m.length;
      }
    }
  }
  while(rel < text.length && /\s/.test(text.charAt(rel))) {
    ++rel;
  }
  return turn.start + Math.min(rel, text.length);
}

// Label ranges [{s, e}) of all turns (sorted, non-empty)
function sugLabelRanges(turns) {
  var out = [];
  (turns || []).forEach(function(t) {
    var e = sugTurnLabelEnd(t);
    if(e > t.start) {
      out.push({s: t.start, e: e});
    }
  });
  return out.sort(function(a, b) { return a.s - b.s; });
}

// Speaker labels are never part of a suggestion (the Speakers popup already
// shows them): char-offset candidates have their starts/ends moved out of the
// label ranges, and a label strictly inside a candidate splits it in two.
// Pieces keep the candidate's fields; changed pieces under 3 words are
// dropped. No ranges: the candidates are returned untouched.
function sugTrimToSpeech(cands, ranges, text) {
  if(!ranges || !ranges.length) {
    return cands;
  }
  var wordCount = function(a, b) {
    return text.slice(a, b).split(/\s+/).filter(Boolean).length;
  };
  var out = [];
  cands.forEach(function(c) {
    var pieces = [[c.start, c.end]];
    var changed = false;
    for(var i = 0; i < ranges.length; ++i) {
      var r = ranges[i];
      if(r.s >= c.end) {
        break;
      }
      if(r.e <= c.start) {
        continue;
      }
      var next = [];
      for(var j = 0; j < pieces.length; ++j) {
        var a = pieces[j][0], b = pieces[j][1];
        if(r.e <= a || r.s >= b) {
          next.push([a, b]);
          continue;
        }
        changed = true;
        if(r.s > a) { // text before the label
          var e1 = r.s;
          while(e1 > a && /\s/.test(text.charAt(e1 - 1))) { --e1; }
          if(e1 > a) { next.push([a, e1]); }
        }
        if(r.e < b) { // text after the label
          var s2 = r.e;
          while(s2 < b && /\s/.test(text.charAt(s2))) { ++s2; }
          if(s2 < b) { next.push([s2, b]); }
        }
      }
      pieces = next;
    }
    if(!changed) {
      out.push(c);
      return;
    }
    pieces.forEach(function(pc) {
      if(wordCount(pc[0], pc[1]) < 3) {
        return;
      }
      var o = {};
      for(var k in c) { o[k] = c[k]; }
      if(c.tags) { o.tags = c.tags.slice(); }
      if(c.ticked) { o.ticked = c.ticked.slice(); }
      o.start = pc[0];
      o.end = pc[1];
      out.push(o);
    });
  });
  return out;
}

// Local pre-scan (no LLM): count repeated candidate speaker labels on the
// turns' first lines, and how many turns carry one. A hint for the model
// and the basis for building speakers by hand.
function sugPreScanPrefixes(turns) {
  var counts = {};
  var covered = 0;
  turns.forEach(function(b) {
    var label = sugPrefixLabel(sugTurnHead(b));
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
function sugIsExcludedSpan(start, end, ctx) {
  ctx = ctx || sug_session;
  var turns = (ctx && ctx.turns) || null;
  if(!turns || !ctx.speakers) {
    return false;
  }
  var excluded = {};
  var any = false;
  ctx.speakers.forEach(function(s) {
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

/*
 * Segment-based suggestions ('segmented' algorithm)
 *
 * Unlike the lexical algorithms, running it is asynchronous (embeddings and
 * decisions over the network, possibly tens of seconds the first time) and
 * the candidates carry extra fields: tags [{id, name, conf, source}],
 * section_id and ticked [tagId]. The slider is a plain display filter, like
 * in the other modes: units are ranked by a score (see segUnitsAsCandidates),
 * lexPct is the percentile rank among the document's units and the cut-off
 * keeps those at or above it. Moving it never re-runs the analysis.
 */

var SUG_SEG_VERSION = 0; // bumped to invalidate the segmented candidates cache

function sugSegCacheKey() {
  // segResultKey(): text, speakers, guide, section params, manual edits (the
  // cached units are only valid for the inputs they were computed from)
  var rk = (typeof segResultKey === 'function') ? segResultKey() : '';
  return 'segmented|' + rk + '|v' + SUG_SEG_VERSION;
}

// Pre-tick threshold of the configured segmentation parameters
function sugSegTheta() {
  return (typeof segParams === 'function') ? segParams().theta : 0.6;
}

// Does any pane of the current session use the segmented algorithm?
function sugHasSegmentedPane() {
  if(!sug_session) {
    return false;
  }
  return sugPaneKeys().some(function(k) {
    return sug_session.panes[k] && sug_session.panes[k].algo === 'segmented';
  });
}

// Tags worth showing in the menu / picker: at or above the lower edge of the
// uncertainty band (below it the tag is judged not to apply), plus any that
// are pre-ticked. unit.tags itself stays complete.
function sugSegShownTags(list, ticked) {
  var low = (typeof segParams === 'function') ? segParams().band_low : 0.4;
  return (list || []).filter(function(t) {
    return t.conf >= low || (ticked || []).indexOf(t.id) !== -1;
  });
}

// Number of tags of a suggestion at or above the tick threshold
function sugSegTagCount(s, theta) {
  var n = 0;
  (s.tags || []).forEach(function(t) {
    if(t.conf >= theta) {
      ++n;
    }
  });
  return n;
}

// Run (or reuse) the segmentation for the session and return the candidates
// (char offsets). Concurrent callers share one run. Resolves with null when
// the session moved on in the meantime.
function sugSegCandidates() {
  var sess = sug_session;
  if(!sess) {
    return Promise.resolve(null);
  }
  if(typeof segAnalyzeDocument !== 'function'
     || typeof segUnitsAsCandidates !== 'function') {
    return Promise.reject(new Error(
      gettext('Segment-based coding is not available.')));
  }
  var gen = sess.editGen || 0;
  if(!sess.segPending || sess.segPending.gen !== gen) {
    // Latest request wins: an older one never writes sess.segResult
    var seq = sess.segSeq = (sess.segSeq || 0) + 1;
    var prom;
    try {
      prom = Promise.resolve(segAnalyzeDocument({}));
    } catch(error) {
      prom = Promise.reject(error);
    }
    var pending = {gen: gen};
    pending.promise = prom.then(function(result) {
      if(sug_session !== sess || (sess.editGen || 0) !== gen
         || sess.segSeq !== seq) {
        return null;
      }
      sess.segResult = result;
      return {cands: segUnitsAsCandidates(result, sugSegTheta())};
    }, function(err) {
      if(err && err.stale) {
        return null;   // superseded by a newer run (segments-ui.js)
      }
      throw err;
    });
    var clear = function() {
      if(sess.segPending === pending) {
        sess.segPending = null;
      }
    };
    pending.promise.then(clear, clear);
    sess.segPending = pending;
  }
  return sess.segPending.promise.then(function(out) {
    // Each caller gets its own copies (the candidates are mutated later)
    return out && {cands: out.cands.map(function(c) {
      var o = {};
      for(var k in c) { o[k] = c[k]; }
      o.tags = (c.tags || []).slice();
      o.ticked = (c.ticked || []).slice();
      return o;
    })};
  });
}

// Called by the Sections panel after manual edits: the segmentation changed,
// drop the cached candidates and recompute the segmented panes
function sugRecomputeSegmented() {
  if(!sug_session) {
    return;
  }
  ++SUG_SEG_VERSION;
  sug_session.segResult = null;
  sug_session.segPending = null;
  sug_session.segSeq = (sug_session.segSeq || 0) + 1;
  sugPaneKeys().forEach(function(k) {
    if(sug_session.panes[k].algo === 'segmented') {
      sugComputePane(k);
    }
  });
}

// Char-offset candidates -> clamped, byte-offset candidates (in place)
function sugCandidatesToBytes(cands, text, boc) {
  for(var i = 0; i < cands.length; ++i) {
    var cStart = Math.max(0, Math.min(cands[i].start, text.length));
    var cEnd = Math.max(cStart + 1, Math.min(cands[i].end, text.length));
    cands[i].cStart = cStart;
    cands[i].cEnd = cEnd;
    cands[i].start = boc[cStart];
    cands[i].end = boc[cEnd];
  }
  return cands.filter(function(c) { return c.end - c.start >= 3; });
}

SUG_ALGOS.segmented = {
  label: gettext('Segment-based coding'),
  running: gettext('Segmenting the document (this can take a while)...'),
  // Asynchronous: resolves with char-offset candidates (or null if stale)
  run: function(text) {
    return sugSegCandidates().then(function(out) {
      return out ? out.cands : null;
    });
  },
};

function sugPercentiles(cands) {
  var sorted = cands.slice().sort(function(a, b) { return a.raw - b.raw; });
  var n = sorted.length;
  for(var i = 0; i < n; ++i) {
    sorted[i].lexPct = n > 1 ? i / (n - 1) : 1;
  }
  return cands;
}

// ctx: anything with the session's fields (the session itself, or a context
// built by the highlight tuning); defaults to the session
function sugCutoff(pct, ctx) {
  ctx = ctx || sug_session;
  var v = ctx ? ctx.aggressiveness : 50;
  // Full range: v=0 keeps only the single best candidate, v=100 keeps ~99%
  return 1.0 - 0.99 * (v / 100);
}

// Effective centrality used for cut-off and shading
function sugEffPct(cand, ctx) {
  ctx = ctx || sug_session;
  if(ctx && ctx.useEmbeddings
     && typeof cand.embPct === 'number') {
    return (cand.lexPct + cand.embPct) / 2;
  }
  return cand.lexPct;
}

var SUG_MERGE_OWN = {start: 1, end: 1, raw: 1, lexPct: 1, embPct: 1,
                     cStart: 1, cEnd: 1, _vec: 1};

// Merge overlapping candidates (union span, max raw score); merely adjacent
// candidates are kept separate
function sugMergeOverlaps(cands) {
  cands.sort(function(a, b) { return a.start - b.start || b.end - a.end; });
  var out = [];
  for(var i = 0; i < cands.length; ++i) {
    var last = out.length ? out[out.length - 1] : null;
    if(last && cands[i].start < last.end) {
      if(cands[i].raw > last.raw) {
        // Extra fields (tags, section_id, ticked, ...) follow the higher score
        for(var key in cands[i]) {
          if(!(key in SUG_MERGE_OWN)) {
            last[key] = cands[i][key];
          }
        }
      }
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
  return sugBuildPlainIndexOf(document.getElementById('document-contents'),
                              chunk_offsets);
}

// Same, over any root holding the chunks (ids doc-offset-*), with the base
// byte offset of each chunk in DOM order
function sugBuildPlainIndexOf(root, offsets) {
  var parts = [];
  var byteOfChar = [0];
  var nodes = root.querySelectorAll('[id^="doc-offset-"]');
  for(var i = 0; i < nodes.length; ++i) {
    var node = nodes[i];
    // Bases come from chunk_offsets (same DOM order) rather than the ids:
    // in-session transcript edits shift the virtual byte space, while the
    // ids keep the server's original anchors
    var base = offsets[i] || 0;
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
function sugClusterK(n, ctx) {
  var kmax = Math.max(2, Math.min(16, Math.floor(n / 2)));
  if(kmax < 2) {
    return 1;
  }
  ctx = ctx || sug_session;
  var v = ctx ? ctx.aggressiveness : 50;
  return Math.max(1, Math.min(kmax, Math.round(2 + (v / 100) * (kmax - 2))));
}

// Suggestions kept per theme from the aggressiveness slider
function sugClusterPer(ctx) {
  ctx = ctx || sug_session;
  var v = ctx ? ctx.aggressiveness : 50;
  return Math.min(4, 1 + Math.floor(v / 25));
}

// (Re-)cluster one pane's candidates by their embeddings and label the
// clusters (T1 = theme with the most representative passage)
function sugReclusterPane(pkey) {
  var pane = sug_session.panes[pkey];
  pane.clusterLabels = sugClusterCands(pane.candidates, sug_session);
}

// Cluster candidates (those with vectors) in place (c.cluster, c.clSim) and
// return their labels {cluster: 'T1', ...}; ctx.aggressiveness sets k
function sugClusterCands(cands, ctx) {
  var labels = {};
  var clustered = [];
  (cands || []).forEach(function(c) {
    delete c.cluster;
    delete c.clSim;
    if(c._vec) {
      clustered.push(c);
    }
  });
  if(clustered.length < 3) {
    return labels; // too few vectors to cluster meaningfully
  }
  var vecs = clustered.map(function(c) { return sugNormalize(c._vec); });
  var result = sugKMeans(vecs, sugClusterK(clustered.length, ctx));
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
    labels[order[i]] = 'T' + (i + 1);
  }
  return labels;
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

// Drop a pane's candidates and suggestions without touching the saved
// per-algorithm suggestion state
function sugClearPane(pkey) {
  var pane = sug_session.panes[pkey];
  pane.candidates = null;
  pane.candAlgo = null;
  pane.suggestions = [];
  sugRenderPane(pkey);
}

// Turn raw algorithm output (char offsets) into pane candidates
function sugFinishCandidates(cands, text, boc, ctx) {
  // Speaker labels are never highlighted, whatever the algorithm
  ctx = ctx || sug_session;
  var turns = null;
  try {
    turns = (ctx && ctx.turns) || sugSpeakerTurns();
  } catch(error) {
    console.error('Could not detect speaker labels:', error);
  }
  if(turns && turns.length) {
    cands = sugTrimToSpeech(cands, sugLabelRanges(turns), text);
  }
  cands = sugCandidatesToBytes(cands, text, boc);
  sugPercentiles(cands);
  return sugMergeOverlaps(cands);
}

// Run a synchronous algorithm over ctx.plainText (char-offset candidates);
// ctx supplies the transcription mode and sentences, so this never reads
// the session. YAKE/RAKE keyphrases optionally expand to their sentence.
function sugRunAlgoCands(algo_name, ctx, expand) {
  var saved = SUG_TRANSCRIPTION;
  SUG_TRANSCRIPTION = !!ctx.transcription;
  var cands;
  try {
    cands = SUG_ALGOS[algo_name].run(ctx.plainText);
  } finally {
    SUG_TRANSCRIPTION = saved;
  }
  if((algo_name === 'yake' || algo_name === 'rake') && expand) {
    // Show the whole sentence/turn containing each keyphrase
    cands = sugExpandToSentences(cands, ctx.sentences);
  }
  return cands;
}

// Compute (or load from cache) the suggestions for one pane. Algorithms may
// run synchronously or return a Promise of candidates (char offsets); stale
// results (algorithm switched, session ended, transcript edited, a newer run
// of the same pane) are ignored.
function sugComputePane(pkey) {
  var pane = sug_session && sug_session.panes[pkey];
  if(!pane) {
    return; // pane may have disappeared while a computation was queued
  }
  var algo = SUG_ALGOS[pane.algo];
  var algo_name = pane.algo;
  var akey = sugAlgoCacheKey(pane.algo);
  var ckey = algo_name === 'segmented' ? sugSegCacheKey() : akey;
  var doc_cache = SUG_ALGO_CACHE[current_document];
  if(!doc_cache) {
    doc_cache = SUG_ALGO_CACHE[current_document] = {};
  }
  var sess = sug_session;
  var gen = sess.editGen || 0;
  var token = pane.runToken = (pane.runToken || 0) + 1;
  var live = function() {
    return sug_session === sess && sess.panes[pkey] === pane
      && pane.runToken === token && pane.algo === algo_name
      && (sess.editGen || 0) === gen;
  };
  var done = function() {
    if(!live()) {
      return; // superseded: a transcript edit, algorithm switch or newer run
    }
    pane.candAlgo = algo_name;
    // Restore the suggestions the user adjusted for this algorithm, if any
    if(pane.savedSuggestions && pane.savedSuggestions[akey]) {
      pane.suggestions = pane.savedSuggestions[akey];
    }
    sugRefilterPane(pkey);
    if(sug_session.useEmbeddings && algo_name !== 'segmented') {
      sugEnhanceEmbeddings();
    } else {
      sugSetStatus(sugStatusText());
    }
    sugUpdateSliderFeedback();
  };
  if(doc_cache[ckey]) {
    // Cache hit: no recompute, embedding scores kept on the candidates
    pane.candidates = doc_cache[ckey];
    done();
    return;
  }
  var store = function(cands) {
    cands = sugFinishCandidates(cands, sess.plainText, sess.byteOfChar);
    if(algo_name === 'segmented') {
      Object.keys(doc_cache).forEach(function(k) {
        if(k.indexOf('segmented|') === 0) {
          delete doc_cache[k]; // other slider settings / versions
        }
      });
    }
    pane.candidates = cands;
    doc_cache[ckey] = cands;
    done();
  };
  sugSetStatus(algo.running
    || gettext('Running %(algo)s...', {algo: algo.label}));
  if(algo_name === 'segmented') {
    if(pane.candAlgo !== algo_name) {
      // Don't show another algorithm's candidates as segment suggestions
      // while the (slow) first analysis runs
      sugClearPane(pkey);
    }
    var promise;
    try {
      promise = Promise.resolve(algo.run(sess.plainText));
    } catch(error) {
      promise = Promise.reject(error);
    }
    promise.then(function(cands) {
      if(!live() || !cands) {
        return;
      }
      store(cands);
    }, function(error) {
      if(!live()) {
        return;
      }
      console.error('Suggestion algorithm failed:', error);
      sugClearPane(pkey);
      sugSetStatus((error && error.message) || gettext('Algorithm failed (see console)'));
    });
    return;
  }
  // setTimeout so the status actually paints
  window.setTimeout(function() {
    if(!live()) {
      return; // session ended or algorithm switched while computing
    }
    var cands;
    try {
      cands = sugRunAlgoCands(algo_name, sess, sess.expand);
    } catch(error) {
      console.error('Suggestion algorithm failed:', error);
      sugSetStatus(gettext('Algorithm failed (see console)'));
      return;
    }
    store(cands);
  }, 10);
}

function sugStatusText() {
  var n = 0, themes = 0;
  var seg_n = 0, seg_sections = {};
  sugPaneKeys().forEach(function(k) {
    var seen = {};
    sug_session.panes[k].suggestions.forEach(function(s) {
      ++n;
      if(sug_session.panes[k].algo === 'segmented') {
        ++seg_n;
        seg_sections[s.section_id === undefined ? '' : s.section_id] = true;
      }
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
  if(seg_n > 0 && seg_n === n) {
    return gettext('%(n)s suggestions in %(s)s segments',
                   {n: n, s: Object.keys(seg_sections).length}) + suffix;
  }
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

// Drop the candidates (byte offsets) of which at least half lies inside
// accepted (staged) highlights
function sugDropStagedOverlaps(cands, staged) {
  staged = staged || [];
  if(!staged.length) {
    return cands;
  }
  return cands.filter(function(c) {
    var len = c.end - c.start, ov = 0;
    if(len <= 0) {
      return true;
    }
    for(var i = 0; i < staged.length; ++i) {
      ov += Math.max(0, Math.min(c.end, staged[i].end)
                        - Math.max(c.start, staged[i].start));
    }
    return ov * 2 < len;
  });
}

// The slider's selection, as a pure function of the candidates and the
// settings (so the UI and the highlight tuning share one implementation).
// all_cands: pane candidates (byte + char offsets, scores). opts:
//   algo, rankMode, aggressiveness, useEmbeddings,
//   clusterLabels (cluster mode: the labels from sugClusterCands),
//   isExcluded(c) -> true to drop (speakers hidden), staged (accepted spans).
// Returns [{c, sortPct, lexPct, embPct}] ordered by position.
function sugSelectShown(all_cands, opts) {
  var cands = all_cands;
  if(opts.isExcluded) {
    cands = cands.filter(function(c) {
      return !opts.isExcluded(c);
    });
  }
  // Passages the user already accepted do not come back as suggestions
  cands = sugDropStagedOverlaps(cands, opts.staged);
  // Selection: either per-theme top-m (cluster mode with vectors), or the
  // percentile cut-off over effective centrality
  var entries; // [{c, sortPct, lexPct, embPct}]
  var ctx = {aggressiveness: opts.aggressiveness,
             useEmbeddings: opts.useEmbeddings};
  var groups = null;
  var is_seg = opts.algo === 'segmented';
  if(!is_seg && opts.rankMode === 'cluster'
     && opts.clusterLabels && Object.keys(opts.clusterLabels).length) {
    var per = sugClusterPer(ctx);
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
    // Segment units: at 100 everything shows (coverage first), and there is
    // no cap on the number of suggestions
    var cutoff = (is_seg && opts.aggressiveness >= 100)
      ? 0 : sugCutoff(undefined, ctx);
    entries = cands
      .map(function(c) {
        return {c: c, sortPct: sugEffPct(c, ctx), lexPct: c.lexPct,
                embPct: (typeof c.embPct === 'number') ? c.embPct : null};
      })
      .filter(function(e) { return e.sortPct >= cutoff; });
    if(!is_seg && entries.length > 80) {
      entries.sort(function(a, b) { return b.sortPct - a.sortPct; });
      entries = entries.slice(0, 80);
    }
    entries.sort(function(a, b) { return a.c.start - b.c.start; });
  }
  return entries;
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
  var any_excluded = false;
  (sug_session.speakers || []).forEach(function(s) {
    if(s.include === false) {
      any_excluded = true;
    }
  });
  var entries = sugSelectShown(pane.candidates, {
    algo: pane.algo,
    rankMode: sug_session.rankMode,
    aggressiveness: sug_session.aggressiveness,
    useEmbeddings: sug_session.useEmbeddings,
    clusterLabels: pane.clusterLabels,
    isExcluded: any_excluded ? function(c) {
      return sugIsExcludedSpan(c.cStart, c.cEnd);
    } : null,
    staged: sug_session.staged || [],
  });
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
      if(c.tags) {
        s.tags = c.tags;
        s.section_id = c.section_id;
        if(!s.tickedEdited) {
          s.ticked = (c.ticked || []).slice();
        }
      }
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
      tags: c.tags,
      section_id: c.section_id,
      ticked: c.ticked ? c.ticked.slice() : undefined,
    };
  });
  stash();
  sugRenderPane(pkey);
  sugSegPanelRefresh();
}

// The Sections panel counts the suggestions of the segmented panes and the
// accepted highlights: redraw it when those change
function sugSegPanelRefresh() {
  if(typeof segRenderSections === 'function') {
    try {
      segRenderSections();
    } catch(error) {
      console.error('segRenderSections failed:', error);
    }
  }
}

// Plan the embedding scoring of candidates (char offsets cStart/cEnd into
// ctx.plainText): which texts still need a vector (`missing`, the candidates'
// plus up to 200 sentences for the document centroid), fill(vectors) to
// store what was fetched, and score() to set _vec and the centroid percentile
// embPct on every candidate (they are normalized over all of them together).
// Needs only ctx.plainText and ctx.sentences, never the session. doc_key
// identifies the document for the centroid cache.
function sugEmbedPlan(all_c, ctx, emb_key, doc_key) {
  var emb_cache = SUG_EMB_CACHE[emb_key] || (SUG_EMB_CACHE[emb_key] = {});
  var cand_texts = all_c.map(function(c) {
    return ctx.plainText.substring(c.cStart, c.cEnd);
  });

  // Centroid from up to 200 sentences (their vectors are cached too, so this
  // is a network no-op after the first time)
  var cent_key = doc_key + '|' + emb_key;
  var centroid = SUG_CENTROID_CACHE[cent_key];
  var cent_texts = [];
  if(!centroid) {
    var sentences = ctx.sentences;
    var step = Math.max(1, Math.ceil(sentences.length / 200));
    for(var i = 0; i < sentences.length; i += step) {
      cent_texts.push(sentences[i].text);
    }
  }

  var missing = [];
  var seen = Object.create(null);
  var add_missing = function(t) {
    if(!emb_cache[t] && !seen[t]) {
      seen[t] = true;
      missing.push(t);
    }
  };
  cand_texts.forEach(add_missing);
  cent_texts.forEach(add_missing);

  return {
    missing: missing,
    fill: function(embs) {
      for(var i = 0; i < missing.length; ++i) {
        emb_cache[missing[i]] = embs[i];
      }
    },
    score: function() {
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
    },
  };
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
  // All candidates across panes; percentiles are normalized over all of them
  // so the two split-screen panes stay comparable
  var all_c = [];
  sugPaneKeys().forEach(function(pkey) {
    if(sug_session.panes[pkey].algo === 'segmented') {
      return; // scored by the segmentation itself
    }
    (sug_session.panes[pkey].candidates || []).forEach(function(c) {
      all_c.push(c);
    });
  });
  if(!all_c.length) {
    sugRefilter(); // only segment-based panes: nothing to score
    return;
  }
  var plan = sugEmbedPlan(all_c, sug_session, emb_key, current_document);
  var missing = plan.missing;

  var score = function() {
    plan.score();
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
    plan.fill(embs);
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
    if(s.tags && s.tags.length && wrapped.first) {
      // Tag-count badge: CSS-generated content, like the theme badge
      var n_tags = sugSegTagCount(s, sugSegTheta());
      if(n_tags > 0) {
        wrapped.first.setAttribute('data-tag-count', n_tags);
      }
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

// Tag ids (ints) of `ids` that still exist in the global tags
function sugKnownTagIds(ids) {
  var out = [];
  (ids || []).forEach(function(id) {
    id = parseInt(id, 10);
    if(!isNaN(id) && tags['' + id] && out.indexOf(id) === -1) {
      out.push(id);
    }
  });
  return out;
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
  if(s.tags && s.tags.length) {
    // Segment-based suggestion: the ticked tags become the highlight's tags
    // (tags deleted meanwhile are skipped)
    st.tags = sugKnownTagIds(s.ticked);
    st.suggestedTags = sugSegShownTags(s.tags, s.ticked).filter(function(t) {
      return !!tags['' + t.id];
    });
    st.ticked = (s.ticked || []).slice();
    st.section_id = s.section_id;
  }
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
      tags: st.suggestedTags,
      section_id: st.section_id,
      ticked: st.ticked ? st.ticked.slice() : undefined,
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
  if(sug_session) {
    sugSegPanelRefresh();
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
  if(bracket && bracket.hasAttribute('data-aid')) {
    sugStartStagedDrag(e, bracket);
    return;
  }
  if(!bracket || !bracket.hasAttribute('data-sid')) {
    return;
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


// Index of the character boundary nearest to `byte` (byteOfChar is the
// cumulative UTF-8 byte offset of every character boundary)
function sugCharOfByte(boc, byte) {
  var lo = 0, hi = boc.length - 1;
  if(byte <= boc[0]) {
    return 0;
  }
  if(byte >= boc[hi]) {
    return hi;
  }
  while(hi - lo > 1) {
    var mid = (lo + hi) >> 1;
    if(boc[mid] <= byte) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (byte - boc[lo] <= boc[hi] - byte) ? lo : hi;
}

// Move one boundary of an accepted highlight to the byte offset `byte`.
// range: {cStart, cEnd} (character offsets); others: [{start, end}] in bytes
// (other accepted highlights and saved ones); boc: byteOfChar. The boundary
// snaps to a character boundary, keeps at least `min_gap` characters in the
// range and never enters another highlight that lies on its side of the
// range. Returns {cStart, cEnd, start, end} (byte offsets from boc).
function sugResizeRange(range, which, byte, others, boc, min_gap) {
  min_gap = min_gap === undefined ? 3 : min_gap;
  var c = sugCharOfByte(boc, byte);
  var cs = range.cStart, ce = range.cEnd;
  var i, o, os, oe;
  if(which === 'start') {
    var lo = 0;
    for(i = 0; i < others.length; ++i) {
      oe = sugCharOfByte(boc, others[i].end);
      if(oe <= cs) {
        lo = Math.max(lo, oe);
      }
    }
    var hi = Math.max(lo, ce - min_gap);
    cs = Math.max(lo, Math.min(c, hi));
  } else {
    var top = boc.length - 1;
    for(i = 0; i < others.length; ++i) {
      os = sugCharOfByte(boc, others[i].start);
      if(os >= ce) {
        top = Math.min(top, os);
      }
    }
    var low = Math.min(top, cs + min_gap);
    ce = Math.min(top, Math.max(c, low));
  }
  return {cStart: cs, cEnd: ce, start: boc[cs], end: boc[ce]};
}

// Highlights an accepted highlight must not overlap: the other accepted
// ones and the saved ones (byte offsets)
function sugStagedObstacles(aid) {
  var out = [];
  sug_session.staged.forEach(function(o) {
    if(o.aid !== aid) {
      out.push({start: o.start, end: o.end});
    }
  });
  Object.keys(highlights).forEach(function(id) {
    out.push({start: highlights[id].start_offset,
              end: highlights[id].end_offset});
  });
  return out;
}

// Dragging a bracket of an accepted highlight moves that boundary
function sugStartStagedDrag(e, bracket) {
  var aid = parseInt(bracket.getAttribute('data-aid'), 10);
  var which = bracket.getAttribute('data-which');
  var st = null;
  sug_session.staged.forEach(function(x) { if(x.aid === aid) { st = x; } });
  if(!st || !sug_session.byteOfChar) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  sugHideMenu();
  var others = sugStagedObstacles(aid);
  var boc = sug_session.byteOfChar;
  sug_drag = {aid: aid, which: which, st: st, lastRender: 0};

  function mark() {
    var els = document.querySelectorAll(
      '.sug-bracket[data-aid="' + aid + '"][data-which="' + which + '"]');
    for(var i = 0; i < els.length; ++i) {
      els[i].classList.add('sug-dragging');
    }
  }

  function apply(b) {
    var r = sugResizeRange(st, which, b, others, boc);
    if(r.cStart === st.cStart && r.cEnd === st.cEnd) {
      return false;
    }
    st.cStart = r.cStart;
    st.cEnd = r.cEnd;
    st.start = r.start;
    st.end = r.end;
    return true;
  }

  function onMove(e2) {
    var b = sugCaretByte(e2.clientX, e2.clientY);
    if(b === null || !apply(b)) {
      return;
    }
    var now = Date.now();
    if(now - sug_drag.lastRender > 150) {
      sug_drag.lastRender = now;
      sugRenderStaged(st);
      mark();
    }
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    sug_drag = null;
    sugRenderStaged(st);
    // Suggestions now covered by the highlight drop; uncovered ones return
    sugRefilter();
    sugUpdateCounts();
  }

  mark();
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

// "Suggested tags" section of a segment-based suggestion's menu (empty when
// the unit has no tags), preceded by its section label
function sugSegMenuHtml(s) {
  var html = '';
  var sec = (typeof segSectionAt === 'function' && typeof s.cStart === 'number')
    ? segSectionAt(s.cStart) : null;
  if(sec && (sec.label || sec.name)) {
    html += '<div class="sug-menu-section text-muted small">' +
      escapeHtml(sec.label || sec.name) + '</div>';
  }
  var known = sugSegShownTags(s.tags, s.ticked).filter(function(t) {
    return !!tags['' + t.id];
  });
  if(known.length) {
    html += '<div class="sug-menu-suggtags">' +
      '<div class="sug-menu-subtitle">' + gettext('Suggested tags') + '</div>';
    known.forEach(function(t) {
      var on = (s.ticked || []).indexOf(t.id) !== -1;
      html += '<label class="' + (on ? '' : 'sug-tag-off') + '">' +
        '<input type="checkbox" data-tag-id="' + t.id + '"' +
        (on ? ' checked' : '') + '> ' + escapeHtml(tags['' + t.id].path) +
        ' <span class="text-muted">' + Math.round((t.conf || 0) * 100) +
        '%</span></label>';
    });
    html += '</div>';
  }
  return html;
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
    sugSegMenuHtml(s) +
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
  // Suggested tags: toggling updates the suggestion's ticked list
  var boxes = sugMenuEl().querySelectorAll('.sug-menu-suggtags input');
  for(var bi = 0; bi < boxes.length; ++bi) {
    boxes[bi].addEventListener('change', function(e) {
      var f = sugFindSuggestion(sid);
      if(!f) {
        return;
      }
      var tid = parseInt(e.target.getAttribute('data-tag-id'), 10);
      var ticked = (f.s.ticked || []).filter(function(x) { return x !== tid; });
      if(e.target.checked) {
        ticked.push(tid);
      }
      f.s.ticked = ticked;
      f.s.tickedEdited = true;
      e.target.parentNode.classList.toggle('sug-tag-off', !e.target.checked);
    });
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
  var tagLabel = function(id, path, extra) {
    return (
      '<label><input type="checkbox" value="' + id + '"' +
      (st.tags.indexOf(parseInt(id)) !== -1 ? ' checked' : '') + '> ' +
      escapeHtml(path) + (extra || '') + '</label>'
    );
  };
  // Tags suggested for this unit first (best confidence first), then the rest
  var suggested = {};
  (st.suggestedTags || []).slice().sort(function(a, b) {
    return (b.conf || 0) - (a.conf || 0);
  }).forEach(function(t) {
    if(tags['' + t.id]) {
      suggested['' + t.id] = true;
      html += tagLabel(t.id, tags['' + t.id].path,
        ' <span class="text-muted">' + Math.round((t.conf || 0) * 100) + '%</span>');
    }
  });
  if(Object.keys(suggested).length) {
    html += '<hr class="sug-menu-divider"/>';
  }
  entries.forEach(function(e) {
    if(!suggested[e[0]]) {
      html += tagLabel(e[0], e[1].path);
    }
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

// True when a click on `t` is outside the menu and the highlights. A menu
// button's handler may re-render the menu (innerHTML) while the click is still
// bubbling: its target is then detached, closest() finds no #sug-menu, and the
// click must not count as an outside click.
function sugClickIsOutsideMenu(t) {
  if(!t || !t.closest) {
    return false;
  }
  if(!document.documentElement.contains(t)) {
    return false; // removed from the DOM by a handler: it was inside the menu
  }
  return !(t.closest('#sug-menu') || t.closest('.sug-span')
           || t.closest('.hl-staged'));
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
  var sp_badges = document.querySelectorAll(SUG_MARKER_SELECTOR);
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
  // removeHighlight() also deletes the record: keep the objects to re-add
  var saved_highlights = ids.map(function(id) { return highlights[id]; });
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
  saved_highlights.forEach(function(h) { setHighlight(h); });
  sug_session.staged.forEach(sugRenderStaged);
  sugSpeakerRenderBlocks();
  if(typeof segRenderSeparators === 'function') {
    segRenderSeparators(); // separators were removed with the other markers
  }
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
        if(c.matches && c.matches(SUG_MARKER_SELECTOR)) {
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
        if(c.matches && c.matches(SUG_MARKER_SELECTOR)) {
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
  if(target.closest('.sug-menu') || target.closest(SUG_MARKER_SELECTOR)) {
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
  // removeHighlight() also deletes the record: keep the objects to re-add
  var saved_highlights = ids.map(function(id) { return highlights[id]; });
  ids.forEach(removeHighlight);
  saved_highlights.forEach(function(h) { setHighlight(h); });
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
  sug_session.segResult = null;
  sug_session.segPending = null;
  // Before the panes recompute: the segmented run must see the invalidation
  if(typeof segOnRebuild === 'function') {
    segOnRebuild();
  }
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
  ++SUG_SEG_VERSION; // never reuse segmented candidates of an earlier session
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
  // Auto (the combination tuned on this project's highlights) is remembered
  // like the algorithm choice, as long as there are results to apply
  var stored_tune = sugTuneStored();
  var saved_algo = null;
  try {
    saved_algo = window.localStorage.getItem(SUG_TUNE_ALGO_STORE);
  } catch(e) { /* private mode */ }
  if(saved_algo === 'auto' && stored_tune && sugAutoAvailable()) {
    sugAutoApplySettings('', stored_tune.best);
    sugUpdateSliderFeedback();
  }
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
  if(typeof segOnSessionStart === 'function') {
    segOnSessionStart();
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
  if(typeof segOnSessionEnd === 'function') {
    segOnSessionEnd();
  }
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
  var sp_badges = document.querySelectorAll(SUG_MARKER_SELECTOR);
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

// POST the staged highlights with the regular API, then clean up. Every
// highlight that was saved leaves the staged list (the real highlight arrives
// through the long-poll); the ones that failed stay staged, so saving again
// never posts a highlight twice. With failures the session stays open and
// done() is not called.
function sugSaveStaged(done) {
  var sess = sug_session;
  var staged = sess ? sess.staged.slice() : [];
  if(staged.length === 0) {
    done();
    return;
  }
  showSpinner();
  var saved = [], failed = [], firstError = null;
  var p = Promise.resolve();
  staged.forEach(function(st) {
    p = p.then(function() {
      return postJSON(
        '/api/project/' + project_id + '/document/' + current_document + '/highlight/new',
        {start_offset: st.start, end_offset: st.end, tags: st.tags}
      );
    }).then(function() {
      saved.push(st);
      var at = sess.staged.indexOf(st);
      if(at !== -1) {
        sess.staged.splice(at, 1);
      }
      if(sug_session === sess) {
        sugRemoveStagedDom(st.aid);
      }
    }, function(error) {
      console.error('Failed to save a highlight:', error);
      failed.push(st);
      firstError = firstError || error;
    });
  });
  p.then(function() {
    hideSpinner();
    if(sug_session === sess) {
      sugUpdateCounts();
    }
    if(saved.length && typeof segRecordSaved === 'function') {
      try {
        var rec = segRecordSaved(saved.map(function(st) {
          var o = {};
          for(var k in st) { o[k] = st[k]; }
          o.tags = (st.tags || []).slice();
          return o;
        }));
        if(rec && rec.then) {
          rec.then(null, function(error) {
            console.error('segRecordSaved failed:', error);
          });
        }
      } catch(error) {
        console.error('segRecordSaved failed:', error);
      }
    }
    if(failed.length) {
      alert(gettext("Couldn't create highlight!") + '\n\n' + firstError
            + '\n\n' + gettext('%(n)s highlight(s) are still accepted but unsaved.',
                                {n: failed.length}));
      return; // stay in the session: the failed ones can be saved again
    }
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
    $(modal).one('hidden.bs.modal', function() {
      var save = function() { sugSaveStaged(onDone); };
      if(typeof segBeforeSave === 'function') {
        segBeforeSave(save); // may ask to confirm new emergent segments
      } else {
        save();
      }
    });
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
 * Highlight tuning: how well do the highlighting algorithms reproduce the
 * highlights the user already saved?
 *
 * Aggressiveness is an operating point: more aggressive shows more
 * suggested text (fewer false negatives, more false positives). For every
 * combination (algorithm, ranking, keyphrase expansion) the slider is swept
 * over 0..100 on every chosen document and the char-level metrics are summed
 * over the documents (micro average):
 *   H = union of the document's highlights, S = union of the shown
 *   suggestions, E = eligible text (the speech of included speakers).
 *   recall = |S∩H|/|H|, precision = |S∩H|/|S|, FPR = |S∩E \ H| / |E \ H|.
 * The ROC curve is (FPR, recall) over the sweep, AUC its trapezoid area, and
 * the best operating point maximizes F1. The combination with the highest F1
 * is what the "Auto" algorithm uses.
 *
 * Candidates are computed through the same pure functions as the session
 * (sugRunAlgoCands, sugFinishCandidates, sugEmbedPlan, sugSelectShown) with
 * a context object per document: sug_session is only read, never swapped.
 */

var SUG_TUNE_STEPS = [];
(function() {
  for(var v = 0; v <= 100; v += 5) {
    SUG_TUNE_STEPS.push(v);
  }
})();
var SUG_TUNE_STORE = 'sug|tune|';              // + project id
var SUG_TUNE_ALGO_STORE = 'taguette_suggest_algo';
var SUG_TUNE_ADV_STORE = 'taguette_suggest_advanced';
var SUG_TUNE_TOP = 5;                          // curves drawn / stored

var SUG_TUNE = {
  running: false,
  token: null,        // {cancelled} of the run in flight
  results: null,      // {rows, best, ...} shown in the modal
  pending: null,      // {pkey} when the modal was opened by choosing Auto
  timer: null,
  startedAt: 0,
  wired: false,
};

function sugRankLabel(mode) {
  return {
    lexical: gettext('Lexical'),
    centroid: gettext('Semantic centrality'),
    cluster: gettext('Themes (clusters)'),
  }[mode] || mode;
}

// ---- spans ----------------------------------------------------------------

// Union of [s, e) spans -> sorted, disjoint [{s, e}]
function sugSpansUnion(spans) {
  var sorted = spans.filter(function(x) { return x.e > x.s; })
    .sort(function(a, b) { return a.s - b.s || a.e - b.e; });
  var out = [];
  for(var i = 0; i < sorted.length; ++i) {
    var last = out.length ? out[out.length - 1] : null;
    if(last && sorted[i].s <= last.e) {
      last.e = Math.max(last.e, sorted[i].e);
    } else {
      out.push({s: sorted[i].s, e: sorted[i].e});
    }
  }
  return out;
}

function sugSpansLen(u) {
  var n = 0;
  for(var i = 0; i < u.length; ++i) {
    n += u[i].e - u[i].s;
  }
  return n;
}

// Intersection of two unions
function sugSpansInter(a, b) {
  var out = [], i = 0, j = 0;
  while(i < a.length && j < b.length) {
    var s = Math.max(a[i].s, b[j].s), e = Math.min(a[i].e, b[j].e);
    if(e > s) {
      out.push({s: s, e: e});
    }
    if(a[i].e < b[j].e) {
      ++i;
    } else {
      ++j;
    }
  }
  return out;
}

// Eligible text: what suggestions could cover. With a speaker profile, the
// speech (after the label) of turns whose speaker is not excluded (turns
// with no speaker count as included); the whole text otherwise.
function sugTuneEligible(ctx) {
  var len = ctx.plainText.length;
  var speakers = ctx.speakers || [];
  if(!speakers.length || !ctx.turns || !ctx.turns.length) {
    return [{s: 0, e: len}];
  }
  var excluded = {};
  speakers.forEach(function(s) {
    if(s.include === false) {
      excluded[s.id] = true;
    }
  });
  var spans = [];
  ctx.turns.forEach(function(t) {
    if(t.speaker && excluded[t.speaker]) {
      return;
    }
    var s = sugTurnLabelEnd(t);
    if(t.end > s) {
      spans.push({s: s, e: t.end});
    }
  });
  return sugSpansUnion(spans);
}

// Saved highlights ([{start_offset, end_offset}] in bytes) -> union of char
// spans of the document
function sugTuneHighlightSpans(hls, boc) {
  return sugSpansUnion(hls.map(function(h) {
    return {s: sugByteToChar(boc, h.start_offset),
            e: sugByteToChar(boc, h.end_offset)};
  }));
}

// Smallest char index c with boc[c] >= byte
function sugByteToChar(boc, byte) {
  var lo = 0, hi = boc.length - 1;
  if(hi < 0) {
    return 0;
  }
  while(lo < hi) {
    var mid = (lo + hi) >> 1;
    if(boc[mid] < byte) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// ---- metrics --------------------------------------------------------------

// Char counts of one document at one operating point
function sugTuneCounts(H, S, E) {
  var SE = sugSpansInter(S, E);
  return {
    h: sugSpansLen(H),
    s: sugSpansLen(S),
    tp: sugSpansLen(sugSpansInter(S, H)),
    fp: sugSpansLen(SE) - sugSpansLen(sugSpansInter(SE, H)),
    neg: sugSpansLen(E) - sugSpansLen(sugSpansInter(E, H)),
  };
}

function sugTuneNewTotals() {
  return {h: 0, s: 0, tp: 0, fp: 0, neg: 0};
}

function sugTuneAddCounts(tot, c) {
  for(var k in tot) {
    tot[k] += c[k];
  }
  return tot;
}

// Aggregated counts at slider value v -> {v, precision, recall, fpr, f1}
function sugTunePoint(v, t) {
  var recall = t.h > 0 ? t.tp / t.h : 0;
  var precision = t.s > 0 ? t.tp / t.s : 0;
  var fpr = t.neg > 0 ? t.fp / t.neg : 0;
  var f1 = (precision + recall) > 0
    ? 2 * precision * recall / (precision + recall) : 0;
  return {v: v, precision: precision, recall: recall, fpr: fpr, f1: f1};
}

// Area under the ROC curve: trapezoids over (FPR, recall), with (0, 0)
// prepended and (1, 1) appended
function sugTuneAuc(points) {
  var pts = points.map(function(p) { return [p.fpr, p.recall]; })
    .sort(function(a, b) { return a[0] - b[0] || a[1] - b[1]; });
  pts.unshift([0, 0]);
  pts.push([1, 1]);
  var area = 0;
  for(var i = 1; i < pts.length; ++i) {
    area += (pts[i][0] - pts[i - 1][0]) * (pts[i][1] + pts[i - 1][1]) / 2;
  }
  return area;
}

// Highest F1; ties go to the lower aggressiveness
function sugTuneBestPoint(points) {
  var best = null;
  points.forEach(function(p) {
    if(!best || p.f1 > best.f1 + 1e-12
       || (Math.abs(p.f1 - best.f1) <= 1e-12 && p.v < best.v)) {
      best = p;
    }
  });
  return best;
}

// Combination + its curve -> table row
function sugTuneRow(combo, points) {
  var best = sugTuneBestPoint(points);
  return {
    algo: combo.algo, rankMode: combo.rankMode, expand: !!combo.expand,
    auc: sugTuneAuc(points), f1: best.f1, precision: best.precision,
    recall: best.recall, fpr: best.fpr, v: best.v, curve: points,
  };
}

// Highest F1 first (even when not strictly dominant), ties by AUC, then by
// the order of the list
function sugTuneSortRows(rows) {
  return rows.map(function(r, i) { return {r: r, i: i}; })
    .sort(function(a, b) {
      if(Math.abs(b.r.f1 - a.r.f1) > 1e-12) {
        return b.r.f1 - a.r.f1;
      }
      if(Math.abs(b.r.auc - a.r.auc) > 1e-12) {
        return b.r.auc - a.r.auc;
      }
      return a.i - b.i;
    }).map(function(x) { return x.r; });
}

// What Auto applies
function sugTuneBestOf(row) {
  return {algo: row.algo, rankMode: row.rankMode, expand: !!row.expand,
          aggressiveness: row.v};
}

// The combinations to evaluate. opts: {emb: embedding service configured,
// seg: Segment-based coding can run}
function sugTuneCombos(opts) {
  var out = [];
  ['textrank', 'lexrank', 'yake', 'rake'].forEach(function(algo) {
    var keyphrase = algo === 'yake' || algo === 'rake';
    var modes = opts.emb ? ['lexical', 'centroid', 'cluster'] : ['lexical'];
    (keyphrase ? [false, true] : [false]).forEach(function(expand) {
      modes.forEach(function(mode) {
        out.push({algo: algo, rankMode: mode, expand: expand});
      });
    });
  });
  if(opts.seg) {
    out.push({algo: 'segmented', rankMode: 'lexical', expand: false});
  }
  return out;
}

function sugTuneComboLabel(c) {
  var algo = SUG_ALGOS[c.algo] ? SUG_ALGOS[c.algo].label : c.algo;
  if(c.algo === 'segmented') {
    return algo;
  }
  return algo + ' · ' + sugRankLabel(c.rankMode)
    + (c.expand ? ' · ' + gettext('expanded') : '');
}

// ---- per-document evaluation ----------------------------------------------

function sugTuneCancelled(token) {
  return !!(token && token.cancelled);
}

function sugTuneCancelError() {
  var e = new Error(gettext('Cancelled'));
  e.cancelled = true;
  return e;
}

// Let the page paint (progress text, spinner) between heavy steps
function sugTuneYield() {
  return new Promise(function(resolve) {
    setTimeout(resolve, 0);
  });
}

// Candidates of one (algorithm, expand) on one document context, scored and
// merged exactly as the session does. Promise of the candidate list.
function sugTuneCandidates(ctx, algo, expand) {
  if(algo === 'segmented') {
    return segUiCandidatesFor({
      docId: ctx.docId, plainText: ctx.plainText, turns: ctx.turns,
      speakers: ctx.speakers,
    }).then(function(cands) {
      return sugFinishCandidates(cands, ctx.plainText, ctx.byteOfChar, ctx);
    });
  }
  return sugTuneYield().then(function() {
    var cands = sugRunAlgoCands(algo, ctx, expand);
    return sugFinishCandidates(cands, ctx.plainText, ctx.byteOfChar, ctx);
  });
}

// Embed the candidates (cache first, then the endpoint) and score them
function sugTuneEmbed(ctx, cands, cfg) {
  var plan = sugEmbedPlan(cands, ctx, sugEmbKey(cfg), 'tune|' + ctx.docId);
  var fetch = plan.missing.length
    ? sugEmbed(plan.missing, cfg) : Promise.resolve([]);
  return fetch.then(function(embs) {
    plan.fill(embs);
    plan.score();
  });
}

// Counts at every slider step for one combination, given its candidates
function sugTuneSweep(ctx, cands, combo, H, E) {
  var excluded = null;
  if((ctx.speakers || []).some(function(s) { return s.include === false; })) {
    excluded = function(c) {
      return sugIsExcludedSpan(c.cStart, c.cEnd, ctx);
    };
  }
  var embedded = combo.rankMode !== 'lexical';
  return SUG_TUNE_STEPS.map(function(v) {
    var labels = null;
    if(combo.rankMode === 'cluster') {
      labels = sugClusterCands(cands, {aggressiveness: v});
    }
    var shown = sugSelectShown(cands, {
      algo: combo.algo, rankMode: combo.rankMode, aggressiveness: v,
      useEmbeddings: embedded, clusterLabels: labels, isExcluded: excluded,
      staged: [],
    });
    var S = sugSpansUnion(shown.map(function(e) {
      return {s: e.c.cStart, e: e.c.cEnd};
    }));
    return sugTuneCounts(H, S, E);
  });
}

// One document: counts[i][step] for every combination i. hooks:
// {token, progress(j)}. Promise.
function sugTuneEvalDoc(ctx, hls, combos, cfg, hooks) {
  var H = sugTuneHighlightSpans(hls, ctx.byteOfChar);
  if(!sugSpansLen(H)) {
    return Promise.reject(new Error(gettext('No saved highlights')));
  }
  var E = sugTuneEligible(ctx);
  var bases = {};   // algo|expand -> Promise<{cands, embedded}>
  var counts = [];
  var p = Promise.resolve();
  combos.forEach(function(combo, j) {
    p = p.then(function() {
      if(sugTuneCancelled(hooks.token)) {
        throw sugTuneCancelError();
      }
      if(hooks.progress) {
        hooks.progress(j);
      }
      var key = combo.algo + '|' + (combo.expand ? 'x' : '');
      if(!bases[key]) {
        bases[key] = sugTuneCandidates(ctx, combo.algo, combo.expand)
          .then(function(cands) { return {cands: cands, embedded: false}; });
      }
      return bases[key].then(function(base) {
        if(combo.rankMode !== 'lexical' && !base.embedded) {
          return sugTuneEmbed(ctx, base.cands, cfg).then(function() {
            base.embedded = true;
            return base;
          });
        }
        return base;
      });
    }).then(function(base) {
      if(sugTuneCancelled(hooks.token)) {
        throw sugTuneCancelError();
      }
      return sugTuneYield().then(function() {
        counts[j] = sugTuneSweep(ctx, base.cands, combo, H, E);
      });
    });
  });
  return p.then(function() { return counts; });
}

// ---- document contexts ----------------------------------------------------

// The open document, from the session (nothing is recomputed or mutated)
function sugTuneOpenCtx() {
  var s = sug_session;
  return {
    docId: parseInt(current_document, 10), plainText: s.plainText,
    byteOfChar: s.byteOfChar, sentences: s.sentences,
    turns: s.turns || sugSpeakerTurns(), speakers: s.speakers || [],
    transcription: s.transcription, staged: [],
  };
}

function sugTuneOpenHighlights() {
  var out = [];
  var hls = (typeof highlights !== 'undefined' && highlights) ? highlights : {};
  for(var id in hls) {
    out.push({start_offset: hls[id].start_offset,
              end_offset: hls[id].end_offset});
  }
  return out;
}

// Another document, from the API, built like the session builds the open one
// (rendered chunks -> plain text, byte index, speaker turns, saved speaker
// profile). Promise of {ctx, highlights}.
function sugTuneLoadDoc(docId, transcription) {
  return getJSON(
    '/api/project/' + project_id + '/document/' + docId + '/content'
  ).then(function(result) {
    var inert = document.implementation.createHTMLDocument('');
    var root = inert.createElement('div');
    var offsets = [];
    result.contents.forEach(function(chunk) {
      var el = inert.createElement('div');
      el.setAttribute('id', 'doc-offset-' + chunk.offset);
      el.innerHTML = chunk.contents;
      root.appendChild(el);
      offsets.push(chunk.offset);
    });
    var index = sugBuildPlainIndexOf(root, offsets);
    var turns = sugAbsorbContinuations(
      sugBlocksFrom(root, index.plainText), index.plainText);
    var speakers = sugSpeakerProfileLoad(docId);
    if(speakers.length) {
      sugApplySpeakers(turns, speakers);
    }
    return {
      ctx: {docId: parseInt(docId, 10), plainText: index.plainText,
            byteOfChar: index.byteOfChar,
            sentences: sugSplitSentences(index.plainText), turns: turns,
            speakers: speakers, transcription: transcription, staged: []},
      highlights: result.highlights,
    };
  });
}

// Documents the tuning can use: saved highlights (the open one counts its
// live highlights). [{id, name, count}]
function sugTuneDocs() {
  var docs = (typeof documents !== 'undefined' && documents) ? documents : {};
  var open = (typeof current_document !== 'undefined')
    ? current_document : null;
  var live = (open !== null && sug_session)
    ? sugTuneOpenHighlights().length : 0;
  var out = [];
  Object.keys(docs).sort(function(a, b) { return a - b; }).forEach(function(id) {
    var d = docs[id];
    var n = (open !== null && String(open) === String(id) && sug_session)
      ? live : (d.highlights_count || 0);
    if(n > 0) {
      out.push({id: parseInt(id, 10), name: d.name, count: n});
    }
  });
  return out;
}

// ---- the run --------------------------------------------------------------

// Evaluate every combination on the given documents. hooks: {token,
// progress({doc, docs, combo, combos}), error({id, message})}. Resolves with
// {rows (sorted), best, docIds (evaluated), combos}; rejects with a
// `cancelled` error when the token is cancelled.
function sugTuneRun(docIds, hooks) {
  var sess = sug_session;
  if(!sess) {
    return Promise.reject(new Error(gettext('Start a suggestion session first.')));
  }
  var cfg = sugLoadConfig();
  var combos = sugTuneCombos({
    emb: !!cfg,
    seg: !!cfg && typeof segUiCandidatesFor === 'function',
  });
  var totals = combos.map(function() {
    return SUG_TUNE_STEPS.map(sugTuneNewTotals);
  });
  var done = [];
  var transcription = sess.transcription;
  var p = Promise.resolve();
  docIds.forEach(function(docId, di) {
    p = p.then(function() {
      if(sugTuneCancelled(hooks.token)) {
        throw sugTuneCancelError();
      }
      var report = function(j) {
        if(hooks.progress) {
          hooks.progress({doc: di, docs: docIds.length, combo: j,
                          combos: combos.length});
        }
      };
      report(0);
      var open = String(docId) === String(current_document);
      var loaded = open
        ? Promise.resolve({ctx: sugTuneOpenCtx(),
                           highlights: sugTuneOpenHighlights()})
        : sugTuneLoadDoc(docId, transcription);
      return loaded.then(function(doc) {
        if(sugTuneCancelled(hooks.token)) {
          throw sugTuneCancelError();
        }
        return sugTuneEvalDoc(doc.ctx, doc.highlights, combos, cfg,
                              {token: hooks.token, progress: report});
      }).then(function(counts) {
        counts.forEach(function(per_step, i) {
          per_step.forEach(function(c, k) {
            sugTuneAddCounts(totals[i][k], c);
          });
        });
        done.push(docId);
      }, function(err) {
        if(err && err.cancelled) {
          throw err;
        }
        console.error('Tuning: document ' + docId + ' failed:', err);
        if(hooks.error) {
          hooks.error({id: docId,
                       message: (err && err.message) || String(err)});
        }
      });
    });
  });
  return p.then(function() {
    if(!done.length) {
      throw new Error(gettext('No document could be evaluated.'));
    }
    var rows = sugTuneSortRows(combos.map(function(combo, i) {
      return sugTuneRow(combo, SUG_TUNE_STEPS.map(function(v, k) {
        return sugTunePoint(v, totals[i][k]);
      }));
    }));
    return {rows: rows, best: sugTuneBestOf(rows[0]), docIds: done,
            combos: combos.length, transcription: transcription,
            embKey: cfg ? sugEmbKey(cfg) : '',
            segParamsKey: (typeof segParams === 'function'
                           && typeof segUiParamsHash === 'function')
              ? segUiParamsHash(segParams()) : ''};
  });
}

// ---- persistence ------------------------------------------------------------

function sugTuneStoreKey() {
  return SUG_TUNE_STORE + project_id;
}

function sugTuneRound(x) {
  return Math.round(x * 10000) / 10000;
}

// Rows without curves, except the top few as [v, fpr, recall] triples
function sugTuneSerialize(res) {
  return {
    version: 1, savedAt: Date.now(), docIds: res.docIds,
    transcription: res.transcription, embKey: res.embKey,
    segParamsKey: res.segParamsKey,
    rows: res.rows.map(function(r, i) {
      var o = {algo: r.algo, rankMode: r.rankMode, expand: !!r.expand,
               auc: sugTuneRound(r.auc), f1: sugTuneRound(r.f1),
               precision: sugTuneRound(r.precision),
               recall: sugTuneRound(r.recall), fpr: sugTuneRound(r.fpr),
               v: r.v};
      if(i < SUG_TUNE_TOP && r.curve) {
        o.curve = r.curve.map(function(p) {
          return [p.v, sugTuneRound(p.fpr), sugTuneRound(p.recall)];
        });
      }
      return o;
    }),
    best: res.best,
  };
}

function sugTuneNum(x) {
  return (typeof x === 'number' && isFinite(x)) ? x : 0;
}

// Stored results of this project, or null (absent or unusable)
function sugTuneStored() {
  try {
    var raw = window.localStorage.getItem(sugTuneStoreKey());
    var o = raw ? JSON.parse(raw) : null;
    if(!o || o.version !== 1 || !o.best || !o.rows || !o.rows.length
       || !SUG_ALGOS[o.best.algo]
       || !(typeof o.best.aggressiveness === 'number')) {
      return null;
    }
    o.rows = o.rows.map(function(r) {
      var out = {algo: r.algo, rankMode: r.rankMode, expand: !!r.expand,
                 auc: sugTuneNum(r.auc), f1: sugTuneNum(r.f1),
                 precision: sugTuneNum(r.precision),
                 recall: sugTuneNum(r.recall), fpr: sugTuneNum(r.fpr),
                 v: sugTuneNum(r.v)};
      if(r.curve && r.curve.map) {
        out.curve = r.curve.map(function(t) {
          return {v: t[0], fpr: sugTuneNum(t[1]), recall: sugTuneNum(t[2])};
        });
      }
      return out;
    });
    return o;
  } catch(e) {
    return null;
  }
}

function sugTuneStoreSave(res) {
  try {
    window.localStorage.setItem(sugTuneStoreKey(),
                                JSON.stringify(sugTuneSerialize(res)));
  } catch(e) { /* private mode: the results just won't persist */ }
}

// ---- Auto -----------------------------------------------------------------

// Auto is offered when the project has saved highlights to learn from
function sugAutoAvailable() {
  return sugTuneDocs().length > 0;
}

function sugAutoLabel(stored) {
  if(!stored) {
    return gettext('Auto');
  }
  var b = stored.best;
  return gettext('Auto (%(what)s)', {what: sugTuneComboLabel(b)});
}

// "Auto" first in both algorithm selects when available (else removed)
function sugRefreshAutoOptions() {
  var avail = sugAutoAvailable();
  var label = sugAutoLabel(sugTuneStored());
  ['sug-algo-a', 'sug-algo-b'].forEach(function(id) {
    var sel = document.getElementById(id);
    if(!sel) {
      return;
    }
    var opt = null;
    for(var i = 0; i < sel.options.length; ++i) {
      if(sel.options[i].value === 'auto') {
        opt = sel.options[i];
      }
    }
    if(avail && !opt) {
      opt = document.createElement('option');
      opt.value = 'auto';
      sel.insertBefore(opt, sel.firstChild);
    } else if(!avail && opt) {
      sel.removeChild(opt);
      opt = null;
    }
    if(opt) {
      opt.textContent = label;
    }
  });
}

function sugAutoSaveChoice() {
  try {
    if(sug_session && sug_session.panes[''].auto) {
      window.localStorage.setItem(SUG_TUNE_ALGO_STORE, 'auto');
    } else {
      window.localStorage.removeItem(SUG_TUNE_ALGO_STORE);
    }
  } catch(e) { /* best effort */ }
}

// Set the session (and the controls) to the tuned combination, without
// recomputing: algorithm of the pane, ranking, expansion, slider at v*
function sugAutoApplySettings(pkey, best) {
  var s = sug_session;
  var pane = s.panes[pkey];
  pane.auto = true;
  pane.algo = best.algo;
  if(best.algo === 'yake' || best.algo === 'rake') {
    s.expand = !!best.expand;
    document.getElementById('sug-expand').checked = s.expand;
  }
  if(best.algo !== 'segmented') {
    var mode = best.rankMode;
    if(mode !== 'lexical' && !sugLoadConfig()) {
      mode = 'lexical';
    }
    s.rankMode = mode;
    s.useEmbeddings = mode !== 'lexical';
    document.getElementById('sug-mode').value = mode;
  }
  s.aggressiveness = Math.max(0, Math.min(100, Math.round(best.aggressiveness)));
  document.getElementById('sug-slider').value = String(s.aggressiveness);
}

function sugAutoApply(pkey) {
  var stored = sugTuneStored();
  if(!sug_session || !stored || !sug_session.panes[pkey]) {
    return false;
  }
  sugAutoApplySettings(pkey, stored.best);
  sugSyncAlgoSelects();
  sugAutoSaveChoice();
  // Ranking, expansion and slider are session-wide: recompute every pane
  sugPaneKeys().forEach(sugComputePane);
  return true;
}

// The user chose Auto in a select: use the stored tuning, or tune first
function sugAutoChosen(pkey) {
  if(sugTuneStored()) {
    sugAutoApply(pkey);
    return;
  }
  SUG_TUNE.pending = {pkey: pkey};
  sugTuneOpen();
}

// Ranking / expansion changed by hand: Auto means "the tuned combination",
// so the selects fall back to the concrete algorithm
function sugAutoLeave() {
  if(!sug_session) {
    return;
  }
  var any = false;
  sugPaneKeys().forEach(function(k) {
    if(sug_session.panes[k].auto) {
      sug_session.panes[k].auto = false;
      any = true;
    }
  });
  if(any) {
    sugSyncAlgoSelects();
    sugAutoSaveChoice();
  }
}

// ---- the modal ----------------------------------------------------------------

function sugTuneEl(tag, cls, text) {
  var el = document.createElement(tag);
  if(cls) {
    el.className = cls;
  }
  if(text !== undefined) {
    el.textContent = text;
  }
  return el;
}

function sugTuneFmtElapsed(ms) {
  var secs = Math.max(0, Math.floor(ms / 1000));
  var s = secs % 60;
  return Math.floor(secs / 60) + ':' + (s < 10 ? '0' : '') + s;
}

function sugTuneShow(id, on) {
  var el = document.getElementById(id);
  if(el) {
    el.style.display = on ? '' : 'none';
  }
}

function sugTuneRenderDocs() {
  var box = document.getElementById('sug-tune-docs');
  var before = {};
  var had = box.children.length > 0;
  Array.prototype.forEach.call(box.querySelectorAll('input'), function(i) {
    before[i.value] = i.checked;
  });
  while(box.firstChild) {
    box.removeChild(box.firstChild);
  }
  sugTuneDocs().forEach(function(d) {
    var label = sugTuneEl('label', 'sug-tune-doc d-block mb-1');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(d.id);
    cb.checked = had && (d.id in before) ? before[d.id] : true;
    cb.className = 'mr-2';
    label.appendChild(cb);
    label.appendChild(document.createTextNode(d.name + ' '));
    label.appendChild(sugTuneEl('span', 'text-muted', gettext(
      '(%(n)s highlight(s))', {n: d.count})));
    box.appendChild(label);
  });
  sugTuneUpdateRunButton();
}

function sugTuneChosenDocs() {
  var ids = [];
  Array.prototype.forEach.call(
    document.querySelectorAll('#sug-tune-docs input'), function(i) {
      if(i.checked) {
        ids.push(parseInt(i.value, 10));
      }
    });
  return ids;
}

function sugTuneUpdateRunButton() {
  var run = document.getElementById('sug-tune-run');
  if(run) {
    run.disabled = SUG_TUNE.running || !sugTuneChosenDocs().length
      || !sug_session;
  }
}

function sugTuneSvg(tag, attrs) {
  var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for(var k in (attrs || {})) {
    el.setAttribute(k, String(attrs[k]));
  }
  return el;
}

// ROC chart: FPR on x, recall on y, both 0..1; one polyline per combination
// of the top few, the winner emphasized with its operating point marked.
// Colors come from CSS custom properties (custom.css).
function sugTuneChart(rows) {
  var W = 360, H = 320, L = 46, R = 12, T = 12, B = 42;
  var pw = W - L - R, ph = H - T - B;
  var X = function(v) { return L + sugTuneNum(v) * pw; };
  var Y = function(v) { return T + (1 - sugTuneNum(v)) * ph; };
  var svg = sugTuneSvg('svg', {viewBox: '0 0 ' + W + ' ' + H, width: '100%',
                               'class': 'sug-roc', role: 'img',
                               'aria-label': gettext('ROC curves')});
  [0, 0.25, 0.5, 0.75, 1].forEach(function(t) {
    svg.appendChild(sugTuneSvg('line', {x1: X(t), y1: Y(0), x2: X(t), y2: Y(1),
                                        'class': 'sug-roc-grid'}));
    svg.appendChild(sugTuneSvg('line', {x1: X(0), y1: Y(t), x2: X(1), y2: Y(t),
                                        'class': 'sug-roc-grid'}));
  });
  [0, 0.5, 1].forEach(function(t) {
    var tx = sugTuneSvg('text', {x: X(t), y: Y(0) + 14, 'class': 'sug-roc-tick',
                                 'text-anchor': 'middle'});
    tx.textContent = String(t);
    svg.appendChild(tx);
    var ty = sugTuneSvg('text', {x: X(0) - 6, y: Y(t) + 4,
                                 'class': 'sug-roc-tick', 'text-anchor': 'end'});
    ty.textContent = String(t);
    svg.appendChild(ty);
  });
  svg.appendChild(sugTuneSvg('rect', {x: X(0), y: Y(1), width: pw, height: ph,
                                      'class': 'sug-roc-frame'}));
  svg.appendChild(sugTuneSvg('line', {x1: X(0), y1: Y(0), x2: X(1), y2: Y(1),
                                      'class': 'sug-roc-diag'}));
  var xl = sugTuneSvg('text', {x: X(0.5), y: H - 6, 'class': 'sug-roc-label',
                               'text-anchor': 'middle'});
  xl.textContent = gettext('False positive rate');
  svg.appendChild(xl);
  var yl = sugTuneSvg('text', {x: 12, y: Y(0.5), 'class': 'sug-roc-label',
                               'text-anchor': 'middle',
                               transform: 'rotate(-90 12 ' + Y(0.5) + ')'});
  yl.textContent = gettext('Recall');
  svg.appendChild(yl);
  var top = rows.slice(0, SUG_TUNE_TOP).filter(function(r) { return r.curve; });
  // Draw the winner last so it sits on top
  for(var i = top.length - 1; i >= 0; --i) {
    var r = top[i];
    var pts = r.curve.map(function(p) { return [p.fpr, p.recall]; })
      .sort(function(a, b) { return a[0] - b[0] || a[1] - b[1]; });
    pts.unshift([0, 0]);
    pts.push([1, 1]);
    svg.appendChild(sugTuneSvg('polyline', {
      points: pts.map(function(p) {
        return X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1);
      }).join(' '),
      'class': 'sug-roc-line sug-roc-c' + i + (i === 0 ? ' sug-roc-best' : ''),
    }));
    svg.appendChild(sugTuneSvg('circle', {
      cx: X(r.fpr), cy: Y(r.recall), r: i === 0 ? 5.5 : 3.5,
      'class': 'sug-roc-point sug-roc-c' + i,
    }));
  }
  return svg;
}

function sugTuneRenderResults() {
  var res = SUG_TUNE.results;
  var box = document.getElementById('sug-tune-results');
  if(!res) {
    sugTuneShow('sug-tune-results', false);
    sugTuneShow('sug-tune-use', false);
    return;
  }
  sugTuneShow('sug-tune-results', true);
  var info = document.getElementById('sug-tune-info');
  var when = res.savedAt ? new Date(res.savedAt).toLocaleString() : '';
  info.textContent = gettext('%(n)s document(s) evaluated', {n: res.docIds.length})
    + (when ? ' · ' + when : '');
  var table = document.getElementById('sug-tune-table');
  while(table.firstChild) {
    table.removeChild(table.firstChild);
  }
  var head = sugTuneEl('tr');
  [gettext('Algorithm'), gettext('Ranking'), gettext('AUC'),
   gettext('Best F1'), gettext('Precision'), gettext('Recall'),
   gettext('Aggressiveness at best F1')].forEach(function(h) {
    head.appendChild(sugTuneEl('th', '', h));
  });
  var thead = sugTuneEl('thead');
  thead.appendChild(head);
  table.appendChild(thead);
  var tbody = sugTuneEl('tbody');
  res.rows.forEach(function(r, i) {
    var tr = sugTuneEl('tr');
    tr.setAttribute('data-algo', r.algo);
    tr.setAttribute('data-rank', r.rankMode);
    if(i === 0) {
      tr.className = 'sug-tune-best-row';
    }
    var algo = sugTuneEl('td', '', (SUG_ALGOS[r.algo] || {}).label || r.algo);
    if(i === 0) {
      algo.appendChild(document.createTextNode(' '));
      algo.appendChild(sugTuneEl('span', 'badge badge-success sug-tune-badge',
                                 gettext('best')));
    }
    tr.appendChild(algo);
    tr.appendChild(sugTuneEl('td', '', r.algo === 'segmented' ? '—'
      : sugRankLabel(r.rankMode) + (r.expand ? ' · ' + gettext('expanded') : '')));
    [r.auc, r.f1, r.precision, r.recall].forEach(function(x) {
      tr.appendChild(sugTuneEl('td', 'text-right', sugTuneNum(x).toFixed(3)));
    });
    tr.appendChild(sugTuneEl('td', 'text-right', String(r.v)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  var chart = document.getElementById('sug-tune-chart');
  while(chart.firstChild) {
    chart.removeChild(chart.firstChild);
  }
  chart.appendChild(sugTuneChart(res.rows));
  var legend = sugTuneEl('div', 'sug-roc-legend small');
  res.rows.slice(0, SUG_TUNE_TOP).forEach(function(r, i) {
    var item = sugTuneEl('span', 'sug-roc-legend-item');
    item.appendChild(sugTuneEl('span', 'sug-roc-swatch sug-roc-c' + i));
    item.appendChild(document.createTextNode(' ' + sugTuneComboLabel(r)));
    legend.appendChild(item);
  });
  chart.appendChild(legend);
  var stale = document.getElementById('sug-tune-stale');
  var cfg = sugLoadConfig();
  var changed = res.embKey !== undefined && (cfg ? sugEmbKey(cfg) : '') !== res.embKey;
  // Segment-based coding was scored with the segmentation parameters of the
  // time; changed parameters make its row (and maybe the winner) outdated
  if(!changed && res.segParamsKey && typeof segParams === 'function'
     && typeof segUiParamsHash === 'function') {
    changed = segUiParamsHash(segParams()) !== res.segParamsKey;
  }
  stale.style.display = changed ? '' : 'none';
  sugTuneShow('sug-tune-use', true);
}

function sugTuneSetBusy(busy) {
  SUG_TUNE.running = busy;
  sugTuneShow('sug-tune-progress', busy);
  sugTuneShow('sug-tune-setup', !busy);
  sugTuneShow('sug-tune-cancel', busy);
  sugTuneShow('sug-tune-run', !busy);
  if(busy) {
    sugTuneShow('sug-tune-use', false);
  } else if(SUG_TUNE.results) {
    sugTuneShow('sug-tune-use', true);
  }
  sugTuneUpdateRunButton();
}

function sugTuneProgressText(p, startedAt) {
  var el = document.getElementById('sug-tune-progress-text');
  if(!el) {
    return;
  }
  el.textContent = gettext('document %(i)s/%(n)s · combination %(j)s/%(m)s',
    {i: p.doc + 1, n: p.docs, j: p.combo + 1, m: p.combos})
    + ' · ' + sugTuneFmtElapsed(Date.now() - startedAt);
}

function sugTuneAddError(msg) {
  var box = document.getElementById('sug-tune-errors');
  box.style.display = '';
  box.appendChild(sugTuneEl('div', '', msg));
}

function sugTuneRunClicked() {
  if(SUG_TUNE.running || !sug_session) {
    return;
  }
  var ids = sugTuneChosenDocs();
  if(!ids.length) {
    return;
  }
  var names = {};
  sugTuneDocs().forEach(function(d) { names[d.id] = d.name; });
  var errors = document.getElementById('sug-tune-errors');
  while(errors.firstChild) {
    errors.removeChild(errors.firstChild);
  }
  errors.style.display = 'none';
  var token = {cancelled: false};
  SUG_TUNE.token = token;
  SUG_TUNE.startedAt = Date.now();
  sugTuneSetBusy(true);
  var last = {doc: 0, docs: ids.length, combo: 0, combos: 1};
  sugTuneProgressText(last, SUG_TUNE.startedAt);
  SUG_TUNE.timer = setInterval(function() {
    sugTuneProgressText(last, SUG_TUNE.startedAt);
  }, 1000);
  var finish = function() {
    clearInterval(SUG_TUNE.timer);
    SUG_TUNE.timer = null;
    SUG_TUNE.token = null;
    sugTuneSetBusy(false);
  };
  sugTuneRun(ids, {
    token: token,
    progress: function(p) {
      last = p;
      sugTuneProgressText(p, SUG_TUNE.startedAt);
    },
    error: function(e) {
      sugTuneAddError(gettext('%(doc)s: %(msg)s',
        {doc: names[e.id] || e.id, msg: e.message}));
    },
  }).then(function(res) {
    res.savedAt = Date.now();
    SUG_TUNE.results = res;
    sugTuneStoreSave(res);
    finish();
    sugRefreshAutoOptions();
    sugTuneRenderResults();
  }, function(err) {
    finish();
    if(err && err.cancelled) {
      return; // partial results are discarded
    }
    console.error('Tuning failed:', err);
    sugTuneAddError((err && err.message) || String(err));
  });
}

function sugTuneCancelClicked() {
  if(SUG_TUNE.token) {
    SUG_TUNE.token.cancelled = true;
  }
}

function sugTuneOpen() {
  if(!sug_session) {
    return;
  }
  SUG_TUNE.results = sugTuneStored();
  var modal = document.getElementById('suggest-tune-modal');
  sugTuneRenderDocs();
  sugTuneSetBusy(false);
  sugTuneRenderResults();
  var errors = document.getElementById('sug-tune-errors');
  errors.style.display = 'none';
  while(errors.firstChild) {
    errors.removeChild(errors.firstChild);
  }
  $(modal).modal('show');
}

// The modal is gone (closed, Escape, or Use Auto): stop a run in flight and
// settle a pending "Auto" choice
function sugTuneClosed() {
  sugTuneCancelClicked();
  var pending = SUG_TUNE.pending;
  SUG_TUNE.pending = null;
  if(!sug_session) {
    return;
  }
  if(pending && sugTuneStored() && !sug_session.panes[pending.pkey].auto) {
    sugAutoApply(pending.pkey);
  } else if(pending) {
    sugSyncAlgoSelects(); // no results: back to the previous algorithm
  }
}

function sugTuneUseAuto() {
  var pkey = SUG_TUNE.pending ? SUG_TUNE.pending.pkey : '';
  SUG_TUNE.pending = null;
  if(sug_session && SUG_TUNE.results) {
    sugAutoApply(pkey);
  }
  $(document.getElementById('suggest-tune-modal')).modal('hide');
}

function sugTuneInit() {
  if(SUG_TUNE.wired || !document.getElementById('suggest-tune-modal')) {
    return;
  }
  SUG_TUNE.wired = true;
  var on = function(id, fn) {
    document.getElementById(id).addEventListener('click', fn);
  };
  on('sug-tune-btn', function(e) {
    e.preventDefault();
    sugTuneOpen();
  });
  on('sug-tune-run', sugTuneRunClicked);
  on('sug-tune-cancel', sugTuneCancelClicked);
  on('sug-tune-use', sugTuneUseAuto);
  on('sug-tune-all', function() {
    Array.prototype.forEach.call(
      document.querySelectorAll('#sug-tune-docs input'),
      function(i) { i.checked = true; });
    sugTuneUpdateRunButton();
  });
  on('sug-tune-none', function() {
    Array.prototype.forEach.call(
      document.querySelectorAll('#sug-tune-docs input'),
      function(i) { i.checked = false; });
    sugTuneUpdateRunButton();
  });
  document.getElementById('sug-tune-docs').addEventListener(
    'change', sugTuneUpdateRunButton);
  $(document.getElementById('suggest-tune-modal'))
    .on('hidden.bs.modal', sugTuneClosed);
  // Advanced options: collapsed by default, remembered per viewer
  var panel = document.getElementById('suggest-panel');
  var toggle = document.getElementById('sug-advanced-toggle');
  var setAdvanced = function(open, save) {
    panel.classList.toggle('sug-advanced-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.textContent = gettext('Advanced') + (open ? ' \u25BE' : ' \u25B8');
    if(save) {
      try {
        window.localStorage.setItem(SUG_TUNE_ADV_STORE, open ? '1' : '0');
      } catch(e) { /* best effort */ }
    }
  };
  var saved = false;
  try {
    saved = window.localStorage.getItem(SUG_TUNE_ADV_STORE) === '1';
  } catch(e) { /* private mode: collapsed */ }
  setAdvanced(saved, false);
  toggle.addEventListener('click', function(e) {
    e.preventDefault();
    setAdvanced(!panel.classList.contains('sug-advanced-open'), true);
  });
}

/*
 * Init
 */

function sugSyncAlgoSelects() {
  var b_wrap = document.getElementById('sug-algo-b-wrap');
  var split = document.getElementById('sug-split');
  if(sug_session) {
    sugRefreshAutoOptions();
    var shown = function(pane) {
      return (pane.auto && sugAutoAvailable()) ? 'auto' : pane.algo;
    };
    document.getElementById('sug-algo-a').value = shown(sug_session.panes['']);
    b_wrap.style.display = sug_session.split ? '' : 'none';
    if(sug_session.panes['R']) {
      sug_session.panes['R'].clusterLabels = sug_session.panes['R'].clusterLabels || {};
      document.getElementById('sug-algo-b').value = shown(sug_session.panes['R']);
    }
    split.checked = sug_session.split;
    sugUpdateSliderFeedback();
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
  var seg_key = null;
  sugPaneKeys().forEach(function(k) {
    var pane = sug_session.panes[k];
    if(seg_key === null && pane && pane.algo === 'segmented' && pane.candidates) {
      seg_key = k;
    }
  });
  if(seg_key !== null) {
    var seg_pane = sug_session.panes[seg_key];
    el.textContent = gettext('Showing %(n)s of %(total)s suggested highlights',
      {n: seg_pane.suggestions.length, total: seg_pane.candidates.length});
  } else if(sug_session.rankMode === 'cluster') {
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
    sugSliderSettled();
  }, 250);
}

// The slider settled: re-filter every pane (segmented panes too: it is only
// a display filter there, the analysis is not re-run)
function sugSliderSettled() {
  if(!sug_session) {
    return;
  }
  sugPaneKeys().forEach(function(k) {
    var pane = sug_session.panes[k];
    if(pane.algo !== 'segmented' && sug_session.rankMode === 'cluster') {
      sugReclusterPane(k);
    }
    sugRefilterPane(k);
  });
  sugSetStatus(sugStatusText());
  sugUpdateSliderFeedback();
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
    if(e.target.value === 'auto') {
      sugAutoChosen('');
      return;
    }
    sug_session.panes[''].auto = false;
    sugAutoSaveChoice();
    sug_session.panes[''].algo = e.target.value;
    sugComputePane('');
  });
  document.getElementById('sug-algo-b').addEventListener('change', function(e) {
    if(!sug_session || !sug_session.panes['R']) {
      return;
    }
    if(e.target.value === 'auto') {
      sugAutoChosen('R');
      return;
    }
    sug_session.panes['R'].auto = false;
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
      sugSliderSettled();
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
    sugAutoLeave();
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
    sugAutoLeave();
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
    var marker = e.target && e.target.closest
      ? e.target.closest(SUG_MARKER_SELECTOR) : null;
    var badge = marker && marker.classList.contains('sug-speaker-badge')
      ? marker : null;
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
  sugTuneInit();

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
    if(sug_menu_pinned && sugClickIsOutsideMenu(e.target)) {
      sugHideMenu();
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
 * Self-test of the highlight tuning (metrics, selection, combinations). Pure:
 * no DOM, no session. Returns the number of failures.
 */

function sugTuneSelfTest() {
  var failures = 0;
  function assert(cond, msg) {
    if(!cond) {
      console.error('TUNE SELFTEST FAIL:', msg);
      ++failures;
    }
  }
  function near(a, b) {
    return Math.abs(a - b) < 1e-9;
  }
  function ids(entries) {
    return entries.map(function(e) { return e.c.id; }).join(',');
  }

  // Spans
  var u = sugSpansUnion([{s: 10, e: 12}, {s: 0, e: 5}, {s: 3, e: 8}, {s: 8, e: 9}]);
  assert(JSON.stringify(u) === '[{"s":0,"e":9},{"s":10,"e":12}]',
         'union merges overlapping and touching spans: ' + JSON.stringify(u));
  assert(sugSpansLen(u) === 11, 'union length');
  var it = sugSpansInter([{s: 0, e: 10}, {s: 20, e: 30}],
                         [{s: 5, e: 25}, {s: 28, e: 40}]);
  assert(JSON.stringify(it) === '[{"s":5,"e":10},{"s":20,"e":25},{"s":28,"e":30}]',
         'intersection of unions: ' + JSON.stringify(it));
  assert(sugSpansLen(sugSpansInter([], [{s: 0, e: 5}])) === 0, 'empty intersection');

  // Counts and rates on hand-made spans: H=[0,10), S=[5,15), E=[0,20)
  var c = sugTuneCounts([{s: 0, e: 10}], [{s: 5, e: 15}], [{s: 0, e: 20}]);
  assert(c.h === 10 && c.s === 10 && c.tp === 5 && c.fp === 5 && c.neg === 10,
         'counts: ' + JSON.stringify(c));
  var pt = sugTunePoint(40, c);
  assert(near(pt.recall, 0.5) && near(pt.precision, 0.5) && near(pt.fpr, 0.5)
         && near(pt.f1, 0.5) && pt.v === 40, 'rates');
  // Suggestions outside the eligible text are not false positives
  c = sugTuneCounts([{s: 0, e: 10}], [{s: 5, e: 30}], [{s: 0, e: 20}]);
  assert(c.s === 25 && c.tp === 5 && c.fp === 10 && c.neg === 10,
         'FPR only counts eligible text: ' + JSON.stringify(c));
  // Micro average: totals are summed over documents
  var tot = sugTuneNewTotals();
  sugTuneAddCounts(tot, sugTuneCounts([{s: 0, e: 10}], [{s: 0, e: 10}], [{s: 0, e: 20}]));
  sugTuneAddCounts(tot, sugTuneCounts([{s: 0, e: 30}], [{s: 0, e: 10}], [{s: 0, e: 40}]));
  pt = sugTunePoint(0, tot);
  assert(near(pt.recall, 20 / 40) && near(pt.precision, 1) && near(pt.fpr, 0),
         'micro aggregation sums lengths');
  pt = sugTunePoint(0, sugTuneNewTotals());
  assert(pt.recall === 0 && pt.precision === 0 && pt.fpr === 0 && pt.f1 === 0
         && isFinite(pt.f1), 'empty totals give zeros, not NaN');

  // AUC (the diagonal is 0.5, a perfect point 1, a known point 0.85)
  assert(near(sugTuneAuc([{fpr: 0.5, recall: 0.5}]), 0.5), 'AUC of the diagonal');
  assert(near(sugTuneAuc([{fpr: 0, recall: 1}]), 1), 'AUC of a perfect point');
  assert(near(sugTuneAuc([{fpr: 0.1, recall: 0.8}]), 0.85), 'AUC of (0.1, 0.8)');
  assert(near(sugTuneAuc([{fpr: 0.5, recall: 0.9}, {fpr: 0.1, recall: 0.5}]),
              0.1 * 0.25 + 0.4 * 0.7 + 0.5 * 0.95), 'AUC sorts by FPR');

  // Best F1 point: ties go to the lower aggressiveness
  var pts = [{v: 0, f1: 0.2}, {v: 20, f1: 0.6}, {v: 40, f1: 0.5},
             {v: 60, f1: 0.6}, {v: 80, f1: 0.1}];
  assert(sugTuneBestPoint(pts).v === 20, 'best F1 tie -> lower v');
  assert(sugTuneBestPoint([{v: 5, f1: 0}, {v: 10, f1: 0}]).v === 5, 'all-zero F1');

  // Best combination: highest F1 (even when not dominant), ties -> AUC -> order
  var rows = sugTuneSortRows([
    {algo: 'a', f1: 0.5, auc: 0.9}, {algo: 'b', f1: 0.6, auc: 0.6},
    {algo: 'c', f1: 0.6, auc: 0.7}, {algo: 'd', f1: 0.6, auc: 0.7},
    {algo: 'e', f1: 0.1, auc: 0.99}]);
  assert(rows.map(function(r) { return r.algo; }).join('') === 'cdbae',
         'sort by F1, then AUC, then order: ' + rows.map(function(r) { return r.algo; }).join(''));
  var best = sugTuneBestOf({algo: 'yake', rankMode: 'centroid', expand: 1, v: 35});
  assert(best.algo === 'yake' && best.rankMode === 'centroid' && best.expand === true
         && best.aggressiveness === 35, 'best of a row');

  // Combinations
  var combos = sugTuneCombos({emb: true, seg: true});
  assert(combos.length === 3 + 3 + 6 + 6 + 1, 'all combinations: ' + combos.length);
  assert(combos[combos.length - 1].algo === 'segmented', 'segmented last, once');
  combos = sugTuneCombos({emb: false, seg: false});
  assert(combos.length === 1 + 1 + 2 + 2 && combos.every(function(x) {
    return x.rankMode === 'lexical';
  }), 'lexical only without embeddings or segmentation: ' + combos.length);
  assert(combos.filter(function(x) { return x.expand; }).length === 2
         && combos.every(function(x) {
    return !x.expand || x.algo === 'yake' || x.algo === 'rake';
  }), 'expand variants only for yake and rake');

  // Eligible text
  var ctx = {plainText: 'x'.repeat(100), speakers: [], turns: []};
  assert(sugSpansLen(sugTuneEligible(ctx)) === 100, 'no profile: whole text');
  ctx = {
    plainText: 'I: question here?\nP: the answer goes here.\n?: unlabelled text',
    speakers: [{id: 'I', include: false}, {id: 'P', include: true}],
    turns: [{start: 0, end: 18, text: 'I: question here?\n', speaker: 'I'},
            {start: 18, end: 43, text: 'P: the answer goes here.\n', speaker: 'P'},
            {start: 43, end: 62, text: '?: unlabelled text', speaker: null}],
  };
  var el = sugTuneEligible(ctx);
  assert(el.length === 1 && el[0].s === 21 && el[0].e === 62,
         'eligible: included speakers after their labels, unlabelled turns too, '
         + 'the excluded speaker\'s turn left out: '
         + JSON.stringify(el));

  // Selection parity with the slider behaviour of the session
  var base = [];
  for(var i = 0; i < 6; ++i) {
    base.push({id: i, start: i * 100, end: i * 100 + 50, cStart: i * 100,
               cEnd: i * 100 + 50, lexPct: i / 5, raw: i});
  }
  var sel = function(extra) {
    var o = {algo: 'textrank', rankMode: 'lexical', aggressiveness: 50,
             useEmbeddings: false, clusterLabels: null, isExcluded: null,
             staged: []};
    for(var k in extra) { o[k] = extra[k]; }
    return sugSelectShown(base, o);
  };
  assert(ids(sel({})) === '3,4,5', 'v=50 keeps those at or above 0.505');
  assert(ids(sel({aggressiveness: 0})) === '5', 'v=0 keeps only the best');
  assert(ids(sel({aggressiveness: 100})) === '1,2,3,4,5', 'v=100 keeps ~99%');
  assert(ids(sel({algo: 'segmented', aggressiveness: 100})) === '0,1,2,3,4,5',
         'segment units: at 100 everything shows');
  assert(ids(sel({algo: 'segmented', aggressiveness: 99})) === '1,2,3,4,5',
         'segment units: below 100 the cut-off applies');
  var emb = base.map(function(b) {
    var o = {}; for(var k in b) { o[k] = b[k]; }
    o.embPct = 1 - b.lexPct;
    return o;
  });
  var blended = sugSelectShown(emb, {algo: 'textrank', rankMode: 'centroid',
    aggressiveness: 50, useEmbeddings: true, staged: []});
  assert(blended.length === 0,
         'blend (lex+emb)/2 = 0.5 is below the 0.505 cut-off');
  var blended_hi = sugSelectShown(emb, {algo: 'textrank', rankMode: 'centroid',
    aggressiveness: 60, useEmbeddings: true, staged: []});
  assert(blended_hi.length === 6, 'blend passes a lower cut-off');
  var lexical_only = sugSelectShown(emb, {algo: 'textrank', rankMode: 'lexical',
    aggressiveness: 50, useEmbeddings: false, staged: []});
  assert(ids(lexical_only) === '3,4,5', 'embeddings ignored when not used');
  assert(ids(sel({isExcluded: function(c) { return c.id === 3; },
                  staged: [{start: 400, end: 450}]})) === '5',
         'excluded speakers and accepted passages are dropped');
  var many = [];
  for(i = 0; i < 100; ++i) {
    many.push({id: i, start: i * 10, end: i * 10 + 5, cStart: i * 10,
               cEnd: i * 10 + 5, lexPct: i / 99, raw: i});
  }
  var capped = sugSelectShown(many, {algo: 'textrank', rankMode: 'lexical',
    aggressiveness: 100, useEmbeddings: false, staged: []});
  assert(capped.length === 80 && capped[0].c.id === 20 && capped[79].c.id === 99,
         'at most 80 suggestions, the best ones, in text order');

  // Themes: the top passages per cluster, near-duplicates skipped
  var cl = [
    {id: 0, start: 0, end: 10, cStart: 0, cEnd: 10, lexPct: 0.1, cluster: 0, clSim: 0.9, _vec: [1, 0]},
    {id: 1, start: 20, end: 30, cStart: 20, cEnd: 30, lexPct: 0.2, cluster: 0, clSim: 0.8, _vec: [1, 0.01]},
    {id: 2, start: 40, end: 50, cStart: 40, cEnd: 50, lexPct: 0.3, cluster: 0, clSim: 0.7, _vec: [0, 1]},
    {id: 3, start: 60, end: 70, cStart: 60, cEnd: 70, lexPct: 0.4, cluster: 1, clSim: 0.95, _vec: [0.7, 0.7]},
    {id: 4, start: 80, end: 90, cStart: 80, cEnd: 90, lexPct: 0.5, _vec: [0.7, 0.7]},
  ];
  var themed = function(v) {
    return ids(sugSelectShown(cl, {algo: 'textrank', rankMode: 'cluster',
      aggressiveness: v, useEmbeddings: true,
      clusterLabels: {0: 'T1', 1: 'T2'}, staged: []}));
  };
  assert(themed(0) === '0,3', 'v=0: one passage per theme: ' + themed(0));
  assert(themed(50) === '0,2,3', 'v=50: three per theme, the duplicate skipped: '
         + themed(50));
  assert(ids(sugSelectShown(cl, {algo: 'textrank', rankMode: 'cluster',
    aggressiveness: 100, useEmbeddings: true, clusterLabels: {}, staged: []}))
         === '0,1,2,3,4', 'cluster mode without labels falls back to the cut-off');

  // Clustering through a context (no session)
  var vecs = [];
  for(i = 0; i < 6; ++i) {
    vecs.push({id: i, _vec: i < 3 ? [1, 0.01 * i] : [0.01 * i, 1]});
  }
  var labels = sugClusterCands(vecs, {aggressiveness: 50});
  assert(Object.keys(labels).length >= 2 && vecs[0].cluster !== undefined
         && vecs[0].cluster === vecs[1].cluster
         && vecs[0].cluster !== vecs[5].cluster,
         'clusters separate two groups: ' + JSON.stringify(labels));
  assert(sugClusterCands([{_vec: [1]}], {aggressiveness: 50}) !== null
         && Object.keys(sugClusterCands([{_vec: [1]}], {aggressiveness: 50})).length === 0,
         'too few vectors: no clusters');

  // Algorithms through a context object (transcription mode comes from it)
  var text = 'The housing policy failed. The housing policy failed badly in the city. '
    + 'People moved away because the rent was too high. Yeah. Right.';
  var saved_tr = SUG_TRANSCRIPTION;
  var out = sugRunAlgoCands('textrank', {plainText: text, transcription: true,
                                          sentences: sugSplitSentences(text)}, false);
  assert(out.length > 0 && SUG_TRANSCRIPTION === saved_tr,
         'sugRunAlgoCands runs from a context and restores the global');

  // Curve serialization round trip keeps the numbers finite
  var res = {docIds: [1], rows: [{algo: 'textrank', rankMode: 'lexical',
    expand: false, auc: 0.7, f1: 0.4, precision: 0.3, recall: 0.6, fpr: 0.2,
    v: 45, curve: [{v: 45, precision: 0.3, recall: 0.6, fpr: 0.2}]}],
    best: {algo: 'textrank', rankMode: 'lexical', expand: false,
           aggressiveness: 45}, transcription: false, embKey: '', segParamsKey: ''};
  var ser = sugTuneSerialize(res);
  assert(ser.version === 1 && ser.rows[0].curve[0][2] === 0.6
         && JSON.parse(JSON.stringify(ser)).best.aggressiveness === 45,
         'serialization');

  // Resizing accepted highlights with the brackets (UTF-8: 'é' is 2 bytes)
  var rtext = 'ab cd éf gh ij kl mn op';
  var boc = [0], rb = 0;
  for(var ri = 0; ri < rtext.length; ++ri) {
    rb += rtext.charCodeAt(ri) > 127 ? 2 : 1;
    boc.push(rb);
  }
  var cob = function(c) { return boc[c]; };
  assert(sugCharOfByte(boc, 0) === 0 && sugCharOfByte(boc, 5) === 5
         && sugCharOfByte(boc, 99) === rtext.length && sugCharOfByte(boc, -4) === 0,
         'sugCharOfByte: exact and clamped');
  assert(sugCharOfByte(boc, 7) === 6 || sugCharOfByte(boc, 7) === 7,
         'sugCharOfByte: a byte inside a 2-byte char snaps to a boundary');
  var rng = {cStart: 6, cEnd: 14};
  var r1 = sugResizeRange(rng, 'end', cob(10) + 1, [], boc);
  assert(r1.cStart === 6 && r1.cEnd === sugCharOfByte(boc, cob(10) + 1)
         && r1.start === boc[6] && r1.end === boc[r1.cEnd], 'shrink the end');
  var r2 = sugResizeRange(rng, 'end', cob(7), [], boc);
  assert(r2.cEnd === 9, 'end keeps min gap of 3 characters: ' + r2.cEnd);
  var r3 = sugResizeRange(rng, 'start', cob(20), [], boc);
  assert(r3.cStart === 11 && r3.cEnd === 14, 'start cannot pass the end: ' + r3.cStart);
  var r4 = sugResizeRange(rng, 'start', cob(2),
                          [{start: cob(0), end: cob(4)}], boc);
  assert(r4.cStart === 4, 'start clamps at the previous highlight: ' + r4.cStart);
  var r5 = sugResizeRange(rng, 'end', cob(22),
                          [{start: cob(17), end: cob(19)}, {start: cob(0), end: cob(3)}], boc);
  assert(r5.cEnd === 17, 'end clamps at the next highlight: ' + r5.cEnd);
  var r6 = sugResizeRange(rng, 'end', cob(22), [], boc);
  assert(r6.cEnd === 22 && r6.end === boc[22], 'end can extend freely');
  var r7 = sugResizeRange(rng, 'start', cob(0),
                          [{start: cob(8), end: cob(10)}], boc);
  assert(r7.cStart === 0, 'a highlight inside the range does not block growing');

  console.log(failures === 0
    ? 'TUNE SELFTEST OK'
    : 'TUNE SELFTEST: ' + failures + ' failure(s)');
  return failures;
}

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
    + 'John: and again at dawn\n'
    + 'Interviewer:\nThank you.\n'
    + 'Maria:\nYou are welcome.';
  var abs_turns = sugTurnsOfText(abs_plain);
  assert(abs_turns.length === 7, 'turns absorb continuations, got '
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

  // "0:00 - Name (affiliation)" transcripts (Fathom/Zoom exports) with a
  // header line ending in a colon: every timed label opens a turn, the
  // header never swallows the document
  var timed_plain = 'Huw and Jacintha - October 22\n'
    + 'VIEW RECORDING - 119 mins (No highlights):\n'
    + '---\n'
    + '0:00 - Huw Evans (kayaguides.com)\n'
    + 'I think that anyone reading this.\n'
    + 'A second paragraph from Huw.\n'
    + '0:38 - Jacintha Baas (Charity Entrepreneurship)\n'
    + 'Cool. Call me after this call.\n'
    + '0:57 - Huw Evans (kayaguides.com)\n'
    + 'Wonderful.';
  var timed_turns = sugTurnsOfText(timed_plain);
  assert(timed_turns.length === 5, 'timed labels open turns, got '
         + timed_turns.length);
  assert(timed_turns[0].text === 'Huw and Jacintha - October 22',
         'title stays standalone');
  assert(timed_turns[1].text.indexOf('VIEW RECORDING') === 0
         && timed_turns[1].text.indexOf('Huw') === -1,
         'a one-off header label does not absorb the transcript');
  assert(timed_turns[2].text.indexOf('second paragraph') !== -1
         && timed_turns[2].contentStart
            === timed_plain.indexOf('I think that'),
         'timed turn absorbs its paragraphs, rectangle skips the label');
  assert(sugPrefixLabel('0:00 - Huw Evans (kayaguides.com)') === 'Huw Evans',
         'timed label drops the affiliation');
  assert(sugPrefixLabel('Speaker 1  0:03') === 'Speaker 1',
         'name + unbracketed timestamp');
  assert(sugIsPrefixLine('Maria da Silva - 00:12:34'),
         'name particles and trailing timestamp');
  assert(!sugIsPrefixLine('We met at 10:30')
         && !sugIsPrefixLine('10:30 we left the house'),
         'sentences around a time are not timed labels');
  // Rendered documents: paragraphs sit back to back in plainText (no
  // newline), blocks come from the DOM walk
  var dom_paras = ['Notes:', 'Intro', '0:00 - Ana Lima (x.org)', 'Hello',
                   'More from Ana', '0:05 - Ben (y)', 'Hi', '0:09 - Ana Lima (x.org)',
                   'Bye'];
  var dom_plain = dom_paras.join('');
  var dom_blocks = [], dom_pos = 0;
  dom_paras.forEach(function(p) {
    dom_blocks.push({start: dom_pos, end: dom_pos + p.length, text: p});
    dom_pos += p.length;
  });
  var dom_turns = sugAbsorbContinuations(
    sugMergePrefixBlocks(dom_blocks, dom_plain), dom_plain);
  assert(dom_turns.length === 4 && dom_turns[1].text
         === '0:00 - Ana Lima (x.org)HelloMore from Ana',
         'DOM turns absorb without newlines, got ' + dom_turns.length);
  var dom_scan = sugPreScanPrefixes(dom_turns);
  assert(dom_scan.labels[0].label === 'Ana Lima'
         && dom_scan.labels[0].count === 2,
         'pre-scan reads the folded prefix in DOM turns');
  var preamble = sugTurnsOfText('Notes:\nFirst preamble paragraph\n'
    + 'Second preamble paragraph\nAna:\nHello\nBen:\nHi\nAna:\nBye');
  assert(preamble.length === 5 && preamble[1].text
         === 'Second preamble paragraph',
         'preamble paragraphs never absorb each other, got '
         + preamble.length);

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
    ls.setItem('taguette_config', JSON.stringify({version: 1, keys: [],
      tasks: {decisions: {source: 'local:laya'}},
      segmentation_params: {tau: 0.4}}));
    var dec_res = taguTaskResolve('decisions', '');
    assert(dec_res && dec_res.local && dec_res.local.kind === 'decisions'
           && dec_res.url === 'http://localhost:8000/v1/systemone',
           'local:laya resolves to the system-one endpoint');
    taguConfigSave(taguConfig());
    assert(taguConfig().segmentation_params
           && taguConfig().segmentation_params.tau === 0.4,
           'segmentation_params survives a config save round trip');
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

  // Segment-based suggestions: extra fields through the merge
  var mc = sugMergeOverlaps([
    {start: 0, end: 10, raw: 0.6, lexPct: 0.2, cStart: 0, cEnd: 10,
     tags: [{id: 1}], section_id: 'a', ticked: [1]},
    {start: 5, end: 20, raw: 0.9, lexPct: 0.5, cStart: 5, cEnd: 20,
     tags: [{id: 2}], section_id: 'b', ticked: [2]},
    {start: 30, end: 40, raw: 0.5, lexPct: 0.1, cStart: 30, cEnd: 40,
     tags: [{id: 3}], section_id: 'c', ticked: []},
  ]);
  assert(mc.length === 2 && mc[0].end === 20 && mc[0].raw === 0.9,
         'merge unions spans');
  assert(mc[0].section_id === 'b' && mc[0].tags[0].id === 2
         && mc[0].ticked[0] === 2, 'merge keeps extras of the higher-raw candidate');
  assert(mc[1].section_id === 'c', 'non-overlapping candidate untouched');
  assert(typeof SUG_ALGOS.segmented.run === 'function'
         && SUG_MARKER_SELECTOR.indexOf('.seg-separator') !== -1,
         'segmented algorithm and marker selector registered');

  failures += sugTuneSelfTest();

  if(typeof segAiSelfTest === 'function') {
    segAiSelfTest().then(function(n) {
      console.log('segAiSelfTest: ' + n + ' failure(s)');
    });
  }
  if(typeof segSelfTest === 'function') {
    segSelfTest().then(function(n) {
      console.log('segSelfTest: ' + n + ' failure(s)');
    });
  }

  console.log(failures === 0
    ? 'SELFTEST OK'
    : 'SELFTEST: ' + failures + ' failure(s)');
  return failures;
}

if(typeof window !== 'undefined' && window.location
   && window.location.search.indexOf('suggest_selftest=1') !== -1) {
  window.addEventListener('load', sugSelfTest);
}
