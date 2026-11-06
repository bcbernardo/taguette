/*
 * Taguette configuration screen
 *
 * A dedicated, extensible settings screen (a modal with tabs) shared by all
 * features that need configuration. Everything is client-side, in the same
 * spirit as the suggested-highlights feature: keys and settings live in the
 * browser's localStorage and are never sent to the Taguette server.
 *
 * Tabs are registered by any script through taguConfigRegisterTab(); the
 * keys tab lives here, feature tabs (embeddings, segmentation, ...) are
 * registered by the feature that owns them (see suggest.js and tags-ai.js),
 * and future tabs (more AI tasks, non-AI settings) only need a registry entry.
 *
 * Storage (localStorage["taguette_config"]):
 *   {version: 1,
 *    keys: [{id, provider, name, token, baseUrl, headerFormat}],
 *    tasks: {embeddings: {source, url, token, model}, ...}}
 * where source is '' (off), 'key:<id>', 'local:<service id>' or 'custom'.
 * Legacy stores from before this screen existed (taguette_suggest_config,
 * taguette_suggest_qa) are migrated once, in taguConfigInit().
 */

var TAGU_CONFIG_STORE = 'taguette_config';

/*
 * Provider catalog: base URLs are the OpenAI-compatible ones (chat/embeddings
 * live under them), headers are how each provider wants the API key passed.
 */
var TAGU_PROVIDERS = {
  anthropic: {label: 'Anthropic', base: 'https://api.anthropic.com/v1',
              header: 'x-api-key'},
  deepseek: {label: 'DeepSeek', base: 'https://api.deepseek.com/v1',
             header: 'bearer'},
  gemini: {label: 'Gemini',
           base: 'https://generativelanguage.googleapis.com/v1beta/openai',
           header: 'x-goog-api-key'},
  minimax: {label: 'MiniMax', base: 'https://api.minimax.io/v1',
            header: 'bearer'},
  openai: {label: 'OpenAI', base: 'https://api.openai.com/v1',
           header: 'bearer'},
  openrouter: {label: 'OpenRouter', base: 'https://openrouter.ai/api/v1',
               header: 'bearer'},
  qwen: {label: 'Qwen', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
         header: 'bearer'},
  zai: {label: 'Z.ai', base: 'https://api.z.ai/api/paas/v4', header: 'bearer'},
  custom: {label: null, base: '', header: 'bearer'},
};

// Custom providers pick their own base URL and one of these header formats
var TAGU_HEADER_FORMATS = [
  {value: 'bearer', label: 'Authorization: Bearer …'},
  {value: 'x-api-key', label: 'x-api-key: …'},
  {value: 'x-goog-api-key', label: 'x-goog-api-key: …'},
];

/*
 * Local services: run on the user's machine, no key. `path` is the
 * task-appended endpoint (the OpenAI-compatible one where it applies),
 * `probe` is what taguCheckLocal() pings to see whether it is running.
 */
var TAGU_LOCALS = {
  ollama: {
    label: 'Ollama', url: 'http://localhost:11434', probe: '/',
    path: '/v1/embeddings', kind: 'embeddings',
    install: 'Install Ollama from <a href="https://ollama.com">ollama.com</a>, '
      + 'pull an embedding model (<code>ollama pull all-minilm</code>) and '
      + 'start it with browser access allowed: '
      + '<code>OLLAMA_ORIGINS=* ollama serve</code>',
  },
  llamacpp: {
    label: 'llama.cpp server', url: 'http://localhost:8080', probe: '/health',
    path: '/v1/embeddings', kind: 'embeddings',
    install: 'Build the llama.cpp server and run it with embeddings enabled: '
      + '<code>llama-server -m nomic-embed-text.gguf --embeddings</code>',
  },
  tei: {
    label: 'text-embeddings-inference', url: 'http://localhost:8080',
    probe: '/health', path: '/v1/embeddings', kind: 'embeddings',
    install: 'Run Hugging Face\'s serving container: <code>docker run -p 8080:80 '
      + 'ghcr.io/huggingface/text-embeddings-inference '
      + '--model-id BAAI/bge-small-en-v1.5</code>',
  },
};

