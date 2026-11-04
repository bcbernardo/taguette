/*
 * Tag AI helpers (LLM + NLP for tagging)
 *
 * Client-side features that streamline repetitive tagging work, in the same
 * spirit as suggested highlights (suggest.js): all model calls go straight
 * from the browser to an OpenAI-compatible chat/embeddings endpoint with
 * the user's own key, and nothing is sent to the Taguette server.
 *
 * 1. Highlight form: the tag list shows the top 10 tags ranked for the
 *    highlighted text (semantic when an embedding service is configured,
 *    lexical bag-of-words otherwise), with a "Show all tags" toggle and a
 *    search bar that mimics the Highlights panel's (lexical + semantic).
 * 2. Tag form, creating from a highlight: the configured LLM suggests 3
 *    tag names (light gray, one click copies one into the name field).
 * 3. Tag form: "Generate/Re-generate description with AI" writes a
 *    definition from the tag name + highlight (new tags) or from all the
 *    tag's highlights (existing tags); the suggestion is previewed and can
 *    be accepted, retried or discarded. With an existing description, an
 *    "Augment description with AI" menu appends an Examples / Includes /
 *    Do-not-confound-with section (the last one fed with cosine-similar
 *    non-ancestor tags).
 * 4. Tag form: the most cosine-similar tags are listed below the
 *    description; clicking one offers "Set as parent", "Set as descendant"
 *    and "Merge".
 *
 * The model, temperature and prompt templates are configured in the
 * configuration screen's "AI tags" tab (task id 'llm' in the shared store).
 */

/*
 * Local chat services for the 'llm' task (config.js's TAGU_LOCALS is added
 * to rather than modified: the embeddings locals keep their own entries).
 */
TAGU_LOCALS.ollama_chat = {
  label: 'Ollama', url: 'http://localhost:11434', probe: '/',
  path: '/v1/chat/completions', kind: 'llm',
  install: 'Install Ollama from <a href="https://ollama.com">ollama.com</a>, '
    + 'pull a chat model (<code>ollama pull llama3.1</code>) and start it '
    + 'with browser access allowed: <code>OLLAMA_ORIGINS=* ollama serve</code>',
};
TAGU_LOCALS.llamacpp_chat = {
  label: 'llama.cpp server', url: 'http://localhost:8080', probe: '/health',
  path: '/v1/chat/completions', kind: 'llm',
  install: 'Build the llama.cpp server and run it with a chat model: '
    + '<code>llama-server -m llama3.1-8b.gguf</code>',
};

var TAG_AI_TEMPERATURE = 0.4;
var TAG_AI_SYSTEM = 'You are an assistant for qualitative data analysis '
  + '(tagging, coding) in Taguette. Follow the user\'s formatting '
  + 'instructions exactly.';

/*
 * Default prompt templates. Users can override each one in the "AI tags"
 * tab; placeholders in {{double braces}} are filled by tagAiPrompt().
 */
var TAG_AI_PROMPTS = {
  names: 'You are helping a qualitative researcher tag (code) excerpts of interviews and documents in Taguette.\n'
    + '\n'
    + 'Suggest 3 tag names for the highlighted excerpt below. A tag name is a short key phrase (1-4 words, lowercase) naming the theme the excerpt is really about, not a quote from it.\n'
    + '\n'
    + 'Tags that already exist (do not duplicate or nearly duplicate them):\n'
    + '{{tags}}\n'
    + '\n'
    + 'Answer with exactly 3 names, one per line, no numbering, no extra commentary.\n'
    + '\n'
    + 'Highlighted excerpt:\n'
    + '"""\n'
    + '{{highlight}}\n'
    + '"""\n',

  description: 'You are helping a qualitative researcher write definitions for the tags (codes) of a Taguette project.\n'
    + '\n'
    + 'Write a concise definition (2-4 sentences, plain text) for the tag "{{tag}}": what it covers and when to apply it, grounded in the excerpts below.\n'
    + '\n'
    + 'Current definition (may be empty or partial): {{description}}\n'
    + '\n'
    + 'Excerpts highlighted with this tag:\n'
    + '"""\n'
    + '{{highlights}}\n'
    + '"""\n',

  augment_examples: 'You are helping a qualitative researcher maintain the definitions of the tags (codes) of a Taguette project.\n'
    + '\n'
    + 'Append an "Examples:" section to the definition of the tag "{{tag}}" below: 1-3 short, telling example excerpts quoted from the highlights (each at most ~20 words, in quotation marks, separated by " — "). Answer with only the "Examples:" section, no preamble.\n'
    + '\n'
    + 'Current definition:\n'
    + '{{description}}\n'
    + '\n'
    + 'Excerpts highlighted with this tag:\n'
    + '"""\n'
    + '{{highlights}}\n'
    + '"""\n',

  augment_includes: 'You are helping a qualitative researcher maintain the definitions of the tags (codes) of a Taguette project.\n'
    + '\n'
    + 'Append an "Includes:" section to the definition of the tag "{{tag}}" below: a short list of the subtopics and themes the tag covers, grounded in the excerpts. Answer with only the "Includes:" section (a list, one item per line, prefixed with "- "), no preamble.\n'
    + '\n'
    + 'Current definition:\n'
    + '{{description}}\n'
    + '\n'
    + 'Excerpts highlighted with this tag:\n'
    + '"""\n'
    + '{{highlights}}\n'
    + '"""\n',

  augment_confound: 'You are helping a qualitative researcher maintain the definitions of the tags (codes) of a Taguette project.\n'
    + '\n'
    + 'Append a "Do not confound with:" section to the definition of the tag "{{tag}}": for each similar tag below, one short line in the form "- TAG — theme of that tag in a few words, and how it differs from {{tag}}". Ground the distinctions in the excerpts.\n'
    + '\n'
    + 'Current definition:\n'
    + '{{description}}\n'
    + '\n'
    + 'Similar tags (name — definition):\n'
    + '{{similar}}\n'
    + '\n'
    + 'Excerpts highlighted with "{{tag}}":\n'
    + '"""\n'
    + '{{highlights}}\n'
    + '"""\n',
};

var TAG_AI_PROMPT_LABELS = {
  names: gettext('Tag name suggestions'),
  description: gettext('Tag description'),
  augment_examples: gettext('Augment: examples'),
  augment_includes: gettext('Augment: includes'),
  augment_confound: gettext('Augment: do not confound with'),
};

/*
 * Small text helpers (pure, exercised by the self-test)
 */

function tagAiTruncate(text, max_chars) {
  text = String(text || '');
  if(text.length <= max_chars) {
    return text;
  }
  return text.substr(0, max_chars - 1) + '…';
}

function tagAiStripHtml(html) {
  var div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').trim();
}

// Word bag over content words (stopwords dropped), for the lexical ranking
function tagAiWordBag(text) {
  var bag = {};
  var toks = sugTokenize(String(text).toLowerCase());
  for(var i = 0; i < toks.length; ++i) {
    var w = toks[i].word;
    if(w.length < 2 || sugIsStop(w)) {
      continue;
    }
    bag[w] = (bag[w] || 0) + 1;
  }
  return bag;
}

function tagAiBagCosine(a, b) {
  var dot = 0, na = 0, nb = 0, w;
  for(w in a) {
    na += a[w] * a[w];
    if(b[w]) {
      dot += a[w] * b[w];
    }
  }
  for(w in b) {
    nb += b[w] * b[w];
  }
  if(!na || !nb) {
    return 0;
  }
  return dot / Math.sqrt(na * nb);
}

// Rank tags against a query text by lexical similarity. entries is an
// Object.entries()-style list; returns [{tag, score}] sorted, score > 0
function tagAiLexicalRank(query, entries) {
  var qbag = tagAiWordBag(query);
  if(!Object.keys(qbag).length) {
    return [];
  }
  var out = [];
  for(var i = 0; i < entries.length; ++i) {
    var tag = entries[i][1];
    var score = tagAiBagCosine(qbag, tagAiWordBag(tagSearchText(tag)));
    if(score > 0) {
      out.push({tag: tag, score: score});
    }
  }
  out.sort(function(a, b) { return b.score - a.score; });
  return out;
}

// Evenly sample long highlight lists so the LLM sees the whole range of
// the tag's use, not just its beginning
function tagAiSampleExcerpts(texts, max_count, max_len) {
  max_count = max_count || 40;
  max_len = max_len || 300;
  if(texts.length <= max_count) {
    return texts.map(function(t) { return tagAiTruncate(t, max_len); });
  }
  var step = texts.length / max_count;
  var out = [];
  for(var i = 0; i < max_count; ++i) {
    out.push(tagAiTruncate(texts[Math.floor(i * step)], max_len));
  }
  return out;
}

// Parse a "3 names, one per line" LLM answer into clean tag names
function tagAiParseNames(text) {
  var names = [];
  String(text || '').split(/\r?\n/).forEach(function(line) {
    line = line.trim()
      .replace(/^[-*•\d.).\s]+/, '')        // bullets and numbering
      .replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '')  // quotes
      .replace(/\*+/g, '')                  // markdown emphasis
      .trim();
    if(!line || line.length > 60) {
      return;
    }
    if(names.indexOf(line) === -1) {
      names.push(line);
    }
  });
  return names.slice(0, 3);
}

// Fill a prompt template's {{placeholders}}; unknown names are kept as-is
// so a typo in a custom template stays visible
function tagAiPrompt(cfg, key, vars) {
  var tpl = (cfg.prompts && cfg.prompts[key]) || TAG_AI_PROMPTS[key];
  return String(tpl).replace(/\{\{(\w+)\}\}/g, function(match, name) {
    return vars.hasOwnProperty(name) ? vars[name] : match;
  });
}

/*
 * LLM client (OpenAI-compatible /chat/completions endpoint)
 */

function tagAiLLMConfig() {
  var task = taguConfig().tasks.llm;
  var resolved = taguResolveTask(task, '/chat/completions');
  if(!resolved || !resolved.url) {
    return null;
  }
  resolved.temperature = (task && typeof task.temperature === 'number')
    ? task.temperature : TAG_AI_TEMPERATURE;
  resolved.prompts = (task && task.prompts) || {};
  return resolved;
}

// resolved: {url, token, model, authHeader, authScheme, temperature}
function tagAiChat(resolved, prompt, max_tokens) {
  var headers = {'Content-Type': 'application/json'};
  taguApplyAuth(headers, resolved);
  return fetch(resolved.url, {
    method: 'POST',
    mode: 'cors',
    headers: headers,
    body: JSON.stringify({
      model: resolved.model || '',
      messages: [
        {role: 'system', content: TAG_AI_SYSTEM},
        {role: 'user', content: prompt},
      ],
      temperature: resolved.temperature,
      max_tokens: max_tokens || 500,
    }),
  }).then(function(response) {
    if(response.status != 200) {
      throw new Error('HTTP ' + response.status);
    }
    return response.json();
  }).then(function(json) {
    var content = json.choices && json.choices[0]
      && json.choices[0].message && json.choices[0].message.content;
    if(typeof content !== 'string') {
      throw new Error(gettext('Unexpected response shape'));
    }
    return content.trim();
  });
}

/*
 * Text of the highlight being created/edited in the highlight form. New
 * highlights: the selection at the moment the form opens (captured by the
 * createHighlight wrapper below). Existing highlights: the wrapped spans
 * in the document view.
 */

var tag_ai_last_selection_text = '';

(function() {
  if(typeof createHighlight !== 'function') {
    return;
  }
  var orig = createHighlight;
  window.createHighlight = function(selection) {
    try {
      tag_ai_last_selection_text = String(window.getSelection());
    } catch(e) {
      tag_ai_last_selection_text = '';
    }
    return orig(selection);
  };
})();

function tagAiHighlightText() {
  var id = document.getElementById('highlight-add-id').value;
  if(id && typeof highlights !== 'undefined') {
    var elements = document.getElementsByClassName('highlight-' + id);
    var text = '';
    for(var i = 0; i < elements.length; ++i) {
      text += (text ? '\n' : '') + elements[i].textContent;
    }
    if(text.trim()) {
      return text.trim();
    }
  }
  return (tag_ai_last_selection_text || '').trim();
}

/*
 * Highlight form: ranked suggestions + search
 *
 * taguette.js's updateTagsList() asks tagAiModalView() how to render the
 * modal's tag list: {visible: {id: true}} filters, {order: [tag, ...]}
 * renders a flat ranked list; null parts mean "no restriction". While the
 * modal is closed (or nothing can be ranked) the list is the full tree.
 */