/*
 * Store access. Parsed on every call (the JSON is tiny): no cache to
 * invalidate, and tests can swap the store via localStorage directly.
 */

function taguConfigLoad() {
  try {
    var cfg = JSON.parse(window.localStorage.getItem(TAGU_CONFIG_STORE));
    if(cfg && typeof cfg === 'object') {
      cfg.keys = cfg.keys || [];
      cfg.tasks = cfg.tasks || {};
      return cfg;
    }
  } catch(e) { /* private mode or corrupted store: fall through */ }
  return {version: 1, keys: [], tasks: {}};
}

function taguConfig() {
  return taguConfigLoad();
}

function taguConfigSave(cfg) {
  try {
    window.localStorage.setItem(TAGU_CONFIG_STORE, JSON.stringify(cfg));
  } catch(e) {
    /* private mode: settings just won't persist */
  }
}

function taguKeyById(id) {
  var keys = taguConfig().keys;
  for(var i = 0; i < keys.length; ++i) {
    if(keys[i].id === id) {
      return keys[i];
    }
  }
  return null;
}

function taguKeyBase(key) {
  if(key.provider === 'custom') {
    return (key.baseUrl || '').replace(/\/+$/, '');
  }
  var p = TAGU_PROVIDERS[key.provider];
  return p ? p.base : '';
}

// How a key is presented to its service: {header, scheme} where the value
// sent is scheme + token (scheme '' for plain single-header keys)
function taguKeyAuth(key) {
  var fmt = key.provider === 'custom'
    ? (key.headerFormat || 'bearer')
    : ((TAGU_PROVIDERS[key.provider] || {}).header || 'bearer');
  if(fmt === 'x-api-key') {
    return {header: 'x-api-key', scheme: ''};
  }
  if(fmt === 'x-goog-api-key') {
    return {header: 'x-goog-api-key', scheme: ''};
  }
  return {header: 'Authorization', scheme: 'Bearer '};
}

/*
 * Resolve a task (endpoint + model). `default_path` is appended to a key's
 * base URL when the task has no URL override: a string ('/embeddings'), a
 * function(key) returning a string (may be an absolute URL starting with
 * http, or '' when the URL must be filled in by hand). Returns null when
 * the task is off or unusable, else {key, local, url, token, model,
 * authHeader, authScheme}.
 */
function taguResolveTask(task, default_path) {
  if(!task || !task.source) {
    return null;
  }
  if(task.source.indexOf('key:') === 0) {
    var key = taguKeyById(task.source.slice(4));
    if(!key) {
      return null;
    }
    var d = typeof default_path === 'function' ? default_path(key) : default_path;
    if(!d && !task.url) {
      return null; // no known default endpoint for this provider: URL required
    }
    var url = task.url || (d.indexOf('http') === 0 ? d : taguKeyBase(key) + d);
    var auth = taguKeyAuth(key);
    return {key: key, url: url, token: key.token, model: task.model || '',
            authHeader: auth.header, authScheme: auth.scheme};
  }
  if(task.source.indexOf('local:') === 0) {
    var local = TAGU_LOCALS[task.source.slice(6)];
    if(!local) {
      return null;
    }
    return {local: local, url: task.url || (local.url + local.path),
            token: '', model: task.model || '', authHeader: null,
            authScheme: ''};
  }
  // 'custom': a direct endpoint (token optional)
  if(!task.url) {
    return null;
  }
  return {url: task.url, token: task.token || '', model: task.model || '',
          authHeader: 'Authorization', authScheme: 'Bearer '};
}

function taguTaskResolve(task_id, default_path) {
  return taguResolveTask(taguConfig().tasks[task_id], default_path);
}

// Apply a resolved task's credentials to a headers object
function taguApplyAuth(headers, resolved) {
  if(resolved && resolved.token) {
    headers[resolved.authHeader || 'Authorization'] =
      (resolved.authScheme != null ? resolved.authScheme : 'Bearer ')
      + resolved.token;
  }
  return headers;
}

/*
 * One-time migration from the pre-configuration-screen stores.
 * Pure function: legacy configs in, {keys, tasks} out.
 */
function taguMigrateLegacy(emb, qa) {
  var out = {keys: [], tasks: {}};
  var next_id = 1;
  function add_key(key) {
    key.id = 'k' + (next_id++);
    out.keys.push(key);
    return key;
  }
  if(emb && emb.url) {
    // {url, token, model} -> direct custom endpoint
    out.tasks.embeddings = {source: 'custom', url: emb.url,
                            token: emb.token || '', model: emb.model || ''};
  }
  if(qa && qa.provider === 'laya') {
    out.tasks.decisions = {source: 'local:laya',
                           url: (qa.layaUrl || 'http://localhost:8000')
                             + '/v1/systemone'};
  } else if(qa && qa.provider === 'jev' && (qa.jevKey || qa.jevUrl)) {
    var via_openrouter = (qa.jevUrl || '').indexOf('openrouter.ai') !== -1;
    var key = add_key({
      provider: via_openrouter ? 'openrouter' : 'custom',
      name: via_openrouter ? 'OpenRouter' : 'Jev',
      token: qa.jevKey || '',
      baseUrl: '',
      headerFormat: 'bearer',
    });
    out.tasks.decisions = {source: 'key:' + key.id, url: qa.jevUrl || '',
                           model: qa.jevModel || ''};
  }
  return out;
}

function taguConfigInit() {
  try {
    if(window.localStorage.getItem(TAGU_CONFIG_STORE) !== null) {
      return;
    }
    var emb = null, qa = null;
    try {
      emb = JSON.parse(window.localStorage.getItem('taguette_suggest_config'));
    } catch(e) { /* ignore */ }
    try {
      qa = JSON.parse(window.localStorage.getItem('taguette_suggest_qa'));
    } catch(e) { /* ignore */ }
    var migrated = taguMigrateLegacy(emb, qa);
    taguConfigSave({version: 1, keys: migrated.keys, tasks: migrated.tasks});
  } catch(e) {
    /* private mode: migration just doesn't persist */
  }
}
taguConfigInit();

/*
 * Local service checks
 */

// Any HTTP answer (even an error status) means the server is there; only a
// network/CORS refusal means "not detected". Short timeout so the UI stays
// snappy when nothing listens on the port.
function taguCheckLocal(local_id) {
  var local = TAGU_LOCALS[local_id];
  var url = local ? local.url + local.probe : null;
  if(!url || typeof fetch !== 'function') {
    return Promise.reject(new Error(typeof fetch !== 'function'
      ? 'fetch unavailable' : 'Unknown service'));
  }
  var t0 = Date.now();
  var fetch_promise;
  if(typeof AbortController !== 'undefined') {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 2500);
    fetch_promise = fetch(url, {method: 'GET', mode: 'cors',
                                signal: controller.signal})
      .then(function(resp) {
        clearTimeout(timer);
        return resp;
      }, function(err) {
        clearTimeout(timer);
        throw err;
      });
  } else {
    fetch_promise = fetch(url, {method: 'GET', mode: 'cors'});
  }
  return fetch_promise.then(function() {
    return {ok: true, ms: Date.now() - t0};
  });
}

/*
 * Tab registry + modal
 */

var TAGU_CONFIG_TABS = [];

// tab: {id, title, order, build(container)} — build renders the pane each
// time the tab is shown, so panes always reflect the saved store
function taguConfigRegisterTab(tab) {
  TAGU_CONFIG_TABS.push(tab);
  TAGU_CONFIG_TABS.sort(function(a, b) {
    return (a.order || 100) - (b.order || 100);
  });
}

function taguEl(tag, cls, text) {
  var el = document.createElement(tag);
  if(cls) {
    el.className = cls;
  }
  if(text != null) {
    el.textContent = text;
  }
  return el;
}

function taguHint(el, html) {
  var small = taguEl('small', 'form-text text-muted');
  small.innerHTML = html;
  el.appendChild(small);
  return small;
}