var TAG_AI_TOP_N = 10;

var tag_ai_modal = {
  open: false,
  text: '',
  ranked: [],        // [{tag, score}], lexical or semantic
  semantic: false,
  pending: false,
  show_all: false,
  matches: null,     // {tag_id: true} while a search is active
  search_semantic: 0,
  seq: 0,
};

function tagAiModalView() {
  if(!tag_ai_modal.open) {
    return null;
  }
  if(tag_ai_modal.matches) {
    // Search overrides the ranking: show the matches plus their ancestors
    // so the tree stays readable (mirrors the Highlights panel)
    var visible = {};
    var entries = Object.entries(tags);
    for(var i = 0; i < entries.length; ++i) {
      var tag = entries[i][1];
      if(tag_ai_modal.matches[tag.id]) {
        visible[tag.id] = true;
        var ancestors = tagAncestorsOf(tag);
        for(var j = 0; j < ancestors.length; ++j) {
          visible[ancestors[j].id] = true;
        }
      }
    }
    return {visible: visible, order: null};
  }
  if(tag_ai_modal.show_all || !tag_ai_modal.ranked.length) {
    return null;
  }
  var order = [];
  var top = {};
  for(var k = 0; k < tag_ai_modal.ranked.length && order.length < TAG_AI_TOP_N; ++k) {
    var t = tag_ai_modal.ranked[k].tag;
    top[t.id] = true;
    order.push(t);
  }
  // A tag just created from this form stays visible even if unranked
  if(tag_to_select_in_highlight !== null && !top[tag_to_select_in_highlight]
     && tags['' + tag_to_select_in_highlight]) {
    top[tag_to_select_in_highlight] = true;
    order.unshift(tags['' + tag_to_select_in_highlight]);
    if(order.length > TAG_AI_TOP_N) {
      delete top[order[order.length - 1].id];
      order.pop();
    }
  }
  return {visible: top, order: order};
}

function tagAiModalRefreshStatus() {
  var el = document.getElementById('highlight-add-search-status');
  if(!el) {
    return;
  }
  if(tag_ai_modal.matches) {
    var n = Object.keys(tag_ai_modal.matches).length;
    var text = gettext('%(n)s tags match', {n: n});
    if(tag_ai_modal.search_semantic > 0) {
      text += ' · ' + gettext('%(n)s by semantic similarity',
                              {n: tag_ai_modal.search_semantic});
    }
    el.textContent = text;
    return;
  }
  if(tag_ai_modal.pending) {
    el.textContent = gettext('Ranking tags…');
    return;
  }
  if(tag_ai_modal.show_all || !tag_ai_modal.text || !tag_ai_modal.ranked.length) {
    el.textContent = '';
    return;
  }
  el.textContent = gettext('Top %(n)s suggested tags',
                           {n: Math.min(TAG_AI_TOP_N, tag_ai_modal.ranked.length)})
    + ' (' + (tag_ai_modal.semantic ? gettext('semantic') : gettext('lexical')) + ')';
}

function tagAiSyncShowAll() {
  var li = document.getElementById('highlight-add-showall-li');
  var link = document.getElementById('highlight-add-showall');
  if(!li || !link) {
    return;
  }
  if(!tag_ai_modal.ranked.length) {
    li.style.display = 'none';
    return;
  }
  li.style.display = '';
  link.textContent = (tag_ai_modal.show_all || tag_ai_modal.matches)
    ? gettext('Show only suggested tags')
    : gettext('Show all tags');
}

function tagAiRankHighlightModal() {
  var seq = ++tag_ai_modal.seq;
  var text = tagAiHighlightText();
  tag_ai_modal.text = text;
  tag_ai_modal.ranked = [];
  tag_ai_modal.semantic = false;
  tag_ai_modal.pending = false;
  tag_ai_modal.show_all = false;
  tag_ai_modal.matches = null;
  tag_ai_modal.search_semantic = 0;

  var entries = Object.entries(tags);
  if(!text || !entries.length) {
    tagAiSyncShowAll();
    tagAiModalRefreshStatus();
    updateTagsList();
    return;
  }

  // Lexical ranking is instant; the semantic one replaces it when the
  // configured embedding service answers
  tag_ai_modal.ranked = tagAiLexicalRank(text, entries);
  tagAiSyncShowAll();
  tagAiModalRefreshStatus();
  updateTagsList();

  var emb = (typeof sugLoadConfig === 'function') ? sugLoadConfig() : null;
  if(!emb) {
    return;
  }
  tag_ai_modal.pending = true;
  tagAiModalRefreshStatus();
  var texts = entries.map(function(e) { return tagSearchText(e[1]); });
  sugEmbed([tagAiTruncate(text, 1500)].concat(texts), emb)
  .then(function(vectors) {
    if(seq !== tag_ai_modal.seq || !tag_ai_modal.open) {
      return;
    }
    var scored = [];
    for(var i = 0; i < entries.length; ++i) {
      scored.push({tag: entries[i][1],
                   score: sugCosine(vectors[0], vectors[i + 1])});
    }
    scored.sort(function(a, b) { return b.score - a.score; });
    tag_ai_modal.ranked = scored;
    tag_ai_modal.semantic = true;
    tag_ai_modal.pending = false;
    tagAiSyncShowAll();
    tagAiModalRefreshStatus();
    updateTagsList();
  })
  .catch(function(error) {
    if(seq !== tag_ai_modal.seq || !tag_ai_modal.open) {
      return;
    }
    tag_ai_modal.pending = false;
    console.log('Semantic tag ranking unavailable:', error);
    tagAiModalRefreshStatus();
  });
}