// Open the configuration screen, showing the given tab (default: first)
function taguOpenConfig(tab_id) {
  var modal = document.getElementById('tagu-config-modal');
  var nav = document.getElementById('tagu-config-nav');
  var body = document.getElementById('tagu-config-body');
  nav.textContent = '';
  body.textContent = '';
  var target = null;
  TAGU_CONFIG_TABS.forEach(function(tab) {
    var li = taguEl('li', 'nav-item');
    var a = taguEl('a', 'nav-link', tab.title);
    a.setAttribute('href', '#tagu-tab-' + tab.id);
    a.setAttribute('data-toggle', 'tab');
    a.setAttribute('role', 'tab');
    // jQuery event: bootstrap's tab('show') triggers through jQuery, which
    // does not reach native addEventListener
    $(a).on('show.bs.tab', function() {
      var pane = document.getElementById('tagu-tab-' + tab.id);
      pane.textContent = '';
      try {
        tab.build(pane);
      } catch(e) {
        pane.textContent = gettext('Error loading this tab:') + ' ' + e;
      }
    });
    li.appendChild(a);
    nav.appendChild(li);
    var pane = taguEl('div', 'tab-pane fade');
    pane.id = 'tagu-tab-' + tab.id;
    pane.setAttribute('role', 'tabpanel');
    body.appendChild(pane);
    if(!target || tab.id === tab_id) {
      target = a;
    }
  });
  $(target).tab('show');
  $(modal).modal('show').drags({handle: '.modal-header'});
}

/*
 * Keys tab
 */

function taguRenderKeysTab(root) {
  var intro = taguEl('p', 'text-muted',
    gettext('API keys for AI helper services. Keys are stored in your browser only and never sent to the Taguette server.'));
  root.appendChild(intro);

  var list = taguEl('div');
  root.appendChild(list);

  function save(cfg) {
    taguConfigSave(cfg);
  }

  function renderRow(key, cfg) {
    var card = taguEl('div', 'tagu-key');

    var row = taguEl('div', 'form-row');

    var col_provider = taguEl('div', 'col-md-3');
    var provider = taguEl('select', 'form-control form-control-sm');
    Object.keys(TAGU_PROVIDERS).forEach(function(pid) {
      var option = taguEl('option', null,
        pid === 'custom' ? gettext('Custom provider') : TAGU_PROVIDERS[pid].label);
      option.value = pid;
      provider.appendChild(option);
    });
    provider.value = key.provider;
    col_provider.appendChild(provider);
    row.appendChild(col_provider);

    var col_name = taguEl('div', 'col-md-3');
    var name = taguEl('input', 'form-control form-control-sm');
    name.type = 'text';
    name.placeholder = gettext('Label (optional)');
    name.value = key.name || '';
    col_name.appendChild(name);
    row.appendChild(col_name);

    var col_token = taguEl('div', 'col-md-4');
    var token = taguEl('input', 'form-control form-control-sm');
    token.type = 'password';
    token.placeholder = gettext('API key');
    token.value = key.token || '';
    col_token.appendChild(token);
    row.appendChild(col_token);

    var col_del = taguEl('div', 'col-md-2 text-right');
    var del = taguEl('button', 'btn btn-sm btn-outline-danger', '×');
    del.type = 'button';
    del.title = gettext('Remove this key');
    col_del.appendChild(del);
    row.appendChild(col_del);

    card.appendChild(row);

    var extra = taguEl('div');
    card.appendChild(extra);
    function renderExtra() {
      extra.textContent = '';
      if(key.provider !== 'custom') {
        return;
      }
      var row2 = taguEl('div', 'form-row');
      var col_url = taguEl('div', 'col-md-7');
      var base = taguEl('input', 'form-control form-control-sm');
      base.type = 'url';
      base.placeholder = gettext('Base URL (e.g. https://api.example.com/v1)');
      base.value = key.baseUrl || '';
      col_url.appendChild(base);
      row2.appendChild(col_url);
      var col_fmt = taguEl('div', 'col-md-5');
      var fmt = taguEl('select', 'form-control form-control-sm');
      TAGU_HEADER_FORMATS.forEach(function(f) {
        var option = taguEl('option', null, f.label);
        option.value = f.value;
        fmt.appendChild(option);
      });
      fmt.value = key.headerFormat || 'bearer';
      col_fmt.appendChild(fmt);
      row2.appendChild(col_fmt);
      extra.appendChild(row2);
      base.addEventListener('change', function() {
        key.baseUrl = base.value.trim();
        save(cfg);
      });
      fmt.addEventListener('change', function() {
        key.headerFormat = fmt.value;
        save(cfg);
      });
    }
    renderExtra();

    provider.addEventListener('change', function() {
      key.provider = provider.value;
      save(cfg);
      renderRow.refresh(key, cfg, card);
    });
    name.addEventListener('change', function() {
      key.name = name.value.trim();
      save(cfg);
    });
    token.addEventListener('change', function() {
      key.token = token.value;
      save(cfg);
    });
    del.addEventListener('click', function() {
      cfg.keys = cfg.keys.filter(function(k) { return k !== key; });
      save(cfg);
      render();
    });
    return card;
  }
  // Provider switch re-renders the row (custom fields show/hide); kept as a
  // property so the change handler above can reach it
  renderRow.refresh = function(key, cfg, old_card) {
    var card = renderRow(key, cfg);
    old_card.parentNode.replaceChild(card, old_card);
  };

  function render() {
    list.textContent = '';
    var cfg = taguConfig();
    cfg.keys.forEach(function(key) {
      list.appendChild(renderRow(key, cfg));
    });
    if(!cfg.keys.length) {
      list.appendChild(taguEl('p', 'text-muted',
        gettext('No keys yet. Add one for each service you use.')));
    }
    var add = taguEl('button', 'btn btn-outline-primary btn-sm',
      gettext('Add a key'));
    add.type = 'button';
    add.addEventListener('click', function() {
      var cfg = taguConfig();
      cfg.keys.push({id: 'k' + Date.now() + Math.floor(Math.random() * 1000),
                     provider: 'openrouter', name: '', token: '',
                     baseUrl: '', headerFormat: 'bearer'});
      taguConfigSave(cfg);
      render();
    });
    list.appendChild(add);
  }
  render();
}