// Search inside the highlight form: same lexical + adaptive-cutoff
// semantic logic as the Highlights panel's search bar
function tagAiModalSearchRun() {
  var input = document.getElementById('highlight-add-search');
  var q = input ? input.value.trim().toLowerCase() : '';
  var seq = ++tag_ai_modal.seq;
  tag_ai_modal.search_semantic = 0;

  if(!q) {
    tag_ai_modal.matches = null;
    tagAiSyncShowAll();
    tagAiModalRefreshStatus();
    updateTagsList();
    return;
  }

  var entries = Object.entries(tags);
  var matches = {};
  for(var i = 0; i < entries.length; ++i) {
    if(tagSearchText(entries[i][1]).toLowerCase().indexOf(q) !== -1) {
      matches[entries[i][1].id] = true;
    }
  }
  tag_ai_modal.matches = matches;
  tagAiSyncShowAll();
  tagAiModalRefreshStatus();
  updateTagsList();

  var emb = (typeof sugLoadConfig === 'function') ? sugLoadConfig() : null;
  if(!emb || !entries.length) {
    return;
  }
  var texts = entries.map(function(e) { return tagSearchText(e[1]); });
  sugEmbed([q].concat(texts), emb)
  .then(function(vectors) {
    if(seq !== tag_ai_modal.seq) {
      return;
    }
    var scored = [];
    for(var i = 0; i < entries.length; ++i) {
      var tag = entries[i][1];
      if(matches[tag.id]) {
        continue;
      }
      scored.push({tag: tag, score: sugCosine(vectors[0], vectors[i + 1])});
    }
    var cutoff = Math.max(
      TAG_SEARCH_SEMANTIC_FLOOR,
      tagSearchMedian(scored.map(function(s) { return s.score; }))
        + TAG_SEARCH_SEMANTIC_MARGIN);
    var added = 0;
    for(var j = 0; j < scored.length; ++j) {
      if(scored[j].score >= cutoff) {
        matches[scored[j].tag.id] = true;
        added++;
      }
    }
    tag_ai_modal.search_semantic = added;
    tagAiModalRefreshStatus();
    updateTagsList();
  })
  .catch(function(error) {
    if(seq !== tag_ai_modal.seq) {
      return;
    }
    console.log('Semantic tag search unavailable:', error);
    tagAiModalRefreshStatus();
  });
}

var tag_ai_modal_search_timer = null;

// Wiring is deferred to window load: jQuery is loaded at the end of the
// page (see base.html), after this script
window.addEventListener('load', function() {
  var modal = document.getElementById('highlight-add-modal');
  if(modal) {
    $(modal)
    .on('show.bs.modal', function() {
      tag_ai_modal.open = true;
      var input = document.getElementById('highlight-add-search');
      if(input) {
        input.value = '';
      }
      tagAiRankHighlightModal();
    })
    .on('hidden.bs.modal', function() {
      tag_ai_modal.open = false;
      tag_ai_modal.matches = null;
      ++tag_ai_modal.seq;  // make any in-flight ranking/search stale
      updateTagsList();    // restore the full tree
    });
  }

  var input = document.getElementById('highlight-add-search');
  if(input) {
    input.addEventListener('input', function() {
      window.clearTimeout(tag_ai_modal_search_timer);
      tag_ai_modal_search_timer = window.setTimeout(tagAiModalSearchRun, 300);
    });
    input.addEventListener('keydown', function(e) {
      if(e.key === 'Enter') {
        e.preventDefault();
        window.clearTimeout(tag_ai_modal_search_timer);
        tagAiModalSearchRun();
      }
    });
  }
  var run = document.getElementById('highlight-add-search-run');
  if(run) {
    run.addEventListener('click', function() {
      window.clearTimeout(tag_ai_modal_search_timer);
      tagAiModalSearchRun();
    });
  }
  var clear = document.getElementById('highlight-add-search-clear');
  if(clear) {
    clear.addEventListener('click', function() {
      var input = document.getElementById('highlight-add-search');
      if(input) {
        input.value = '';
      }
      tagAiModalSearchRun();
      if(input) {
        input.focus();
      }
    });
  }
  var showall = document.getElementById('highlight-add-showall');
  if(showall) {
    showall.addEventListener('click', function(e) {
      e.preventDefault();
      var input = document.getElementById('highlight-add-search');
      if(input && input.value) {
        input.value = '';
        tag_ai_modal.matches = null;
      }
      tag_ai_modal.show_all = !tag_ai_modal.show_all;
      tagAiSyncShowAll();
      tagAiModalRefreshStatus();
      updateTagsList();
    });
  }
});

/*
 * Tag form: LLM name suggestions, description generation/augmentation,
 * similar tags
 */

var tag_ai_tag = {
  modal_open: false,
  editing: null,       // tag id being edited, null when creating
  similar: [],         // [{tag, score}]
  similar_seq: 0,
  seq: 0,              // guards name suggestions and description runs
  pending: {},         // similar-tag actions for a tag that doesn't exist
                       // yet: {descendant: id, merge: id}
};

function tagAiTagModalOpen() {
  var id_input = document.getElementById('tag-add-id');
  tag_ai_tag.modal_open = true;
  tag_ai_tag.editing = id_input && id_input.value ? parseInt(id_input.value) : null;
  tag_ai_tag.similar = [];
  ++tag_ai_tag.similar_seq;
  ++tag_ai_tag.seq;
  tag_ai_tag.pending = {};

  var names = document.getElementById('tag-add-name-suggestions');
  if(names) {
    names.style.display = 'none';
    names.textContent = '';
  }
  tagAiDescPreviewHide();
  var similar = document.getElementById('tag-add-similar');
  if(similar) {
    similar.style.display = 'none';
    similar.textContent = '';
  }

  var has_desc = !!document.getElementById('tag-add-description').value.trim();
  var generate = document.getElementById('tag-add-desc-generate');
  if(generate) {
    generate.innerHTML = '<i class="fas fa-magic"></i> '
      + (has_desc
         ? gettext('Re-generate description with AI')
         : gettext('Generate description with AI'));
  }
  var augment = document.getElementById('tag-add-augment-wrap');
  if(augment) {
    augment.style.display = has_desc ? '' : 'none';
  }

  // Name suggestions need the highlighted text as context: only when the
  // form is opened from the highlight form
  if(tag_ai_tag.editing === null
     && highlight_add_modal.classList.contains('show')) {
    tagAiSuggestNames();
  }
  tagAiSimilarRefresh();
}

/*
 * Name suggestions
 */

function tagAiSuggestNames() {
  var box = document.getElementById('tag-add-name-suggestions');
  if(!box) {
    return;
  }
  var cfg = tagAiLLMConfig();
  var text = tagAiTruncate(tagAiHighlightText(), 1500);
  if(!cfg || !text) {
    box.style.display = 'none';
    return;
  }
  var seq = tag_ai_tag.seq;
  box.style.display = '';
  box.textContent = gettext('Suggestions: thinking…');
  var existing = Object.entries(tags)
    .map(function(e) { return e[1].path; })
    .sort()
    .join(', ');
  var prompt = tagAiPrompt(cfg, 'names', {
    highlight: text,
    tags: tagAiTruncate(existing, 2000) || gettext('(none yet)'),
  });
  tagAiChat(cfg, prompt, 150)
  .then(function(content) {
    if(seq !== tag_ai_tag.seq) {
      return;
    }
    var names = tagAiParseNames(content);
    if(!names.length) {
      box.textContent = gettext('Suggestions: none');
      return;
    }
    box.textContent = gettext('Suggestions:') + ' ';
    names.forEach(function(name, i) {
      if(i > 0) {
        box.appendChild(document.createTextNode(' '));
      }
      var chip = document.createElement('a');
      chip.href = 'javascript:void(0)';
      chip.className = 'tag-ai-chip';
      chip.textContent = name;
      chip.title = gettext('Use this name — you can edit it afterwards');
      chip.addEventListener('click', function(e) {
        e.preventDefault();
        var input = document.getElementById('tag-add-path');
        input.value = name;
        tagAddPathFit();
        input.focus();
        tagAiSimilarRefresh();
      });
      box.appendChild(chip);
    });
  })
  .catch(function(error) {
    if(seq !== tag_ai_tag.seq) {
      return;
    }
    box.textContent = gettext('Suggestions: failed') + ' (' + error + ')';
  });
}

/*
 * Description generation and augmentation
 */

// Fetch every highlight of a tag (the endpoint returns the highlights of
// the tag and of its descendants, paginated), as plain-text excerpts
function tagAiFetchHighlights(tag) {
  if(!tag) {
    return Promise.resolve([]);
  }
  var base = '/api/project/' + project_id + '/highlights/'
    + encodeURIComponent(tag.path) + '?page=';
  var texts = [];
  function page(n) {
    // shortcut: 20 pages = 1000 excerpts is already generous context
    if(n > 20) {
      return Promise.resolve();
    }
    return getJSON(base + n).then(function(result) {
      for(var i = 0; i < result.highlights.length; ++i) {
        texts.push(tagAiStripHtml(result.highlights[i].content));
      }
      if(n < (result.pages || 1)) {
        return page(n + 1);
      }
    });
  }
  return page(1).then(function() {
    return texts.filter(function(t) { return t; });
  });
}

function tagAiCurrentTagText() {
  var name = document.getElementById('tag-add-path').value.trim();
  var desc = document.getElementById('tag-add-description').value.trim();
  return (name + '\n' + desc).trim();
}

function tagAiDescVars(mode) {
  var name = document.getElementById('tag-add-path').value.trim();
  var desc = document.getElementById('tag-add-description').value.trim();
  function finish(excerpts) {
    var vars = {
      tag: name,
      description: desc || gettext('(none yet)'),
      highlights: excerpts.length
        ? tagAiSampleExcerpts(excerpts).join('\n---\n')
        : gettext('(no highlights yet)'),
    };
    if(mode !== 'augment_confound') {
      return Promise.resolve(vars);
    }
    // The confounding section needs the cosine-similar non-ancestor tags
    return tagAiSimilarTagsPromise(5).then(function(similar) {
      vars.similar = similar.length
        ? similar.map(function(s) {
            return s.tag.path + ' — '
              + (s.tag.description || gettext('(no definition)'));
          }).join('\n')
        : gettext('(none found)');
      return vars;
    });
  }
  if(tag_ai_tag.editing !== null) {
    // Editing an existing tag: all of its highlights are the context
    return tagAiFetchHighlights(tags['' + tag_ai_tag.editing])
      .then(finish);
  }
  // Creating: the highlighted text is the context
  var hl = tagAiTruncate(tagAiHighlightText(), 1500);
  return Promise.resolve(finish(hl ? [hl] : []));
}

var TAG_AI_DESC_MODES = {
  generate: 'description',
  augment_examples: 'augment_examples',
  augment_includes: 'augment_includes',
  augment_confound: 'augment_confound',
};

function tagAiDescPreviewSet(text) {
  var box = document.getElementById('tag-add-desc-preview');
  if(!box) {
    return;
  }
  box.style.display = '';
  box.textContent = '';
  box.appendChild(taguEl('div', 'tag-ai-preview-label', gettext('AI suggestion:')));
  var body = taguEl('div', 'tag-ai-preview-text');
  body.textContent = text;
  box.appendChild(body);
  return box;
}

function tagAiDescPreviewHide() {
  var box = document.getElementById('tag-add-desc-preview');
  if(box) {
    box.style.display = 'none';
    box.textContent = '';
  }
}

function tagAiDescRun(mode) {
  var cfg = tagAiLLMConfig();
  if(!cfg) {
    var note = tagAiDescPreviewSet(
      gettext('No AI model configured — open ⚙ Configure → AI tags to pick one.'));
    if(note) {
      note.classList.add('tag-ai-preview-error');
    }
    return;
  }
  var name = document.getElementById('tag-add-path').value.trim();
  if(!name) {
    alert(gettext('Enter a tag name first'));
    return;
  }
  var seq = ++tag_ai_tag.seq;
  var box = tagAiDescPreviewSet(gettext('Asking the AI model…'));
  if(box) {
    box.classList.add('tag-ai-preview-loading');
  }
  tagAiDescVars(mode)
  .then(function(vars) {
    return tagAiChat(cfg, tagAiPrompt(cfg, TAG_AI_DESC_MODES[mode], vars), 600);
  })
  .then(function(content) {
    if(seq !== tag_ai_tag.seq) {
      return;
    }
    tagAiDescPreviewShow(mode, content);
  })
  .catch(function(error) {
    if(seq !== tag_ai_tag.seq) {
      return;
    }
    var err = tagAiDescPreviewSet(gettext('Failed:') + ' ' + error);
    if(err) {
      err.classList.add('tag-ai-preview-error');
    }
  });
}

function tagAiDescPreviewShow(mode, text) {
  var box = tagAiDescPreviewSet(text);
  if(!box) {
    return;
  }
  var row = taguEl('div', 'mt-2');
  function button(label, cls, fn) {
    var b = taguEl('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  row.appendChild(button(gettext('Accept'), 'btn btn-sm btn-primary', function() {
    var textarea = document.getElementById('tag-add-description');
    if(mode === 'generate') {
      textarea.value = text;
    } else {
      var current = textarea.value.trim();
      textarea.value = current + (current ? '\n\n' : '') + text;
    }
    tagAiDescPreviewHide();
    tagAiSimilarRefresh();
  }));
  row.appendChild(button(gettext('Try again'),
    'btn btn-sm btn-outline-secondary ml-1', function() {
      tagAiDescRun(mode);
    }));
  row.appendChild(button(gettext('Discard'),
    'btn btn-sm btn-outline-secondary ml-1', tagAiDescPreviewHide));
  box.appendChild(row);
}