taguConfigRegisterTab({
  id: 'keys', title: gettext('API keys'), order: 100,
  build: taguRenderKeysTab,
});

/*
 * Segmentation tab (speaker segmentation for the suggested-highlights
 * feature; the profile itself is proposed and reviewed in the document's
 * "Speakers" dialog, see suggest.js): the chat model that proposes speaker
 * label patterns from a few document excerpts. The old 'decisions' task
 * was removed; data in tasks.decisions stays in the store, inert.
 */
function taguSegmentationTabBuild(el) {
  var intro = taguEl('p', 'text-muted', gettext(
    'Chat model that proposes speaker label patterns for the suggested-highlights feature: it receives a few random excerpts of the document and answers once with the speakers it recognizes. Any OpenAI-compatible /chat/completions endpoint works — pick one of your API keys, a local server, or a custom endpoint. The proposed speakers are always reviewed in the document before anything is applied.'));
  el.appendChild(intro);
  taguHint(el, gettext(
    'Privacy: excerpts of the document are sent straight from your browser to the chosen service (never to the Taguette server).'));
  taguTaskPanel(el, {
    task: 'segmentation',
    locals: ['ollama_chat', 'llamacpp_chat'],
    defaultPath: '/chat/completions',
    modelPlaceholder: function(src) {
      if(src === 'local:ollama_chat') {
        return 'llama3.1';
      }
      if(src === 'local:llamacpp_chat') {
        return 'llama3.1-8b';
      }
      return null;
    },
    test: function(resolved) {
      return tagAiChat(resolved, 'Reply with the single word: ok', 20);
    },
  });
}

taguConfigRegisterTab({
  id: 'segmentation', title: gettext('Segmentation'), order: 310,
  build: taguSegmentationTabBuild,
});

/*
 * Task tab panel (embeddings, segmentation, future AI tasks): pick a source
 * (one of the keys, a local service, or a custom endpoint), then model and
 * optional endpoint override. Saves on every change; opts:
 *   task           task id in the store ('embeddings', ...)
 *   locals         local service ids usable for this task
 *   defaultSource  preselected source when nothing is configured yet
 *   defaultPath    see taguTaskResolve (string or function(key))
 *   modelPlaceholder(source) placeholder for the model field
 *   urlHint        hint under the URL field
 *   test(resolved) -> Promise, exercised by the "Test" button
 *   changed(resolved) called after a change is saved
 *   extra(el, readTask, saveTask) extra controls under the panel
 */
function taguTaskPanel(el, opts) {
  var cfg = taguConfig();
  var task = cfg.tasks[opts.task] || {source: '', url: '', token: '',
                                      model: ''};
  if(!task.source && opts.defaultSource) {
    task.source = opts.defaultSource; // shown as the preselection, saved on edit
  }

  var group = taguEl('div', 'form-group');
  group.appendChild(taguEl('label', null, gettext('Service')));
  var source = taguEl('select', 'form-control');
  var off = taguEl('option', null, '(' + gettext('off') + ')');
  off.value = '';
  source.appendChild(off);
  cfg.keys.forEach(function(key) {
    var label = (key.provider === 'custom'
      ? (key.name || gettext('Custom provider'))
      : TAGU_PROVIDERS[key.provider].label)
      + (key.name && key.provider !== 'custom' ? ' — ' + key.name : '');
    var option = taguEl('option', null, label);
    option.value = 'key:' + key.id;
    source.appendChild(option);
  });
  (opts.locals || []).forEach(function(local_id) {
    var option = taguEl('option', null,
      TAGU_LOCALS[local_id].label + ' (' + gettext('local') + ')');
    option.value = 'local:' + local_id;
    source.appendChild(option);
  });
  var custom_opt = taguEl('option', null, gettext('Custom endpoint'));
  custom_opt.value = 'custom';
  source.appendChild(custom_opt);
  source.value = task.source;
  group.appendChild(source);
  if(!cfg.keys.length) {
    taguHint(group, gettext('No API keys configured yet — add one in the "API keys" tab, or use a local service below.'));
  }
  el.appendChild(group);

  // URL override field
  var url_group = taguEl('div', 'form-group');
  url_group.appendChild(taguEl('label', null, gettext('Endpoint URL')));
  var url_input = taguEl('input', 'form-control');
  url_input.type = 'url';
  url_input.value = task.url || '';
  url_group.appendChild(url_input);
  var url_hint = taguHint(url_group, opts.urlHint
    || gettext('Leave empty to use the service\'s default address.'));
  el.appendChild(url_group);

  // Token for the 'custom' source only (keys carry their own)
  var token_group = taguEl('div', 'form-group');
  token_group.appendChild(taguEl('label', null, gettext('API key (optional)')));
  var token_input = taguEl('input', 'form-control');
  token_input.type = 'password';
  token_input.value = task.token || '';
  token_group.appendChild(token_input);
  taguHint(token_group, gettext('Stays in your browser; never sent to the Taguette server.'));
  el.appendChild(token_group);

  var model_group = taguEl('div', 'form-group');
  model_group.appendChild(taguEl('label', null, gettext('Model')));
  var model_input = taguEl('input', 'form-control');
  model_input.type = 'text';
  model_input.value = task.model || '';
  model_group.appendChild(model_input);
  el.appendChild(model_group);

  // Local service check + install instructions
  var local_box = taguEl('div', 'tagu-instructions');
  el.appendChild(local_box);

  // Test + result
  var test_row = taguEl('div', 'form-group');
  var test = taguEl('button', 'btn btn-outline-secondary',
    gettext('Test connection'));
  test.type = 'button';
  test_row.appendChild(test);
  var test_result = taguEl('span', 'ml-2');
  test_row.appendChild(test_result);
  el.appendChild(test_row);

  function currentSource() {
    return source.value;
  }

  function urlDefault(src) {
    var resolved_default = '';
    if(src.indexOf('key:') === 0) {
      var key = taguKeyById(src.slice(4));
      if(key) {
        var d = typeof opts.defaultPath === 'function'
          ? opts.defaultPath(key)
          : opts.defaultPath;
        resolved_default = d
          ? (d.indexOf('http') === 0 ? d : taguKeyBase(key) + d)
          : '';
      }
    } else if(src.indexOf('local:') === 0) {
      var local = TAGU_LOCALS[src.slice(6)];
      resolved_default = local ? local.url + local.path : '';
    }
    return resolved_default;
  }

  function resolvedFromForm() {
    // The form's task as it would be saved, resolved without touching the
    // store, so Test checks exactly what is on screen
    return taguResolveTask(readTask(), opts.defaultPath);
  }

  function readTask() {
    var task = {source: currentSource(), url: url_input.value.trim(),
                token: token_input.value, model: model_input.value.trim()};
    // Keep fields this panel doesn't manage (temperature, prompts, ...):
    // they belong to the task's feature tab, written straight to the store
    var prev = taguConfig().tasks[opts.task] || {};
    Object.keys(prev).forEach(function(k) {
      if(!(k in task)) {
        task[k] = prev[k];
      }
    });
    return task;
  }

  function saveTask() {
    var cfg = taguConfig();
    cfg.tasks[opts.task] = readTask();
    taguConfigSave(cfg);
    if(opts.changed) {
      opts.changed(resolvedFromForm());
    }
  }

  function syncFields() {
    var src = currentSource();
    var is_custom = src === 'custom';
    var is_local = src.indexOf('local:') === 0;
    var is_key = src.indexOf('key:') === 0;
    token_group.style.display = is_custom ? '' : 'none';
    var def = urlDefault(src);
    url_input.placeholder = def || 'https://…';
    url_hint.style.display = (def && !is_custom) ? '' : 'none';
    url_group.style.display = (src === '' ) ? 'none' : '';
    model_group.style.display = (src === '') ? 'none' : '';
    model_input.placeholder = opts.modelPlaceholder
      ? (opts.modelPlaceholder(src) || gettext('model id')) : gettext('model id');
    // Local services: check installation, show instructions when missing
    local_box.textContent = '';
    local_box.style.display = is_local ? '' : 'none';
    if(is_local) {
      var local = TAGU_LOCALS[src.slice(6)];
      var status = taguEl('p', 'mb-1');
      local_box.appendChild(status);
      var install = taguEl('div');
      install.style.display = 'none';
      local_box.appendChild(install);
      var check = taguEl('button', 'btn btn-sm btn-outline-secondary',
        gettext('Check installation'));
      check.type = 'button';
      local_box.appendChild(check);
      function run_check() {
        status.textContent = gettext('Checking...');
        install.style.display = 'none';
        taguCheckLocal(src.slice(6)).then(function(r) {
          status.textContent = gettext('Detected (%(ms)s ms)', {ms: r.ms});
          status.className = 'mb-1 text-success';
        }, function() {
          status.textContent = gettext('Not detected. Install and start it, then check again:');
          status.className = 'mb-1 text-danger';
          install.innerHTML = local.install;
          install.style.display = '';
        });
      }
      check.addEventListener('click', run_check);
      run_check();
    }
    test.disabled = src === '';
  }

  source.addEventListener('change', function() {
    // First interaction saves the preselection for real; URL/token overrides
    // belonged to the previous source, so they are dropped on switch
    url_input.value = '';
    token_input.value = '';
    saveTask();
    syncFields();
  });
  url_input.addEventListener('change', saveTask);
  token_input.addEventListener('change', saveTask);
  model_input.addEventListener('change', saveTask);
  test.addEventListener('click', function() {
    var resolved = resolvedFromForm();
    if(!resolved) {
      test_result.textContent = gettext('Pick a service (and fill the URL) first.');
      test_result.className = 'ml-2 text-danger';
      return;
    }
    test_result.textContent = gettext('Testing...');
    test_result.className = 'ml-2';
    var t0 = Date.now();
    opts.test(resolved)
      .then(function() {
        test_result.textContent = gettext('OK (%(ms)s ms)', {ms: Date.now() - t0});
        test_result.className = 'ml-2 text-success';
      })
      .catch(function(error) {
        test_result.textContent = gettext('Failed:') + ' ' + error;
        test_result.className = 'ml-2 text-danger';
      });
  });

  syncFields();

  if(opts.extra) {
    var extra_box = taguEl('div', 'mt-3');
    extra_box.style.borderTop = '1px solid #dee2e6';
    extra_box.style.paddingTop = '0.75rem';
    el.appendChild(extra_box);
    opts.extra(extra_box, readTask, saveTask);
  }
}

// Toolbar gear button (document view): general entry point to the screen
(function() {
  var btn = document.getElementById('tagu-config-btn');
  if(btn) {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      taguOpenConfig();
    });
  }
})();