/*
 * Similar tags (cosine-similar when embeddings are configured, lexical
 * otherwise), with a context menu to organize the hierarchy
 */

// Pure: which tags are candidates for the similar list
function tagAiSimilarCandidates(entries, editing_id) {
  var out = [];
  for(var i = 0; i < entries.length; ++i) {
    var tag = entries[i][1];
    if(editing_id !== null && tag.id === editing_id) {
      continue;
    }
    if(editing_id !== null
       && (tagIsDescendant(tag.id, editing_id)     // own descendants
           || tagIsDescendant(editing_id, tag.id))) {  // own ancestors
      continue;
    }
    out.push(tag);
  }
  return out;
}

function tagAiSimilarTagsPromise(limit) {
  limit = limit || 5;
  var text = tagAiCurrentTagText();
  if(!text) {
    return Promise.resolve([]);
  }
  var candidates = tagAiSimilarCandidates(Object.entries(tags),
                                          tag_ai_tag.editing);
  if(!candidates.length) {
    return Promise.resolve([]);
  }
  var emb = (typeof sugLoadConfig === 'function') ? sugLoadConfig() : null;
  if(emb) {
    var texts = candidates.map(function(t) { return tagSearchText(t); });
    return sugEmbed([text].concat(texts), emb)
    .then(function(vectors) {
      var scored = [];
      for(var i = 0; i < candidates.length; ++i) {
        var score = sugCosine(vectors[0], vectors[i + 1]);
        if(score >= TAG_SEARCH_SEMANTIC_FLOOR) {
          scored.push({tag: candidates[i], score: score});
        }
      }
      scored.sort(function(a, b) { return b.score - a.score; });
      return scored.slice(0, limit);
    })
    .catch(function() {
      // Embedding service down: fall back to the lexical ranking
      return tagAiSimilarLexical(text, candidates).slice(0, limit);
    });
  }
  return Promise.resolve(tagAiSimilarLexical(text, candidates).slice(0, limit));
}

function tagAiSimilarLexical(text, candidates) {
  var entries = candidates.map(function(t) { return [t.id, t]; });
  return tagAiLexicalRank(text, entries);
}

var tag_ai_similar_timer = null;

function tagAiSimilarRefresh() {
  window.clearTimeout(tag_ai_similar_timer);
  tag_ai_similar_timer = window.setTimeout(function() {
    if(!tag_ai_tag.modal_open) {
      return;
    }
    var seq = ++tag_ai_tag.similar_seq;
    tagAiSimilarTagsPromise(5).then(function(scored) {
      if(seq !== tag_ai_tag.similar_seq || !tag_ai_tag.modal_open) {
        return;
      }
      tag_ai_tag.similar = scored;
      tagAiSimilarRender();
    });
  }, 600);
}

function tagAiSimilarRender() {
  var box = document.getElementById('tag-add-similar');
  if(!box) {
    return;
  }
  if(!tag_ai_tag.similar.length) {
    box.style.display = 'none';
    box.textContent = '';
    return;
  }
  box.style.display = '';
  box.textContent = '';
  box.appendChild(taguEl('span', 'tag-ai-similar-label',
                         gettext('Similar tags:')));
  tag_ai_tag.similar.forEach(function(s, i) {
    if(i > 0) {
      box.appendChild(document.createTextNode(' '));
    }
    var chip = document.createElement('a');
    chip.href = 'javascript:void(0)';
    chip.className = 'badge badge-light tag-ai-similar-chip';
    chip.textContent = s.tag.path;
    chip.title = gettext('Click to organize the hierarchy with this tag');
    chip.addEventListener('click', function(e) {
      e.preventDefault();
      tagAiShowMenu(s.tag, e.clientX, e.clientY);
    });
    box.appendChild(chip);
  });
}

/*
 * Context menu on a similar tag: set as parent / descendant, or merge.
 * "Set as descendant" and "Merge" for a tag that doesn't exist yet are
 * stored and applied by tagAiAfterTagSaved() once it is saved.
 */

function tagAiHideMenu() {
  var menu = document.getElementById('tag-ai-menu');
  if(menu) {
    menu.style.display = 'none';
  }
}

function tagAiShowMenu(tag, x, y) {
  var menu = document.getElementById('tag-ai-menu');
  if(!menu) {
    menu = document.createElement('div');
    menu.id = 'tag-ai-menu';
    document.body.appendChild(menu);
  }
  menu.textContent = '';
  menu.classList.remove('tag-ai-preview-error');
  menu.appendChild(taguEl('div', 'tag-ai-menu-title', tag.path));
  var creating = tag_ai_tag.editing === null;

  function item(label, hint, fn) {
    var a = document.createElement('a');
    a.href = 'javascript:void(0)';
    a.className = 'btn btn-sm btn-outline-secondary btn-block text-left';
    a.textContent = label;
    if(hint) {
      a.title = hint;
    }
    a.addEventListener('click', function(e) {
      e.preventDefault();
      tagAiHideMenu();
      fn();
    });
    menu.appendChild(a);
  }

  item(gettext('Set as parent'), null, function() {
    tagAddParentSelect(tag);
  });
  item(gettext('Set as descendant'),
    creating ? gettext('Applied when you save the new tag') : null,
    function() {
      if(tag_ai_tag.editing !== null) {
        showSpinner();
        postJSON('/api/project/' + project_id + '/tag/' + tag.id,
                 {parent_id: tag_ai_tag.editing})
        .catch(function(error) {
          alert(gettext("Couldn't move the tag!") + '\n\n' + error);
        })
        .then(hideSpinner);
      } else {
        tag_ai_tag.pending.descendant = tag.id;
      }
    });
  item(gettext('Merge…'),
    creating ? gettext('Opens after you save the new tag') : null,
    function() {
      if(tag_ai_tag.editing !== null) {
        showMergeModal(tag_ai_tag.editing, tag.id);
      } else {
        tag_ai_tag.pending.merge = tag.id;
      }
    });

  menu.style.display = '';
  // Fixed-positioned, clamped to the viewport
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth
    - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight
    - menu.offsetHeight - 8)) + 'px';
}

document.addEventListener('click', function(e) {
  var menu = document.getElementById('tag-ai-menu');
  if(!menu || menu.style.display === 'none') {
    return;
  }
  var t = e.target;
  if(t.closest && (t.closest('#tag-ai-menu')
                   || t.closest('.tag-ai-similar-chip'))) {
    return;
  }
  tagAiHideMenu();
});
document.addEventListener('keydown', function(e) {
  if(e.key === 'Escape') {
    tagAiHideMenu();
  }
});

// Called by taguette.js right after a new tag is saved: apply the
// similar-tag actions that needed the tag to exist
function tagAiAfterTagSaved(tag_id) {
  var pending = tag_ai_tag.pending;
  tag_ai_tag.pending = {};
  if(pending.descendant != null) {
    postJSON('/api/project/' + project_id + '/tag/' + pending.descendant,
             {parent_id: tag_id})
    .catch(function(error) {
      alert(gettext("Couldn't move the tag!") + '\n\n' + error);
    });
  }
  if(pending.merge != null) {
    // Let the tag form finish closing before stacking the merge modal
    window.setTimeout(function() {
      showMergeModal(tag_id, pending.merge);
    }, 400);
  }
}

// Wiring is deferred to window load (jQuery loads at the end of the page)
window.addEventListener('load', function() {
  var modal = document.getElementById('tag-add-modal');
  if(modal) {
    $(modal)
    .on('show.bs.modal', tagAiTagModalOpen)
    .on('hidden.bs.modal', function() {
      tag_ai_tag.modal_open = false;
      ++tag_ai_tag.seq;
      ++tag_ai_tag.similar_seq;
      tagAiHideMenu();
    });
  }

  var generate = document.getElementById('tag-add-desc-generate');
  if(generate) {
    generate.addEventListener('click', function(e) {
      e.preventDefault();
      tagAiDescRun('generate');
    });
  }
  ['examples', 'includes', 'confound'].forEach(function(kind) {
    var item = document.getElementById('tag-add-augment-' + kind);
    if(item) {
      item.addEventListener('click', function(e) {
        e.preventDefault();
        tagAiDescRun('augment_' + kind);
      });
    }
  });
  var path = document.getElementById('tag-add-path');
  if(path) {
    path.addEventListener('input', tagAiSimilarRefresh);
  }
  var desc = document.getElementById('tag-add-description');
  if(desc) {
    desc.addEventListener('input', tagAiSimilarRefresh);
  }
});

/*
 * Configuration screen: the "AI tags" tab (model, temperature, prompts)
 */

function tagAiConfigExtra(box) {
  var group = taguEl('div', 'form-group');
  group.appendChild(taguEl('label', null, gettext('Temperature')));
  var temp = taguEl('input', 'form-control');
  temp.type = 'number';
  temp.min = '0';
  temp.max = '2';
  temp.step = '0.1';
  var task = taguConfig().tasks.llm || {};
  temp.value = typeof task.temperature === 'number'
    ? task.temperature : TAG_AI_TEMPERATURE;
  group.appendChild(temp);
  taguHint(group, gettext('0 = focused and repeatable, higher = more varied. All the chat APIs offered here accept this parameter.'));
  box.appendChild(group);
  temp.addEventListener('change', function() {
    var value = parseFloat(temp.value);
    if(isNaN(value)) {
      value = TAG_AI_TEMPERATURE;
    }
    value = Math.min(2, Math.max(0, value));
    var cfg = taguConfig();
    cfg.tasks.llm = cfg.tasks.llm
      || {source: '', url: '', token: '', model: ''};
    cfg.tasks.llm.temperature = value;
    taguConfigSave(cfg);
    temp.value = value;
  });

  box.appendChild(taguEl('h6', 'mt-3', gettext('Prompt templates')));
  taguHint(box, gettext('Placeholders: {{tag}} tag name, {{description}} current definition, {{highlights}} highlight excerpts, {{similar}} similar tags, {{tags}} existing tag names, {{highlight}} highlighted text. Leave a template empty to use the built-in default.'));
  Object.keys(TAG_AI_PROMPTS).forEach(function(key) {
    var g = taguEl('div', 'form-group');
    g.appendChild(taguEl('label', null, TAG_AI_PROMPT_LABELS[key]));
    var textarea = taguEl('textarea', 'form-control tag-ai-prompt');
    textarea.rows = 6;
    var t = taguConfig().tasks.llm || {};
    textarea.value = (t.prompts && t.prompts[key]) || TAG_AI_PROMPTS[key];
    g.appendChild(textarea);
    var reset = taguEl('button', 'btn btn-sm btn-outline-secondary mt-1',
                       gettext('Reset to default'));
    reset.type = 'button';
    g.appendChild(reset);
    box.appendChild(g);
    function save_prompt() {
      var cfg = taguConfig();
      cfg.tasks.llm = cfg.tasks.llm
        || {source: '', url: '', token: '', model: ''};
      cfg.tasks.llm.prompts = cfg.tasks.llm.prompts || {};
      if(!textarea.value.trim()
         || textarea.value.trim() === TAG_AI_PROMPTS[key].trim()) {
        delete cfg.tasks.llm.prompts[key];  // default: no override kept
      } else {
        cfg.tasks.llm.prompts[key] = textarea.value;
      }
      taguConfigSave(cfg);
    }
    textarea.addEventListener('change', save_prompt);
    reset.addEventListener('click', function() {
      textarea.value = TAG_AI_PROMPTS[key];
      save_prompt();
    });
  });
}

function tagAiConfigTabBuild(el) {
  el.appendChild(taguEl('p', 'text-muted', gettext(
    'Language model that suggests tag names and writes or augments tag descriptions. Any OpenAI-compatible chat API works: pick one of your API keys, a local service, or a custom endpoint.')));
  taguTaskPanel(el, {
    task: 'llm',
    locals: ['ollama_chat', 'llamacpp_chat'],
    defaultPath: '/chat/completions',
    modelPlaceholder: function(src) {
      if(src === 'local:ollama_chat') {
        return 'llama3.1';
      }
      var key = src.indexOf('key:') === 0 ? taguKeyById(src.slice(4)) : null;
      return ({
        openai: 'gpt-4o-mini',
        openrouter: 'openai/gpt-4o-mini',
        anthropic: 'claude-3-5-haiku-latest',
        gemini: 'gemini-2.0-flash',
        deepseek: 'deepseek-chat',
        minimax: 'MiniMax-Text-01',
        qwen: 'qwen-plus',
        zai: 'glm-4.5-air',
      })[key && key.provider] || null;
    },
    test: function(resolved) {
      return tagAiChat(resolved, 'Reply with the single word: ok', 20);
    },
    extra: tagAiConfigExtra,
  });
}

taguConfigRegisterTab({
  id: 'llm', title: gettext('AI tags'), order: 250,
  build: tagAiConfigTabBuild,
});

/*
 * Self-test: append ?tags_ai_selftest=1 to the project URL to run it.
 */

function tagAiSelfTest() {
  var failures = 0;
  function assert(cond, msg) {
    if(!cond) {
      console.error('SELFTEST FAIL:', msg);
      ++failures;
    }
  }

  // Truncation
  assert(tagAiTruncate('abc', 5) === 'abc', 'short text untouched');
  assert(tagAiTruncate('abcdefgh', 5).length === 5, 'long text truncated');

  // Lexical ranking: overlapping words outrank unrelated ones
  var fake_tags = {
    1: {id: 1, path: 'funding cuts', description: 'budget reductions'},
    2: {id: 2, path: 'volunteer work', description: 'unpaid helping'},
    3: {id: 3, path: 'funding', description: 'money for the charity'},
  };
  var entries = Object.entries(fake_tags);
  var ranked = tagAiLexicalRank('The charity lost its funding after budget cuts', entries);
  assert(ranked.length === 2, 'lexical ranking drops unrelated tags');
  assert(ranked[0].tag.id === 1, 'both keywords rank first');
  assert(ranked.every(function(r) { return r.score > 0; }), 'scores positive');
  assert(tagAiLexicalRank('', entries).length === 0, 'empty query ranks nothing');

  // LLM name parsing
  var names = tagAiParseNames('1. Housing insecurity\n- "food bank"\n* Volunteer retention and how it changed after the pandemic reorganization which was quite long');
  assert(names.length === 2, 'over-long line dropped');
  assert(names[0] === 'Housing insecurity', 'numbering stripped');
  assert(names[1] === 'food bank', 'quotes stripped');

  // Prompt substitution and overrides
  var cfg = {prompts: {names: 'Tag for {{highlight}} ({{unknown}})'}};
  assert(tagAiPrompt(cfg, 'names', {highlight: 'X'})
    === 'Tag for X ({{unknown}})', 'placeholders filled, unknowns kept');
  assert(tagAiPrompt({}, 'names', {highlight: 'X'}).indexOf('{{highlight}}') === -1,
    'default template used without override');

  // Excerpt sampling: caps the count, keeps the spread
  var many = [];
  for(var i = 0; i < 100; ++i) {
    many.push('excerpt ' + i);
  }
  var sampled = tagAiSampleExcerpts(many, 10, 300);
  assert(sampled.length === 10, 'sampling caps the count');
  assert(sampled[0] === 'excerpt 0' && sampled[9] === 'excerpt 90',
    'sampling spreads across the list');
  assert(tagAiSampleExcerpts(['a', 'b'], 10, 300).length === 2,
    'short lists kept whole');

  // Similar-tag candidates: self, ancestors and descendants excluded
  var saved_tags = window.tags;
  window.tags = {
    1: {id: 1, path: 'funding', parent_id: null},
    2: {id: 2, path: 'funding/cuts', parent_id: 1},
    3: {id: 3, path: 'volunteering', parent_id: null},
    4: {id: 4, path: 'other', parent_id: 3},
  };
  try {
    var cands = tagAiSimilarCandidates(Object.entries(window.tags), 2);
    assert(cands.length === 2 && cands[0].id === 3 && cands[1].id === 4,
      'self and ancestors excluded, unrelated subtrees kept');
  } finally {
    window.tags = saved_tags;
  }

  // Highlight-modal view: top 10 ranked, flat order, new tag kept
  var saved_state = JSON.parse(JSON.stringify({
    open: tag_ai_modal.open, ranked: tag_ai_modal.ranked,
    show_all: tag_ai_modal.show_all, matches: tag_ai_modal.matches,
  }));
  var saved_sel = window.tag_to_select_in_highlight;
  try {
    tag_ai_modal.open = true;
    tag_ai_modal.show_all = false;
    tag_ai_modal.matches = null;
    var big = [];
    for(var j = 1; j <= 30; ++j) {
      big.push({tag: {id: j, path: 'tag' + j}, score: j});
    }
    big.sort(function(a, b) { return b.score - a.score; }); // ranked lists arrive sorted
    tag_ai_modal.ranked = big;
    var view = tagAiModalView();
    assert(view.order.length === 10, 'only the top 10 shown');
    assert(view.order[0].id === 30 && view.order[9].id === 21,
      'ranked best-first');
    assert(view.visible[30] && !view.visible[5], 'visibility matches order');
    tag_ai_modal.show_all = true;
    assert(tagAiModalView() === null, 'show-all lifts the restriction');
    tag_ai_modal.show_all = false;
    var saved_tags2 = window.tags;
    window.tags = {};
    for(var k = 1; k <= 30; ++k) {
      window.tags['' + k] = {id: k, path: 'tag' + k};
    }
    window.tag_to_select_in_highlight = 7;
    view = tagAiModalView();
    assert(view.order[0].id === 7 && view.order.length === 10,
      'just-created tag kept in the top 10');
    window.tag_to_select_in_highlight = null;
    window.tags = saved_tags2;
  } finally {
    tag_ai_modal.open = saved_state.open;
    tag_ai_modal.ranked = saved_state.ranked;
    tag_ai_modal.show_all = saved_state.show_all;
    tag_ai_modal.matches = saved_state.matches;
    window.tag_to_select_in_highlight = saved_sel;
  }

  console.log(failures === 0
    ? 'SELFTEST OK'
    : 'SELFTEST: ' + failures + ' failure(s)');
  return failures;
}

if(typeof window !== 'undefined' && window.location
   && window.location.search.indexOf('tags_ai_selftest=1') !== -1) {
  window.addEventListener('load', tagAiSelfTest);
}
