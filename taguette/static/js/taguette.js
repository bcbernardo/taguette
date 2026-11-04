/*
 * Table of contents
 *
 * - Utilities
 * - Selection stuff
 * - Project metadata
 * - Documents list
 * - Add document
 * - Tags list
 * - Tag search
 * - Tag view header
 * - Highlights
 * - Add highlight
 * - Highlight boundary editing
 * - Members
 * - Load contents
 * - Long polling


/*
 * Utilities
 */

if(!Object.entries) {
  Object.entries = function(obj) {
    var ownProps = Object.keys(obj),
      i = ownProps.length,
      resArray = new Array(i); // preallocate the Array
    while(i--) {
      resArray[i] = [ownProps[i], obj[ownProps[i]]];
    }

    return resArray;
  };
}

function sortByKey(array, key) {
  array.sort(function(a, b) {
    if(key(a) < key(b)) {
      return -1;
    } else if(key(a) > key(b)) {
      return 1;
    } else {
      return 0;
    }
  });
}

function encodeGetParams(params) {
  return Object.entries(params)
    .filter(function(kv) { return kv[1] !== undefined; })
    .map(function(kv) { return kv.map(encodeURIComponent).join("="); })
    .join("&");
}

// Don't use RegExp literals https://github.com/python-babel/babel/issues/640
var _escapeA = new RegExp('&', 'g'),
    _escapeL = new RegExp('<', 'g'),
    _escapeG = new RegExp('>', 'g'),
    _escapeQ = new RegExp('"', 'g'),
    _escapeP = new RegExp("'", 'g');
function escapeHtml(s) {
  return s
    .replace(_escapeA, "&amp;")
    .replace(_escapeL, "&lt;")
    .replace(_escapeG, "&gt;")
    .replace(_escapeQ, "&quot;")
    .replace(_escapeP, "&#039;");
}

function nextElement(node) {
  while(node && !node.nextSibling) {
    node = node.parentNode;
  }
  if(!node) {
    return null;
  }
  node = node.nextSibling;
  while(node.firstChild) {
    node = node.firstChild;
  }
  return node;
}

function getScrollPos() {
  var doc = document.scrollingElement || document.documentElement, body = document.body;
  var x = (doc && doc.scrollLeft || body && body.scrollLeft || 0) - (doc.clientLeft || 0);
  var y = (doc && doc.scrollTop || body && body.scrollTop || 0) - (doc.clientTop || 0);
  return {x: x, y: y};
}

function getPageXY(e) {
  // from jQuery
  // Calculate pageX/Y if missing
  if(e.pageX === null) {
    var scrollPos = getScrollPos();
    var x = e.clientX + scrollPos.x;
    var y = e.clientY + scrollPos.y;
    return {x: x, y: y};
  }
  return {x: e.pageX, y: e.pageY};
}

function getCookie(name) {
  var r = document.cookie.match("\\b" + name + "=([^;]*)\\b");
  return r ? r[1] : undefined;
}

function ApiError(response, message) {
  if(!message) {
    message = "Status " + response.status;
  }
  this.status = response.status;
  this.message = message;
}
ApiError.prototype.toString = function() {
  return this.message;
};

function getJSON(url='', args) {
  if(args) {
    args = '?' + encodeGetParams(args);
  } else {
    args = '';
  }
  return fetch(
    url + args,
    {
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error'
    }
  ).then(function(response) {
    if(response.status != 200) {
      return response.json()
      .then(
      function(json) {
        if("error" in json) {
          throw new ApiError(response, json.error);
        } else {
          throw new ApiError(response);
        }
      },
      function() {
        throw new ApiError(response);
      }
      );
    }
    return response.json().catch(function(error) { throw new ApiError(response, "Invalid JSON"); });
  });
}

function deleteURL(url='', args) {
  if(args) {
    args = '&' + encodeGetParams(args);
  } else {
    args = '';
  }
  return fetch(
    url + '?_xsrf=' + encodeURIComponent(getCookie('_xsrf')) + args,
    {
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-cache',
      redirect: 'error',
      method: 'DELETE'
    }
  ).then(function(response) {
    if(response.status != 204) {
      throw new ApiError(response);
    }
  });
}

function postJSON(url='', data={}, args) {
  if(args) {
    args = '&' + encodeGetParams(args);
  } else {
    args = '';
  }
  return fetch(
    url + '?_xsrf=' + encodeURIComponent(getCookie('_xsrf')) + args,
    {
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-cache',
      redirect: 'error',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(data)
    }
  ).then(function(response) {
    if(response.status != 200) {
      return response.json()
      .then(
      function(json) {
        if("error" in json) {
          throw new ApiError(response, json.error);
        } else {
          throw new ApiError(response);
        }
      },
      function() {
        throw new ApiError(response);
      }
      );
    }
    return response.json().catch(function(error) { throw new ApiError(response, "Invalid JSON"); });
  });
}

function patchJSON(url='', data={}, args) {
  if(args) {
    args = '&' + encodeGetParams(args);
  } else {
    args = '';
  }
  return fetch(
    url + '?_xsrf=' + encodeURIComponent(getCookie('_xsrf')) + args,
    {
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-cache',
      redirect: 'error',
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(data)
    }
  ).then(function(response) {
    if(response.status != 204) {
      return response.json()
      .then(
      function(json) {
        if("error" in json) {
          throw new ApiError(response, json.error);
        } else {
          throw new ApiError(response);
        }
      },
      function() {
        throw new ApiError(response);
      }
      );
    }
  });
}

// Returns the byte length of a string encoded in UTF-8
// https://stackoverflow.com/q/5515869/711380
if(window.TextEncoder) {
  function lengthUTF8(s) {
    return (new TextEncoder('utf-8').encode(s)).length;
  }
} else {
  function lengthUTF8(s) {
    var l = s.length;
    for(var i = s.length - 1; i >= 0; --i) {
      var code = s.charCodeAt(i);
      if(code > 0x7f && code <= 0x7ff) ++l;
      else if(code > 0x7ff && code <= 0xffff) l += 2;
      if (code >= 0xDC00 && code <= 0xDFFF) i--; // trailing surrogate
    }
    return l;
  }
}

window.addEventListener('load', function() {
  // https://css-tricks.com/snippets/jquery/draggable-without-jquery-ui/
  (function($) {
    $.fn.drags = function(opt) {
      opt = $.extend({handle:"",cursor:"move"}, opt);
      if(opt.handle === "") {
          var $el = this;
      } else {
          var $el = this.find(opt.handle);
      }

      return $el.css('cursor', opt.cursor).on("mousedown", function(e) {
        if(opt.handle === "") {
          var $drag = $(this).addClass('draggable');
        } else {
          var $drag = $(this).addClass('active-handle').parent().addClass('draggable');
        }
        var z_idx = $drag.css('z-index'),
            drg_h = $drag.outerHeight(),
            drg_w = $drag.outerWidth(),
            pos_y = $drag.offset().top + drg_h - e.pageY,
            pos_x = $drag.offset().left + drg_w - e.pageX;
        $drag.css('z-index', 1000).parents().on("mousemove", function(e) {
          $('.draggable').offset({
            top:e.pageY + pos_y - drg_h,
            left:e.pageX + pos_x - drg_w
          }).on("mouseup", function() {
            $(this).removeClass('draggable').css('z-index', z_idx);
          });
        });
        e.preventDefault(); // disable selection
      }).on("mouseup", function() {
        if(opt.handle === "") {
          $(this).removeClass('draggable');
        } else {
          $(this).removeClass('active-handle').parent().removeClass('draggable');
        }
      });
    }
  })(jQuery);
});

function showSpinner() {
  $('#spinner-modal').modal('show');
}

function hideSpinner() {
  $('#spinner-modal').modal('hide');
}


/*
 * Selection stuff
 */

var chunk_offsets = [];
// Offsets of the second pane in split-screen mode ('R' prefix), see suggest.js
var chunk_offsets_b = [];

// Get the document offset from a position
function describePos(node, offset) {
  // Convert current offset from character to bytes
  offset = lengthUTF8(node.textContent.substring(0, offset));
  while(!node.id) {
    if(node.previousSibling) {
      node = node.previousSibling;
      offset += lengthUTF8(node.textContent);
    } else {
      node = node.parentNode;
    }
  }
  if(node.id.substring(0, 11) != 'doc-offset-') {
    return null;
  }
  // Chunk ids may carry a pane prefix ('R' for the second split-screen pane)
  var chunk_id = node.id.substring(11), num_start = 0;
  while(num_start < chunk_id.length
        && (chunk_id[num_start] < '0' || chunk_id[num_start] > '9')) {
    ++num_start;
  }
  return parseInt(chunk_id.substring(num_start)) + offset;
}

// Find a position from the document offset
// prefix '' is the main pane, 'R' is the second pane in split-screen mode
function locatePos(pos, prefix) {
  // Find the right chunk
  var offsets = prefix ? chunk_offsets_b : chunk_offsets;
  var chunk_start = 0;
  for(var i = 0; i < offsets.length; ++i) {
    if(offsets[i] > pos) {
      break;
    }
    chunk_start = offsets[i];
  }

  var offset = pos - chunk_start;
  var node = document.getElementById('doc-offset-' + (prefix || '') + chunk_start);
  while(node.firstChild) {
    node = node.firstChild;
  }
  while(offset > 0) {
    if(lengthUTF8(node.textContent) >= offset) {
      break;
    } else {
      offset -= lengthUTF8(node.textContent);
      node = nextElement(node);
    }
  }
  return [node, offset]
}

var current_selection = null;

// Describe the selection e.g. [14, 56]
function describeSelection() {
  var sel = window.getSelection();
  if(sel.rangeCount != 0) {
    var range = sel.getRangeAt(0);
    if(!range.collapsed) {
      var start = describePos(range.startContainer, range.startOffset);
      var end = describePos(range.endContainer, range.endOffset);
      if(start !== null && end !== null) {
        return [start, end];
      }
    }
  }
  return null;
}

// Restore a described selection
function restoreSelection(saved) {
  var sel = window.getSelection();
  sel.removeAllRanges();
  if(saved !== null) {
    var range = document.createRange();
    var start = locatePos(saved[0]);
    var end = locatePos(saved[1]);
    range.setStart(start[0], start[1]);
    range.setEnd(end[0], end[1]);
    sel.addRange(range);
  }
}

function splitAtPos(pos, after) {
  var node = pos[0], idx = pos[1];
  if(idx === 0) {
    // Leftmost index: return current node
    return node;
  } else if(idx >= lengthUTF8(node.textContent)) {
    // Rightmost index: return next node
    return nextElement(node);
  } else {
    // Find the character index from the byte index
    var idx_char = 0;
    while(idx > 0) {
      var code = node.textContent.charCodeAt(idx_char);
      if(code <= 0x7f) idx -= 1;
      else if(code <= 0x7ff) idx -= 2;
      else if(code <= 0xffff) idx -= 3;
      else idx -= 4;
      idx_char += 1;
    }
    if(idx_char >= node.textContent.length) {
      console.error("Error computing character position!");
      idx_char = node.textContent.length - 1;
    }
    // Split, return right node
    return node.splitText(idx_char);
  }
}

// Highlight a described selection, in every pane currently shown
function highlightSelection(saved, id, clickedCallback, title) {
  console.log("Highlighting", saved);
  if(saved === null) {
    return;
  }
  var prefixes = document.getElementById('document-contents-b') ? ['', 'R'] : [''];
  for(var p = 0; p < prefixes.length; ++p) {
    var prefix = prefixes[p];
    var start = locatePos(saved[0], prefix);
    start = splitAtPos(start, false);
    var end = locatePos(saved[1], prefix);
    end = splitAtPos(end, true);

    var node = start;
    while(node != end) {
      var next = nextElement(node);
      if(node.nodeType == 3 && node.textContent) { // TEXT_NODE
        var span = document.createElement('a');
        span.className = 'highlight highlight-' + id;
        span.setAttribute('data-highlight-id', '' + id);
        span.setAttribute('title', title);
        span.addEventListener('click', clickedCallback);
        span.addEventListener('dblclick', highlightDblClicked);
        node.parentNode.insertBefore(span, node);
        span.appendChild(node);
      }
      node = next;
    }
  }
}


/*
 * Project metadata
 */

var project_name_input = document.getElementById('project-name');
var project_name = project_name_input.value;

var project_description_input = document.getElementById('project-description');
var project_description = project_description_input.value;

function setProjectMetadata(metadata, form=true) {
  if(project_name == metadata.project_name
   && project_description == metadata.description) {
    return;
  }
  // Update globals
  project_name = metadata.project_name;
  project_description = metadata.description;
  // Update form
  if(form) {
    project_name_input.value = project_name;
    project_description_input.value = project_description;
  }
  // Update elements
  var elems = document.getElementsByClassName('project-name');
  for(var i = 0; i < elems.length; ++i) {
    elems[i].textContent = project_name;
  }
  console.log("Project metadata updated");
}

function projectMetadataChanged() {
  if(project_name_input.value != project_name
   || project_description_input.value != project_description) {
    console.log("Posting project metadata update");
    var meta = {
      name: project_name_input.value,
      description: project_description_input.value
    };
    postJSON(
      '/api/project/' + project_id,
      meta
    )
    .then(function(result) {
      setProjectMetadata(meta, false);
    })
    .catch(function(error) {
      console.error("Failed to update project metadata:", error);
      alert(gettext("Couldn't update project metadata!") + "\n\n" + error);
      project_name_input.value = project_name;
      project_description_input.value = project_description;
    });
  }
}

document.getElementById('project-metadata-form').addEventListener('submit', function(e) {
  e.preventDefault();
  projectMetadataChanged();
});
project_name_input.addEventListener('blur', projectMetadataChanged);
project_description_input.addEventListener('blur', projectMetadataChanged);


/*
 * Documents list
 */

var current_document = null;
var current_tag = null;
var documents_list = document.getElementById('documents-list');

function linkDocument(elem, doc_id) {
  var url = '/project/' + project_id + '/document/' + doc_id;
  elem.setAttribute('href', url);
  elem.addEventListener('click', function(e) {
    e.preventDefault();
    window.history.pushState({document_id: doc_id}, "Document " + doc_id, url);
    loadDocument(doc_id);
  });
}

function updateDocumentsList() {
  // Empty the list
  while(documents_list.firstChild) {
    var first = documents_list.firstChild;
    if(first.classList
     && first.classList.contains('special-item-button')) {
      break;
    }
    documents_list.removeChild(first);
  }

  // Fill up the list again
  var before = documents_list.firstChild;
  var entries = Object.entries(documents);
  sortByKey(entries, function(e) { return e[1].name; });
  for(var i = 0; i < entries.length; ++i) {
    var doc = entries[i][1];
    var elem = document.createElement('li');
    elem.setAttribute('id', 'document-link-' + doc.id);
    elem.className = 'list-group-item document-link';
    elem.innerHTML =
      '<div class="d-flex justify-content-between align-items-center">' +
      '  <a class="document-link-a">' + escapeHtml(doc.name) + '</a>' +
      '  <a href="javascript:editDocument(' + doc.id + ');" class="btn btn-primary btn-sm">' + gettext("Edit") + '</a>' +
      '</div>';
    documents_list.insertBefore(elem, before);
    var links = elem.getElementsByTagName('a');
    linkDocument(links[0], doc.id);
  }
  if(entries.length == 0) {
    var elem = document.createElement('div');
    elem.className = 'list-group-item disabled';
    elem.textContent = gettext("There are no documents in this project yet.");
    documents_list.insertBefore(elem, before);
  }
  console.log("Documents list updated");
}

updateDocumentsList();

function addDocument(document) {
  documents['' + document.id] = document;
  updateDocumentsList();
}

function removeDocument(document_id) {
  delete documents['' + document_id];
  updateDocumentsList();
  if(current_document == document_id) {
    window.history.pushState({}, "Project", '/project/' + project_id);
    loadDocument(null);
  }
}


/*
 * Add document
 */

var document_add_modal = document.getElementById('document-add-modal');

function createDocument() {
  document.getElementById('document-add-form').reset();
  $(document_add_modal).modal();
}

function basename(filename) {
  if(filename) {
    var idx = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
    if(idx > -1) {
      filename = filename.substring(idx + 1);
    }
  }
  return filename;
}

document.getElementById('document-add-form').addEventListener('submit', function(e) {
  e.preventDefault();
  console.log("Uploading document...");

  var form_data = new FormData();
  var name = document.getElementById('document-add-name').value;
  if(!name) {
    name = basename(document.getElementById('document-add-file').value);
  }
  form_data.append('name', name);
  form_data.append('description',
                   document.getElementById('document-add-description').value);
  form_data.append('file',
                   document.getElementById('document-add-file').files[0]);
  form_data.append('_xsrf', getCookie('_xsrf'));

  var xhr = new XMLHttpRequest();
  xhr.responseType = 'json';
  xhr.open('POST', '/api/project/' + project_id + '/document/new');
  showSpinner();
  xhr.onload = function() {
    if(xhr.status == 200) {
      $(document_add_modal).modal('hide');
      document.getElementById('document-add-form').reset();
      console.log("Document upload complete");
    } else {
      console.error("Document upload failed: status", xhr.status);
      var error = null;
      try {
        error = xhr.response.error;
      } catch(e) {
      }
      if(!error) {
        error = "Status " + xhr.status;
      }
      alert(gettext("Error uploading file!") + "\n\n" + error);
    }
    hideSpinner();
  };
  xhr.onerror = function(e) {
    console.log("Document upload failed:", e);
    alert(gettext("Error uploading file!"));
    hideSpinner();
  }
  xhr.send(form_data);
});


/*
 * Change document
 */

var document_change_modal = document.getElementById('document-change-modal');

function editDocument(doc_id) {
  document.getElementById('document-change-form').reset();
  document.getElementById('document-change-id').value = '' + doc_id;
  document.getElementById('document-change-name').value = '' + documents['' + doc_id].name;
  document.getElementById('document-change-description').value = '' + documents['' + doc_id].description;
  $(document_change_modal).modal();
}

document.getElementById('document-change-form').addEventListener('submit', function(e) {
  e.preventDefault();
  console.log("Changing document...");

  var update = {
    name: document.getElementById('document-change-name').value,
    description: document.getElementById('document-change-description').value
  };
  if(!update.name || update.name.length == 0) {
    alert(gettext("Document name cannot be empty"));
    return;
  }

  var doc_id = document.getElementById('document-change-id').value;
  showSpinner();
  postJSON(
    '/api/project/' + project_id + '/document/' + doc_id,
    update
  )
  .then(function() {
    console.log("Document update posted");
    $(document_change_modal).modal('hide');
    document.getElementById('document-change-form').reset();
  })
  .catch(function(error) {
    console.error("Failed to update document:", error);
    alert(gettext("Couldn't update document!") + "\n\n" + error);
  })
  .then(hideSpinner);
});

document.getElementById('document-change-delete').addEventListener('click', function(e) {
  e.preventDefault();

  var doc_id = document.getElementById('document-change-id').value;
  if(!window.confirm(gettext("Are you sure you want to delete the document '%(doc)s'?", {doc: documents[doc_id].name}))) {
    return;
  }
  console.log("Deleting document " + doc_id + "...");
  deleteURL('/api/project/' + project_id + '/document/' + doc_id)
  .then(function() {
    console.log("Document deletion posted");
    $(document_change_modal).modal('hide');
    document.getElementById('document-change-form').reset();
  })
  .catch(function(error) {
    console.error("Failed to delete document:", error);
    alert(gettext("Couldn't delete document!") + "\n\n" + error);
  });
});


/*
 * Tags list
 */

var tags_list = document.getElementById('tags-list');
var tags_modal_list = document.getElementById('highlight-add-tags');

/*
 * Tag tree
 *
 * Tags can be nested through their `parent_id`. The helpers below build
 * the hierarchy from the flat `tags` map; projects have on the order of
 * a few hundred tags, so recomputing on every render stays cheap.
 */

function tagChildrenOf(tag_id) {
  var children = [];
  var entries = Object.entries(tags);
  for(var i = 0; i < entries.length; ++i) {
    var tag = entries[i][1];
    if(tag.parent_id != null && tag.parent_id == tag_id) {
      children.push(tag);
    }
  }
  sortByKey(children, function(t) { return t.path; });
  return children;
}

function tagRoots() {
  var roots = [];
  var entries = Object.entries(tags);
  for(var i = 0; i < entries.length; ++i) {
    var tag = entries[i][1];
    if(tag.parent_id == null || !tags['' + tag.parent_id]) {
      roots.push(tag);
    }
  }
  sortByKey(roots, function(t) { return t.path; });
  return roots;
}

function tagAncestorsOf(tag) {
  var ancestors = [];
  var current = tag;
  var guard = 0;
  while(current && current.parent_id != null && guard++ < 1000) {
    current = tags['' + current.parent_id];
    if(!current) {
      break;
    }
    ancestors.push(current);
  }
  return ancestors;
}

function tagIsDescendant(tag_id, maybe_ancestor_id) {
  var current = tags['' + tag_id];
  var guard = 0;
  while(current && current.parent_id != null && guard++ < 1000) {
    if('' + current.parent_id == '' + maybe_ancestor_id) {
      return true;
    }
    current = tags['' + current.parent_id];
  }
  return false;
}

/*
 * Tag selection in the "highlight" modal
 *
 * When a tag is created while the highlight form is open, it should get
 * selected right away; and the list re-render must not lose the current
 * selection.
 */
var tag_to_select_in_highlight = null;

function selectTagInHighlight(tag_id) {
  var checkbox = document.getElementById('highlight-add-tags-' + tag_id);
  if(checkbox) {
    checkbox.checked = true;
    tag_to_select_in_highlight = null;
  } else {
    // The checkbox doesn't exist yet (the tag list hasn't been refreshed):
    // check it next time the list is rendered
    tag_to_select_in_highlight = tag_id;
  }
}

function linkTag(elem, tag_path) {
  var url = '/project/' + project_id + '/highlights/' + encodeURIComponent(tag_path);
  elem.setAttribute('href', url);
  elem.addEventListener('click', function(e) {
    e.preventDefault();
    window.history.pushState({tag_path: tag_path}, "Tag " + tag_path, url);
    loadTag(tag_path);
  });
}

linkTag(document.getElementById('load-all-tags'), '');

/*
 * Tag search (top of the Highlights panel)
 *
 * Lexical: case-insensitive substring match over tag name + description,
 * applied immediately. If an embedding endpoint is configured (see the
 * "Embeddings" settings from suggest.js), a semantic search runs on top:
 * the query and every tag (name + description) are embedded and tags with
 * cosine similarity >= TAG_SEARCH_SEMANTIC_MIN are added to the results.
 * sugEmbed() keeps vectors in IndexedDB keyed by text, so each tag is
 * embedded once and cached; follow-up searches only embed the query.
 */

// Description boxes expanded (tag id -> true), kept across re-renders
var tag_desc_open = {};

var tag_search_input = document.getElementById('tag-search');
var tag_search_status = document.getElementById('tag-search-status');
var tag_search_state = {
  query: '',     // normalized: lowercased, trimmed
  matches: null, // null: no search active; else {tag_id: true}
  seq: 0,        // guards against out-of-order semantic results
};
var tag_search_timer = null;
// Semantic matches must clear an ADAPTIVE cutoff, not just a fixed number:
// embedding models give mildly positive cosine scores to almost any pair of
// short texts (a loose 0.30 floor matched 60 of 64 tags for "funding"), and
// the score scale differs between models. A tag is kept only if it beats
// BOTH the hard floor below AND the crowd (median + margin), so only clear
// standouts are surfaced, whatever the model's score distribution.
var TAG_SEARCH_SEMANTIC_FLOOR = 0.55;
var TAG_SEARCH_SEMANTIC_MARGIN = 0.15;

function tagSearchMedian(values) {
  if(!values.length) {
    return 0;
  }
  var sorted = values.slice().sort(function(a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function tagSearchText(tag) {
  return tag.path + '\n' + (tag.description || '');
}

function tagSearchCount() {
  var n = 0;
  var entries = Object.entries(tags);
  for(var i = 0; i < entries.length; ++i) {
    if(!tag_search_state.matches || tag_search_state.matches[entries[i][1].id]) {
      n++;
    }
  }
  return n;
}

function tagSearchStatusText(extra) {
  var text = gettext("%(n)s tags match", {n: tagSearchCount()});
  if(extra) {
    text += ' · ' + extra;
  }
  return text;
}

function tagSearchRun() {
  var q = tag_search_input.value.trim().toLowerCase();
  tag_search_state.query = q;
  var seq = ++tag_search_state.seq;

  if(!q) {
    tag_search_state.matches = null;
    tag_search_status.textContent = '';
    updateTagsList();
    return;
  }

  // Lexical search over tag name and description, applied immediately
  var matches = {};
  var entries = Object.entries(tags);
  for(var i = 0; i < entries.length; ++i) {
    var tag = entries[i][1];
    if(tagSearchText(tag).toLowerCase().indexOf(q) !== -1) {
      matches[tag.id] = true;
    }
  }
  tag_search_state.matches = matches;
  updateTagsList();

  // Semantic search, when an embedding endpoint is available
  var cfg = (typeof sugLoadConfig === 'function') ? sugLoadConfig() : null;
  if(cfg && cfg.url && entries.length > 0
     && typeof sugEmbed === 'function' && typeof sugCosine === 'function') {
    tag_search_status.textContent = gettext("Searching…");
    var texts = entries.map(function(e) { return tagSearchText(e[1]); });
    sugEmbed([q].concat(texts), cfg)
    .then(function(vecs) {
      if(seq !== tag_search_state.seq || tag_search_state.query !== q) {
        return; // a newer search has started
      }
      // Score every tag that the lexical search didn't already match
      var scored = [];
      for(var i = 0; i < entries.length; ++i) {
        var tag = entries[i][1];
        if(matches[tag.id]) {
          continue;
        }
        scored.push({tag: tag, score: sugCosine(vecs[0], vecs[i + 1])});
      }
      // Adaptive cutoff: at least the hard floor, and also a clear
      // standout above the median of the other candidates
      var cutoff = Math.max(
        TAG_SEARCH_SEMANTIC_FLOOR,
        tagSearchMedian(scored.map(function(s) { return s.score; }))
          + TAG_SEARCH_SEMANTIC_MARGIN);
      var semantic_added = 0;
      for(var j = 0; j < scored.length; ++j) {
        if(scored[j].score >= cutoff) {
          matches[scored[j].tag.id] = true;
          semantic_added++;
        }
      }
      tag_search_state.matches = matches;
      updateTagsList();
      tag_search_status.textContent = semantic_added > 0
        ? tagSearchStatusText(gettext("%(n)s by semantic similarity", {n: semantic_added}))
        : tagSearchStatusText(gettext("semantic"));
    })
    .catch(function(error) {
      if(seq !== tag_search_state.seq) {
        return;
      }
      console.log("Semantic tag search unavailable:", error);
      tag_search_status.textContent = tagSearchStatusText();
    });
  } else {
    tag_search_status.textContent = tagSearchStatusText();
  }
}

if(tag_search_input) {
  tag_search_input.addEventListener('input', function(e) {
    window.clearTimeout(tag_search_timer);
    tag_search_timer = window.setTimeout(tagSearchRun, 300);
  });
  // Enter runs the search immediately, without waiting for the debounce
  tag_search_input.addEventListener('keydown', function(e) {
    if(e.key === 'Enter') {
      e.preventDefault();
      tagSearchRunNow();
    }
  });
}

// Magnifying glass button: run the search immediately
var tag_search_run = document.getElementById('tag-search-run');
if(tag_search_run) {
  tag_search_run.addEventListener('click', function(e) {
    tagSearchRunNow();
  });
}

// Cross button: clear the search and show all tags again
var tag_search_clear = document.getElementById('tag-search-clear');
if(tag_search_clear) {
  tag_search_clear.addEventListener('click', function(e) {
    window.clearTimeout(tag_search_timer);
    tag_search_input.value = '';
    tag_search_state.query = '';
    ++tag_search_state.seq; // make any in-flight semantic result stale
    tag_search_state.matches = null;
    tag_search_status.textContent = '';
    updateTagsList();
    tag_search_input.focus();
  });
}

function tagSearchRunNow() {
  window.clearTimeout(tag_search_timer);
  tagSearchRun();
}

function tagSearchRefresh() {
  if(tag_search_state.query) {
    tagSearchRun();
  }
}

function addTag(tag) {
  if(!('count' in tag) && tag.id in tags) {
    tag.count = tags[tag.id].count;
  } else if(!('count' in tag)) {
    tag = Object.assign({'count': 0}, tag)
  }
  tags[tag.id] = tag;
  updateTagsList();
  tagSearchRefresh();
}

function removeTag(tag_id) {
  // Remove from list of tags
  delete tags['' + tag_id];
  // Remove from all highlights
  var hl_entries = Object.entries(highlights);
  for(var i = 0; i < hl_entries.length; ++i) {
    var hl = hl_entries[i][1];
    hl.tags = hl.tags.filter(function(v) { return v != tag_id; });
  }
  updateTagsList();
  tagSearchRefresh();
}

function mergeTags(tag_src, tag_dest) {
  for(var id in highlights) {
    var hl_tags = highlights[id].tags;

    if(hl_tags.includes(tag_src)) {
      // Remove src tag
      var idx = hl_tags.indexOf(tag_src);
      hl_tags.splice(idx, 1);

      if(!hl_tags.includes(tag_dest)) {
        // Add new tag
        hl_tags.push(tag_dest);
      }
    }
  }
  delete tags['' + tag_src];
  updateTagsList();
  tagSearchRefresh();
}

// Checked tags in the highlight form, kept outside the DOM so filtered
// re-renders (ranked suggestions, search) never lose the selection.
// Owned by updateTagsList(); seeded by createHighlight()/editHighlight().
var highlight_add_tag_state = {};

function updateTagsList() {
  var entries = Object.entries(tags);

  // The list in the left panel

  // Empty the list
  while(tags_list.firstChild) {
    var first = tags_list.firstChild;
    if(first.classList
     && first.classList.contains('special-item-button')) {
      break;
    }
    tags_list.removeChild(first);
  }
  // Fill up the list again, as a tree when tags are nested
  var before = tags_list.firstChild;

  // Under a search, show the matches plus their ancestors, so the tree
  // structure stays readable
  var visible = null;
  if(tag_search_state.matches) {
    visible = {};
    for(var i = 0; i < entries.length; ++i) {
      var tag = entries[i][1];
      if(tag_search_state.matches[tag.id]) {
        var ancestors = tagAncestorsOf(tag);
        visible[tag.id] = true;
        for(var j = 0; j < ancestors.length; ++j) {
          visible[ancestors[j].id] = true;
        }
      }
    }
  }

  var shown = 0;

  function renderTagItem(tag) {
    if(visible && !visible[tag.id]) {
      return null;
    }
    shown++;
    var children = tagChildrenOf(tag.id);
    var has_children = children.length > 0;
    // Default to open for tags with children so the hierarchy is visible,
    // collapsed otherwise (preserving the old description toggle);
    // the toggle collapses both the description and the child tags
    var open = tag_desc_open.hasOwnProperty(tag.id)
      ? tag_desc_open[tag.id]
      : has_children;
    var has_desc = !!tag.description;
    var elem = document.createElement('li');
    elem.className = 'list-group-item tag-item';
    elem.setAttribute('data-tag-id', '' + tag.id);
    if(current_tag !== null && tag.path.substr(0, current_tag.length) == current_tag) {
      elem.classList.add('tag-current');
    }
    elem.innerHTML =
      '<div class="d-flex justify-content-between align-items-start tag-drag-handle">' +
      '  <div class="tag-name">' +
      '    <a href="javascript:void(0)" class="tag-desc-toggle' + (has_desc || has_children ? '' : ' tag-desc-toggle-empty') + '" id="tag-desc-toggle-' + tag.id + '" title="' + gettext("Show or hide the tag definition and nested tags") + '">' + (open ? '&#9662;' : '&#9656;') + '</a>' +
      '    <a id="tag-link-' + tag.id + '">' + escapeHtml(tag.path) + '</a>' +
      '    <a href="javascript:void(0)" class="tag-pencil" id="tag-edit-' + tag.id + '" title="' + gettext("Edit tag name") + '">&#9998;</a>' +
      '  </div>' +
      '  <div style="white-space: nowrap;">' +
      '    <a class="badge badge-secondary badge-pill" id="tag-' + tag.id + '-count" title="' + gettext("See highlights") + '">' + tag.count + '</a>' +
      '  </div>' +
      '</div>' +
      '<div class="tag-desc-box" id="tag-desc-' + tag.id + '"' + (open ? '' : ' style="display: none;"') + '>' +
      '  <span class="' + (has_desc ? 'tag-desc-text' : 'tag-desc-text tag-desc-empty') + '">' + escapeHtml(has_desc ? tag.description : gettext("(no definition)")) + '</span>' +
      '  <a href="javascript:void(0)" class="tag-pencil" id="tag-desc-edit-' + tag.id + '" title="' + gettext("Edit tag description") + '">&#9998;</a>' +
      '</div>';
    tags_list.insertBefore(elem, before);
    linkTag(document.getElementById('tag-link-' + tag.id), tag.path);
    // Clicking the highlight count opens the tag view as well
    linkTag(document.getElementById('tag-' + tag.id + '-count'), tag.path);
    // Expand/collapse the definition box and the nested tags (state
    // survives re-renders)
    document.getElementById('tag-desc-toggle-' + tag.id).addEventListener('click', (function(tag_id, was_open) {
      return function(e) {
        e.preventDefault();
        var open_now = !was_open;
        tag_desc_open[tag_id] = open_now;
        was_open = open_now;
        var desc = document.getElementById('tag-desc-' + tag_id);
        if(desc) {
          desc.style.display = open_now ? '' : 'none';
        }
        var children_list = document.getElementById('tag-children-' + tag_id);
        if(children_list) {
          children_list.style.display = open_now ? '' : 'none';
        }
        this.innerHTML = open_now ? '&#9662;' : '&#9656;';
      };
    })(tag.id, open));
    // Pencils: quick edit of name / definition
    document.getElementById('tag-edit-' + tag.id).addEventListener('click', (function(tag_id) {
      return function(e) { e.preventDefault(); editTag(tag_id); };
    })(tag.id));
    document.getElementById('tag-desc-edit-' + tag.id).addEventListener('click', (function(tag_id) {
      return function(e) { e.preventDefault(); editTag(tag_id); };
    })(tag.id));
    // Drag & drop: drag a tag onto another to re-parent or merge it
    enableTagDrag(elem, tag.id);
    // Nested tags
    if(has_children) {
      var children_ul = document.createElement('ul');
      children_ul.className = 'tag-children';
      children_ul.setAttribute('id', 'tag-children-' + tag.id);
      if(!open) {
        children_ul.style.display = 'none';
      }
      for(var i = 0; i < children.length; ++i) {
        var child_li = renderTagItem(children[i]);
        if(child_li) {
          children_ul.appendChild(child_li);
        }
      }
      elem.appendChild(children_ul);
    }
    return elem;
  }

  var roots = tagRoots();
  for(var i = 0; i < roots.length; ++i) {
    renderTagItem(roots[i]);
  }
  if(entries.length == 0) {
    var elem = document.createElement('div');
    elem.className = 'list-group-item disabled';
    elem.textContent = gettext("There are no tags in this project yet.");
    tags_list.insertBefore(elem, before);
  } else if(tag_search_state.matches && shown == 0) {
    var elem = document.createElement('div');
    elem.className = 'list-group-item disabled';
    elem.textContent = gettext("No tags match your search.");
    tags_list.insertBefore(elem, before);
  }

  // The list in the highlight modal

  // Checked tags, kept OUTSIDE the DOM: the tags-ai feature can filter
  // the list (ranked suggestions, search), and a rebuild must not lose
  // the selection just because some checked tags are hidden. Ids whose
  // checkbox is currently rendered follow the DOM; hidden ids keep
  // their state. Seeded when the form is populated (createHighlight /
  // editHighlight).
  var modal_checkboxes = tags_modal_list.querySelectorAll('input[name="highlight-add-tags"]');
  for(var i = 0; i < modal_checkboxes.length; ++i) {
    var box_value = modal_checkboxes[i].value;
    if(modal_checkboxes[i].checked) {
      highlight_add_tag_state[box_value] = true;
    } else if(box_value in highlight_add_tag_state) {
      delete highlight_add_tag_state[box_value];
    }
  }
  var checked_tag_ids = Object.keys(highlight_add_tag_state);

  // Empty the list
  while(tags_modal_list.firstChild) {
    var first = tags_modal_list.firstChild;
    if(first.classList
     && first.classList.contains('special-item-button')) {
      break;
    }
    tags_modal_list.removeChild(first);
  }
  // Fill up the list again, as a tree when tags are nested
  var before = tags_modal_list.firstChild;

  // The tags-ai feature can restrict and reorder this list (ranked
  // suggestions while creating a highlight, search): {visible: {id: true}}
  // filters the tree, {order: [tag, ...]} renders a flat ranked list
  var modal_view = (typeof tagAiModalView === 'function')
    ? tagAiModalView() : null;
  var modal_visible = modal_view ? modal_view.visible : null;
  var modal_order = modal_view ? modal_view.order : null;
  var modal_shown = 0;

  function renderModalTagItem(tag) {
    if(modal_visible && !modal_visible[tag.id]) {
      return null;
    }
    modal_shown++;
    var li = document.createElement('li');
    li.className = 'tag-name form-check';
    li.innerHTML =
      '<input type="checkbox" class="form-check-input" value="' + tag.id + '" name="highlight-add-tags" id="highlight-add-tags-' + tag.id + '" />' +
      '<label for="highlight-add-tags-' + tag.id + '" class="form-check-label">' + escapeHtml(tag.path) + '</label>';
    // Restore the checked state. We set the property (not the attribute)
    // so that resetting the form still clears it.
    var checkbox = li.querySelector('input');
    checkbox.checked = checked_tag_ids.indexOf('' + tag.id) !== -1;
    var children = tagChildrenOf(tag.id);
    if(children.length > 0) {
      var children_ul = document.createElement('ul');
      children_ul.className = 'tag-children';
      for(var i = 0; i < children.length; ++i) {
        var child_li = renderModalTagItem(children[i]);
        if(child_li) {
          children_ul.appendChild(child_li);
        }
      }
      li.appendChild(children_ul);
    }
    return li;
  }

  if(modal_order) {
    // Ranked suggestions: a flat list, best first
    for(var i = 0; i < modal_order.length; ++i) {
      var li = renderModalTagItem(modal_order[i]);
      if(li) {
        tags_modal_list.insertBefore(li, before);
      }
    }
  } else {
    var roots = tagRoots();
    for(var i = 0; i < roots.length; ++i) {
      var li = renderModalTagItem(roots[i]);
      if(li) {
        tags_modal_list.insertBefore(li, before);
      }
    }
  }
  if(entries.length == 0) {
    var elem = document.createElement('li');
    elem.textContent = gettext("no tags");
    tags_modal_list.insertBefore(elem, before);
  } else if(modal_visible && modal_shown == 0) {
    var elem = document.createElement('li');
    elem.textContent = gettext("No tags match.");
    tags_modal_list.insertBefore(elem, before);
  }

  // Select a tag that was just created from the highlight form, now that
  // its checkbox exists
  if(tag_to_select_in_highlight) {
    selectTagInHighlight(tag_to_select_in_highlight);
  }

  console.log("Tags list updated");

  // Re-set all highlights, to update titles
  var hl_entries = Object.entries(highlights);
  for(var i = 0; i < hl_entries.length; ++i) {
    setHighlight(hl_entries[i][1]);
  }

  console.log("Highlights updated");
}

updateTagsList();

function updateTagCount(id, delta) {
  var tag = tags['' + id];
  tag.count += delta;
  var elem = document.getElementById('tag-' + id + '-count');
  elem.textContent = tag.count;
}

var tag_add_modal = document.getElementById('tag-add-modal');

function createTag() {
  document.getElementById('tag-add-form').reset();
  document.getElementById('tag-add-id').value = '';
  document.getElementById('tag-add-label-new').style.display = '';
  document.getElementById('tag-add-label-change').style.display = 'none';
  document.getElementById('tag-add-cancel').style.display = '';
  document.getElementById('tag-add-delete').style.display = 'none';
  document.getElementById('tag-add-merge').style.display = 'none';
  // New tags are root-level unless a parent is picked
  tagAddParentSelect(null);
  tagAddPathFit();
  $(tag_add_modal).modal();
}

function editTag(tag_id) {
  document.getElementById('tag-add-form').reset();
  document.getElementById('tag-add-id').value = '' + tag_id;
  document.getElementById('tag-add-path').value = tags['' + tag_id].path;
  document.getElementById('tag-add-description').value = tags['' + tag_id].description;
  document.getElementById('tag-add-label-new').style.display = 'none';
  document.getElementById('tag-add-label-change').style.display = '';
  document.getElementById('tag-add-cancel').style.display = 'none';
  document.getElementById('tag-add-delete').style.display = '';
  document.getElementById('tag-add-merge').style.display = '';
  // Show the tag's current parent in the search bar
  var parent = tags['' + tag_id].parent_id != null
    ? tags['' + tags['' + tag_id].parent_id]
    : null;
  tagAddParentSelect(parent);
  tagAddPathFit();
  $(tag_add_modal).modal();
}

// Make the tag name input wide enough to show its whole content: it is
// sized through the "size" attribute (grows with the text, capped by CSS)
var tag_add_path_input = document.getElementById('tag-add-path');
function tagAddPathFit() {
  tag_add_path_input.size = Math.max(30, tag_add_path_input.value.length + 2);
}
tag_add_path_input.addEventListener('input', tagAddPathFit);

// Save tag button
document.getElementById('tag-add-form').addEventListener('submit', function(e) {
  e.preventDefault();

  var tag_id = document.getElementById('tag-add-id').value;
  if(tag_id) {
    tag_id = parseInt(tag_id);
  } else {
    tag_id = null;
  }
  var tag_path = document.getElementById('tag-add-path').value;
  if(!tag_path) {
    alert(gettext("Invalid tag name"));
    return;
  }
  // Parent selection: empty means root level
  var parent_value = document.getElementById('tag-add-parent-id').value;
  var parent_id = parent_value ? parseInt(parent_value) : null;
  var old_parent_id = tag_id !== null ? tags['' + tag_id].parent_id : undefined;

  console.log("Posting new tag");
  var req = postJSON(
    tag_id !== null
      ? '/api/project/' + project_id + '/tag/' + tag_id
      : '/api/project/' + project_id + '/tag/new',
    {path: tag_path,
     description: document.getElementById('tag-add-description').value,
     parent_id: parent_id}
  );
  showSpinner();
  req.then(function(result) {
    console.log("Tag posted");
    if(tag_id === null && highlight_add_modal.classList.contains('show')) {
      // The tag was created from the highlight form: select it there, as it
      // is most likely meant to be applied to the current highlight
      selectTagInHighlight(result.id);
    }
    if(tag_id !== null && parent_id !== old_parent_id) {
      // The tag moved in the tree: allow undoing it with Ctrl+Z
      pushTagUndo({tag_id: tag_id, parent_id: old_parent_id});
    }
    if(tag_id === null && typeof tagAiAfterTagSaved === 'function') {
      // Similar-tag actions picked while the tag didn't exist yet
      tagAiAfterTagSaved(result.id);
    }
    $(tag_add_modal).modal('hide');
    document.getElementById('tag-add-form').reset();
    tagAddParentSelect(null);
  })
  .catch(function(error) {
    console.error("Failed to create tag:", error);
    alert(gettext("Couldn't create tag!") + "\n\n" + error);
  })
  .then(hideSpinner);
});

// Delete tag button
document.getElementById('tag-add-delete').addEventListener('click', function(e) {
  var tag_id = document.getElementById('tag-add-id').value;
  if(tag_id) {
    if(!window.confirm(gettext("Are you sure you want to delete the tag '%(tag)s'?", {tag: tags[tag_id].path}))) {
      e.preventDefault();
      return;
    }
    tag_id = parseInt(tag_id);
    console.log("Posting tag " + tag_id + " deletion");
    deleteURL(
      '/api/project/' + project_id + '/tag/' + tag_id
    )
    .then(function() {
      $(tag_add_modal).modal('hide');
      document.getElementById('tag-add-form').reset();
    })
    .catch(function(error) {
      console.error("Failed to delete tag:", error);
      alert(gettext("Couldn't delete tag!") + "\n\n" + error);
    });
  }
});

// Merge tags button in tag edit modal: shows merge modal
// (also used by drag & drop, with a preselected destination)
function showMergeModal(tag_id, preselect_dest) {
  document.getElementById('tag-merge-form').reset();

  // Set source tag
  document.getElementById('tag-merge-src-id').value = '' + tag_id;
  document.getElementById('tag-merge-src-name').value = tags['' + tag_id].path;

  // Empty target tag <select>
  var target = document.getElementById('tag-merge-dest');
  target.innerHTML = '';

  // Fill target tag <select>: can't merge into the source itself or one
  // of its descendants (that would create a cycle)
  var entries = Object.entries(tags);
  sortByKey(entries, function(e) { return e[1].path; });
  for(var i = 0; i < entries.length; ++i) {
    if(entries[i][0] == '' + tag_id
       || tagIsDescendant(entries[i][1].id, tag_id)) {
      continue;
    }
    var option = document.createElement('option');
    option.setAttribute('value', entries[i][0]);
    option.innerText = entries[i][1].path;
    target.appendChild(option);
  }

  if(preselect_dest !== undefined && preselect_dest !== null) {
    target.value = '' + preselect_dest;
  }

  $(document.getElementById('tag-merge-modal')).modal();
}

document.getElementById('tag-add-merge').addEventListener('click', function(e) {
  var tag_id = document.getElementById('tag-add-id').value;
  if(!tag_id)
    return;
  showMergeModal(parseInt(tag_id));
});

// Merge modal submit button
document.getElementById('tag-merge-form').addEventListener('submit', function(e) {
  e.preventDefault();

  var tag_src = document.getElementById('tag-merge-src-id').value;
  if(!tag_src)
    return;
  tag_src = parseInt(tag_src);

  var tag_dest = document.getElementById('tag-merge-dest').value;
  if(!tag_dest)
    return;
  tag_dest = parseInt(tag_dest);

  console.log(
    "Merging tag " + tag_src + " (" + tags['' + tag_src].path +
    ") into tag " + tag_dest + " (" + tags['' + tag_dest].path + ")");
  showSpinner();
  postJSON(
    '/api/project/' + project_id + '/tag/merge',
    {src: tag_src, dest: tag_dest}
  )
  .then(function() {
    console.log("Tag merge posted");
    $(document.getElementById('tag-merge-modal')).modal('hide');
  })
  .catch(function(error) {
    console.error("Failed to merge tags:", error);
    alert(gettext("Couldn't merge tags!") + "\n\n" + error);
  })
  .then(hideSpinner);
});


/*
 * Tag tree: drag & drop, undo
 */

// Tag being dragged (id), reset on dragend/drop
var tag_drag_id = null;

/*
 * Auto-scroll of the Highlights panel during a drag
 *
 * Browsers scroll the page itself during an HTML5 drag, but not inner
 * scrollable containers such as the tags panel. While a tag is being
 * dragged, the pointer position is tracked (dragover events fire all the
 * way up to the document) and a timer scrolls the panel whenever the
 * pointer is held near its top or bottom edge. The timer keeps running
 * while the pointer is stationary, so the panel keeps scrolling until the
 * pointer moves away from the edge.
 */

var tag_scroll_container = document.querySelector('.left-panel-scroll');
var tag_drag_last_y = null;
var tag_autoscroll_timer = null;
var TAG_AUTOSCROLL_EDGE = 48;  // Pointer this close to an edge starts scrolling
var TAG_AUTOSCROLL_MAX = 22;   // Maximum pixels scrolled per tick

function tagAutoScrollTick() {
  if(tag_drag_id === null || tag_drag_last_y === null
     || !tag_scroll_container) {
    return;
  }
  var rect = tag_scroll_container.getBoundingClientRect();
  // Only the part of the panel that is on screen can be used as a scroll
  // zone: the panel can extend below the window (its top is under the
  // page header), so clip it to the viewport
  var top = Math.max(rect.top, 0);
  var bottom = Math.min(rect.bottom, window.innerHeight);
  var y = tag_drag_last_y;
  // Don't scroll when the pointer is far away from the panel
  if(y < top - TAG_AUTOSCROLL_EDGE || y > bottom + TAG_AUTOSCROLL_EDGE) {
    return;
  }
  var delta = 0;
  if(y < top + TAG_AUTOSCROLL_EDGE) {
    // Closer to the top edge: scroll up, faster when closer
    delta = -Math.ceil(
      (top + TAG_AUTOSCROLL_EDGE - y)
      / TAG_AUTOSCROLL_EDGE * TAG_AUTOSCROLL_MAX);
  } else if(y > bottom - TAG_AUTOSCROLL_EDGE) {
    // Closer to the bottom edge: scroll down, faster when closer
    delta = Math.ceil(
      (y - (bottom - TAG_AUTOSCROLL_EDGE))
      / TAG_AUTOSCROLL_EDGE * TAG_AUTOSCROLL_MAX);
  }
  if(delta) {
    tag_scroll_container.scrollTop += delta;
  }
}

function tagAutoScrollStart() {
  if(tag_autoscroll_timer === null) {
    tag_autoscroll_timer = window.setInterval(tagAutoScrollTick, 25);
  }
}

function tagAutoScrollStop() {
  if(tag_autoscroll_timer !== null) {
    window.clearInterval(tag_autoscroll_timer);
    tag_autoscroll_timer = null;
  }
  tag_drag_last_y = null;
}

// Track the pointer during the drag, wherever it goes: dragover fires on
// the element under the cursor and bubbles all the way up to the document
// (this includes hovering over the search bar, the panel's margins, etc.)
document.addEventListener('dragover', function(e) {
  if(tag_drag_id !== null) {
    tag_drag_last_y = e.clientY;
  }
}, true);

// Safety net in case the source element is removed from the DOM mid-drag
// (e.g. the tags list is re-rendered): dragend always fires, but perhaps
// not on the element it started from
document.addEventListener('dragend', function() {
  tagAutoScrollStop();
});

function tagDropZone(e, elem) {
  // Which third of the row the cursor is over: the top and bottom thirds
  // re-parent the dragged tag, the middle third merges it into this tag
  var rect = elem.getBoundingClientRect();
  var y = e.clientY - rect.top;
  if(y < rect.height / 3) {
    return 'child-top';
  } else if(y > 2 * rect.height / 3) {
    return 'child-bottom';
  } else {
    return 'merge';
  }
}

function tagDropSetIndicator(elem, zone) {
  elem.classList.remove('drop-child', 'drop-merge');
  if(zone == 'merge') {
    elem.classList.add('drop-merge');
  } else {
    elem.classList.add('drop-child');
  }
}

function tagDropClearIndicator(elem) {
  elem.classList.remove('drop-child', 'drop-merge');
}

function enableTagDrag(elem, tag_id) {
  elem.setAttribute('draggable', 'true');

  // Drag events bubble up through the nested tag items: only the
  // innermost tag item under the cursor must handle them
  function isInnermost(e) {
    if(!e.target || !e.target.closest) {
      return true;
    }
    return e.target.closest('li.tag-item') === elem;
  }

  elem.addEventListener('dragstart', function(e) {
    if(!isInnermost(e)) {
      return;
    }
    tag_drag_id = tag_id;
    tag_drag_last_y = e.clientY;
    tagAutoScrollStart();
    e.dataTransfer.setData('text/plain', '' + tag_id);
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setDragImage(elem, 10, 10);
    } catch(err) {
    }
    window.setTimeout(function() {
      elem.classList.add('tag-dragging');
    }, 0);
  });
  elem.addEventListener('dragend', function(e) {
    tag_drag_id = null;
    tagAutoScrollStop();
    elem.classList.remove('tag-dragging');
  });

  elem.addEventListener('dragover', function(e) {
    if(!isInnermost(e)) {
      return;
    }
    if(tag_drag_id === null) {
      return; // Some other drag (text, images, ...)
    }
    // Can't drop a tag onto itself or one of its descendants
    if(tag_id == tag_drag_id || tagIsDescendant(tag_id, tag_drag_id)) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tagDropSetIndicator(elem, tagDropZone(e, elem));
  });
  elem.addEventListener('dragleave', function(e) {
    tagDropClearIndicator(elem);
  });
  elem.addEventListener('drop', function(e) {
    if(!isInnermost(e)) {
      return;
    }
    e.preventDefault();
    tagDropClearIndicator(elem);
    tagAutoScrollStop();
    var dragged = tag_drag_id;
    tag_drag_id = null;
    if(dragged === null) {
      return;
    }
    if(tag_id == dragged || tagIsDescendant(tag_id, dragged)) {
      return;
    }
    var zone = tagDropZone(e, elem);
    if(zone == 'merge') {
      // Dropping in the middle merges; closing the popup cancels
      showMergeModal(dragged, tag_id);
    } else {
      // Dropping inside or below re-parents, after a confirmation
      confirmTagMove(dragged, tag_id);
    }
  });
}

/*
 * Moving a tag to a new parent (with confirmation)
 */

var tag_move_modal = document.getElementById('tag-move-modal');
var tag_move_pending = null;

function confirmTagMove(tag_id, parent_id) {
  var tag = tags['' + tag_id];
  var parent = tags['' + parent_id];
  if(!tag || !parent) {
    return;
  }
  if(tag.parent_id != null && tag.parent_id == parent_id) {
    return; // Already a child of that tag
  }
  document.getElementById('tag-move-message').textContent = gettext(
    "Make '%(tag)s' a child of '%(parent)s'?",
    {tag: tag.path, parent: parent.path});
  tag_move_pending = {
    tag_id: tag_id,
    old_parent_id: tag.parent_id,
    new_parent_id: parent_id,
  };
  $(tag_move_modal).modal('show');
}

document.getElementById('tag-move-confirm').addEventListener('click', function(e) {
  e.preventDefault();
  var pending = tag_move_pending;
  tag_move_pending = null;
  $(tag_move_modal).modal('hide');
  if(!pending) {
    return;
  }
  moveTagRequest(pending.tag_id, pending.new_parent_id, pending.old_parent_id);
});

function moveTagRequest(tag_id, parent_id, undo_parent_id) {
  showSpinner();
  postJSON(
    '/api/project/' + project_id + '/tag/' + tag_id,
    {parent_id: parent_id}
  )
  .then(function() {
    if(undo_parent_id !== undefined) {
      pushTagUndo({tag_id: tag_id, parent_id: undo_parent_id});
    }
  })
  .catch(function(error) {
    console.error("Failed to move tag:", error);
    alert(gettext("Couldn't move the tag!") + "\n\n" + error);
  })
  .then(hideSpinner);
}

// Apply a tag move received from the server (our own request or another
// user's) to the local state
function moveTagLocal(tag_id, parent_id) {
  var tag = tags['' + tag_id];
  if(!tag) {
    return;
  }
  tag.parent_id = parent_id;
  updateTagsList();
  tagSearchRefresh();
}

/*
 * Undo (Ctrl+Z) of tag moves
 *
 * Moves made by dragging tags around (or by changing the parent in the
 * tag form) can be undone by moving the tag back to its previous parent.
 * Merges and deletions are destructive and cannot be undone this way.
 */

var tag_undo_stack = [];

function pushTagUndo(entry) {
  tag_undo_stack.push(entry);
  if(tag_undo_stack.length > 50) {
    tag_undo_stack.shift();
  }
  console.log("Tag undo entry added", entry);
}

document.addEventListener('keydown', function(e) {
  if(!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) {
    return;
  }
  if(e.key.toLowerCase() != 'z') {
    return;
  }
  // Let text fields undo their own edits
  var t = e.target;
  if(t && (t.tagName == 'INPUT' || t.tagName == 'TEXTAREA'
           || t.tagName == 'SELECT' || t.isContentEditable)) {
    return;
  }
  if(tag_undo_stack.length == 0) {
    return;
  }
  e.preventDefault();
  var entry = tag_undo_stack.pop();
  console.log("Undoing tag move", entry);
  moveTagRequest(entry.tag_id, entry.parent_id);
});

/*
 * Parent tag selection in the tag form
 */

var tag_add_parent_input = document.getElementById('tag-add-parent');
var tag_add_parent_id_input = document.getElementById('tag-add-parent-id');
var tag_add_parent_list = document.getElementById('tag-add-parent-list');

function tagAddParentSelect(tag) {
  if(tag) {
    tag_add_parent_id_input.value = '' + tag.id;
    tag_add_parent_input.value = tag.path;
  } else {
    tag_add_parent_id_input.value = '';
    tag_add_parent_input.value = '';
  }
  tag_add_parent_list.style.display = 'none';
}

function tagAddParentShowList() {
  // Candidates: all tags except the edited tag and its descendants (a
  // tag can't become a child of its own subtree)
  var editing_id = document.getElementById('tag-add-id').value;
  var query = tag_add_parent_input.value.trim().toLowerCase();
  var entries = Object.entries(tags);
  sortByKey(entries, function(e) { return e[1].path; });

  var candidates = [];
  for(var i = 0; i < entries.length && candidates.length < 10; ++i) {
    var tag = entries[i][1];
    if(editing_id && ('' + tag.id) == editing_id) {
      continue;
    }
    if(editing_id && tagIsDescendant(tag.id, parseInt(editing_id))) {
      continue;
    }
    if(query && tag.path.toLowerCase().indexOf(query) === -1) {
      continue;
    }
    candidates.push(tag);
  }

  while(tag_add_parent_list.firstChild) {
    tag_add_parent_list.removeChild(tag_add_parent_list.firstChild);
  }
  if(candidates.length == 0) {
    var item = document.createElement('a');
    item.className = 'list-group-item disabled';
    item.textContent = gettext("No matching tag");
    tag_add_parent_list.appendChild(item);
  } else {
    for(var i = 0; i < candidates.length; ++i) {
      (function(tag) {
        var item = document.createElement('a');
        item.className = 'list-group-item list-group-item-action';
        item.textContent = tag.path;
        item.title = gettext("Select as parent");
        // mousedown rather than click, so the input doesn't lose focus
        // (and hide the list) before the click registers
        item.addEventListener('mousedown', function(e) {
          e.preventDefault();
          tagAddParentSelect(tag);
        });
        tag_add_parent_list.appendChild(item);
      })(candidates[i]);
    }
  }
  tag_add_parent_list.style.display = '';
}

tag_add_parent_input.addEventListener('input', function(e) {
  // Typing invalidates the selection made so far
  tag_add_parent_id_input.value = '';
  tagAddParentShowList();
});
tag_add_parent_input.addEventListener('focus', function(e) {
  tag_add_parent_input.select();
  tagAddParentShowList();
});
tag_add_parent_input.addEventListener('keydown', function(e) {
  if(e.key === 'Enter') {
    // Pick the first candidate
    e.preventDefault();
    var first = tag_add_parent_list.querySelector('.list-group-item-action');
    if(first) {
      first.dispatchEvent(new Event('mousedown'));
    } else {
      tagAddParentSelect(null);
    }
  } else if(e.key === 'Escape') {
    tag_add_parent_list.style.display = 'none';
  }
});
tag_add_parent_input.addEventListener('blur', function(e) {
  // Clicking elsewhere: keep the list hidden and reflect the actual
  // selection (or root level) in the input
  window.setTimeout(function() {
    tag_add_parent_list.style.display = 'none';
    if(!tag_add_parent_id_input.value) {
      tag_add_parent_input.value = '';
    }
  }, 150);
});
document.getElementById('tag-add-parent-clear').addEventListener('click', function(e) {
  tagAddParentSelect(null);
  tag_add_parent_input.focus();
});

/*
 * Highlight form: checking a child tag checks its parents (they inherit
 * the highlight), unchecking a parent unchecks its children (a parent
 * can't be removed while a child keeps the highlight)
 */

tags_modal_list.addEventListener('change', function(e) {
  var input = e.target;
  if(!input || input.name !== 'highlight-add-tags') {
    return;
  }
  var tag_id = parseInt(input.value);
  if(input.checked) {
    var ancestors = tagAncestorsOf(tags['' + tag_id]);
    for(var i = 0; i < ancestors.length; ++i) {
      var cb = document.getElementById('highlight-add-tags-' + ancestors[i].id);
      if(cb && !cb.checked) {
        cb.checked = true;
      }
    }
  } else {
    (function uncheckChildren(tid) {
      var children = tagChildrenOf(tid);
      for(var i = 0; i < children.length; ++i) {
        var cb = document.getElementById('highlight-add-tags-' + children[i].id);
        if(cb && cb.checked) {
          cb.checked = false;
        }
        uncheckChildren(children[i].id);
      }
    })(tag_id);
  }
});


/*
 * Highlights
 */

// Add or replace a highlight
function setHighlight(highlight) {
  var id = '' + highlight.id;
  var previous = highlights[id] || null;
  if(previous) {
    removeHighlight(id);
  }
  highlights[id] = highlight;
  // If this highlight is being edited (brackets shown) and its extent
  // changed on the server (e.g. a collaborator resized it), drop the
  // editing UI
  if(hl_select && hl_select.id == id && previous
     && (previous.start_offset != highlight.start_offset
         || previous.end_offset != highlight.end_offset)) {
    hlSelectClear();
  }
  try {
    highlightSelection([highlight.start_offset, highlight.end_offset], id, highlightClicked, hlTitleFor(id));
    console.log("Highlight set:", highlight);
  } catch(error) {
    console.error(
      "Error setting highlight ", highlight.id, " ", [highlight.start_offset, highlight.end_offset],
      ":", error,
    );
  }
}

// Remove a highlight
function removeHighlight(id) {
  id = '' + id;
  if(!highlights[id]) {
    return;
  }

  var highlight = highlights[id];
  delete highlights[id];
  console.log("Highlight removed:", id);

  // Loop over highlight-<id> elements
  var elements = document.getElementsByClassName('highlight-' + id);
  for(var i = 0; i < elements.length; ++i) {
    // Move children up and delete this element
    var node = elements[i];
    while(node.firstChild) {
      node.parentNode.insertBefore(node.firstChild, node);
    }
    node.parentNode.removeChild(node);
  }
}

// "Go to last highlight": scroll so that the most recently
// created highlight (highest id) is at the top of the screen
var goto_last_button = document.getElementById('goto-last-highlight');
goto_last_button.addEventListener('click', function(e) {
  e.preventDefault();
  var last_id = null;
  for(var id in highlights) {
    if(last_id === null || parseInt(id) > parseInt(last_id)) {
      last_id = id;
    }
  }
  if(last_id === null) {
    return;
  }
  var elements = document.getElementsByClassName('highlight-' + last_id);
  if(!elements.length) {
    return;
  }
  window.scrollTo(0, elements[0].getBoundingClientRect().top + getScrollPos().y - 10);
});

// Backlight
var backlight_checkbox = document.getElementById('backlight');
backlight_checkbox.addEventListener('change', function(e) {
  var classes = document.getElementById('document-view').classList;
  if(backlight_checkbox.checked == classes.contains('backlight')) {
    ; // all good
  } else if(backlight_checkbox.checked) {
    classes.add('backlight');
  } else {
    classes.remove('backlight');
  }
});


/*
 * Add highlight
 */

var highlight_add_modal = document.getElementById('highlight-add-modal');

// Updates current_selection and visibility of the controls
function selectionChanged() {
  current_selection = describeSelection();
  if(current_selection !== null) {
    var current_range = window.getSelection().getRangeAt(0);
    if(current_range.endOffset > 0) {
      var last_char_range = document.createRange();
      last_char_range.setStart(current_range.endContainer, current_range.endOffset - 1);
      last_char_range.setEnd(current_range.endContainer, current_range.endOffset);
      var rect = last_char_range.getClientRects().item(0);
      var scrollPos = getScrollPos();
      hlinfo.style.left = ((rect.x || rect.left) + rect.width) + 'px';
      hlinfo.style.top = ((rect.y || rect.top) + rect.height + scrollPos.y + 20) + 'px';
      hlinfo.style.display = 'block';
    } else {
      // We are in a weird situation where the end of the selection is in
      // an empty node. We just don't move the popup, seems to work in practice
    }
  } else {
    document.getElementById('hlinfo').style.display = 'none';
  }
}
document.addEventListener('selectionchange', selectionChanged);

function createHighlight(selection) {
  document.getElementById('highlight-add-id').value = '';
  document.getElementById('highlight-add-start').value = selection[0];
  document.getElementById('highlight-add-end').value = selection[1];
  document.getElementById('highlight-add-form').reset();
  highlight_add_tag_state = {};  // nothing checked on a new highlight
  $(highlight_add_modal).modal().drags({handle: '.modal-header'});
}

function openHighlightTags(id) {
  document.getElementById('highlight-add-form').reset();
  id = '' + id;
  document.getElementById('highlight-add-id').value = id;
  document.getElementById('highlight-add-start').value = highlights[id].start_offset;
  document.getElementById('highlight-add-end').value = highlights[id].end_offset;
  highlight_add_tag_state = {};  // reseeded from this highlight below
  var hl_tags = highlights[id].tags;
  for(var i = 0; i < hl_tags.length; ++i) {
    document.getElementById('highlight-add-tags-' + hl_tags[i]).checked = true;
    highlight_add_tag_state['' + hl_tags[i]] = true;
  }
  $(highlight_add_modal).modal().drags({handle: '.modal-header'});
}

// Save highlight button
document.getElementById('highlight-add-form').addEventListener('submit', function(e) {
  e.preventDefault();
  var highlight_id = document.getElementById('highlight-add-id').value;
  var selection = [
    parseInt(document.getElementById('highlight-add-start').value),
    parseInt(document.getElementById('highlight-add-end').value)
  ];
  var hl_tags = [];
  var edited_tags = highlight_id
    ? highlights['' + highlight_id].tags : [];
  var entries = Object.entries(tags);
  for(var i = 0; i < entries.length; ++i) {
    var id = entries[i][1].id;
    // The checkbox is missing when the tags-ai filter hides the tag: a
    // tag already on the highlight keeps its state, one never picked
    // stays off
    var checkbox = document.getElementById('highlight-add-tags-' + id);
    if(checkbox ? checkbox.checked
                : edited_tags.indexOf(id) !== -1) {
      hl_tags.push(id);
    }
  }
  var req;
  if(highlight_id) {
    console.log("Posting update for highlight " + highlight_id);
    req = postJSON(
      '/api/project/' + project_id + '/document/' + current_document + '/highlight/' + highlight_id,
      {start_offset: selection[0],
       end_offset: selection[1],
       tags: hl_tags}
    );
  } else {
    console.log("Posting new highlight");
    req = postJSON(
      '/api/project/' + project_id + '/document/' + current_document + '/highlight/new',
      {start_offset: selection[0],
       end_offset: selection[1],
       tags: hl_tags}
    );
  }
  showSpinner();
  req.then(function() {
    console.log("Highlight posted");
    $(highlight_add_modal).modal('hide');
    document.getElementById('highlight-add-form').reset();
  })
  .catch(function(error) {
    console.error("Failed to create highlight:", error);
    alert(gettext("Couldn't create highlight!") + "\n\n" + error);
  })
  .then(hideSpinner);
});

// Delete highlight button
document.getElementById('highlight-delete').addEventListener('click', function(e) {
  var highlight_id = document.getElementById('highlight-add-id').value;
  if(highlight_id) {
    highlight_id = parseInt(highlight_id);
    console.log("Posting highlight " + highlight_id + " deletion");
    deleteURL(
      '/api/project/' + project_id + '/document/' + current_document + '/highlight/' + highlight_id
    )
    .then(function() {
      $(highlight_add_modal).modal('hide');
      document.getElementById('highlight-add-form').reset();
    })
    .catch(function(error) {
      console.error("Failed to delete highlight:", error);
      alert(gettext("Couldn't delete highlight!") + "\n\n" + error);
    });
  }
});


/*
 * Highlight boundary editing
 *
 * A single click on a highlight selects it: blinking brackets appear at
 * its start and end, and a small menu shows up next to it. Dragging a
 * bracket changes the highlight's extent without touching its tags; the
 * tag form is still available through the menu's button, or with a
 * double-click on the highlight.
 */

var hl_select = null;       // Selected highlight: {id, prefix, start, end}
var hl_select_dragging = false;
var hl_menu = document.getElementById('hl-menu');

// Title (tooltip) of a highlight: its tags, sorted, comma-separated
function hlTitleFor(id) {
  var hl = highlights['' + id];
  if(!hl) {
    return '';
  }
  var tag_names = hl.tags.map(function(tag_id) { return tags['' + tag_id].path; });
  sortByKey(tag_names, function(path) { return path; });
  return tag_names.join(", ");
}

// Byte offset of the caret position under the given point
function hlCaretByte(clientX, clientY) {
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

// Insert one boundary bracket inline, at the given byte offset
function hlInsertBracket(prefix, byte, which) {
  var bracket = document.createElement('span');
  bracket.className = 'hl-bracket';
  bracket.setAttribute('data-which', which);
  var pos = locatePos(byte, prefix);
  var node = (pos && pos[0]) ? splitAtPos(pos, false) : null;
  if(node) {
    node.parentNode.insertBefore(bracket, node);
  } else {
    var root = prefix === 'R'
      ? document.getElementById('document-contents-b')
      : document.getElementById('document-contents');
    if(root) {
      root.appendChild(bracket);
    }
  }
  bracket.addEventListener('mousedown', hlBracketMouseDown);
  return bracket;
}

function hlBracketsRemove() {
  var brackets = document.getElementsByClassName('hl-bracket');
  while(brackets.length > 0) {
    var bracket = brackets[0];
    if(bracket.parentNode) {
      bracket.parentNode.removeChild(bracket);
    }
  }
}

function hlMenuHide() {
  if(hl_menu) {
    hl_menu.style.display = 'none';
  }
}

// Show the menu (built once) anchored under the start bracket
function hlMenuShow() {
  if(!hl_menu || !hl_select) {
    return;
  }
  var anchor = document.querySelector('.hl-bracket[data-which="start"]');
  if(!anchor) {
    hlMenuHide();
    return;
  }
  if(!hl_menu.firstChild) {
    var hint = document.createElement('div');
    hint.className = 'hl-menu-hint';
    hint.textContent = gettext("Drag the brackets to change the highlight");
    var button = document.createElement('button');
    button.className = 'btn btn-primary btn-sm';
    button.type = 'button';
    button.textContent = gettext("Add or edit tags");
    button.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var sel = hl_select;
      hlSelectClear();
      if(sel) {
        openHighlightTags(sel.id);
      }
    });
    hl_menu.appendChild(hint);
    hl_menu.appendChild(button);
  }
  hl_menu.style.display = 'block';
  var rect = anchor.getBoundingClientRect();
  var x = Math.max(0, Math.min(rect.left, window.innerWidth - hl_menu.offsetWidth - 8));
  var y = rect.bottom + 4;
  if(y + hl_menu.offsetHeight > window.innerHeight) {
    y = rect.top - hl_menu.offsetHeight - 4;
  }
  hl_menu.style.left = x + 'px';
  hl_menu.style.top = Math.max(0, y) + 'px';
}

// Select a highlight: brackets at its boundaries + menu. The brackets
// are only shown in the pane the user clicked (prefix '' or 'R'), but
// the preview during a drag re-renders every pane, like setHighlight()
function hlSelectShow(id, prefix) {
  hlSelectClear();
  var hl = highlights['' + id];
  if(!hl) {
    return;
  }
  hl_select = {
    id: '' + id,
    prefix: prefix,
    start: hl.start_offset,
    end: hl.end_offset,
  };
  hlInsertBracket(prefix, hl.start_offset, 'start');
  hlInsertBracket(prefix, hl.end_offset, 'end');
  hlMenuShow();
  console.log("Highlight selected:", id);
}

// Drop the selection UI; the highlight itself is left as-is
function hlSelectClear() {
  hl_select = null;
  hlBracketsRemove();
  hlMenuHide();
}

// Click on a highlight: select it (ignore clicks that land on a
// boundary bracket nested inside the highlight's own elements)
function highlightClicked(e) {
  if(e.target && e.target.closest && e.target.closest('.hl-bracket')) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  hlSelectShow(this.getAttribute('data-highlight-id'),
               (this.closest && this.closest('#document-contents-b')) ? 'R' : '');
}

// Double-click on a highlight: open the tag form
function highlightDblClicked(e) {
  if(e.target && e.target.closest && e.target.closest('.hl-bracket')) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  var id = this.getAttribute('data-highlight-id');
  hlSelectClear();
  openHighlightTags(id);
}

// Re-render the selected highlight at the preview offsets, then put the
// brackets back at their new positions
function hlSelectRender(which) {
  var sel = hl_select;
  if(!sel) {
    return;
  }
  hlBracketsRemove();
  removeHighlight(sel.id);
  try {
    highlightSelection([sel.start, sel.end], sel.id, highlightClicked, hlTitleFor(sel.id));
  } catch(error) {
    console.error("Error resizing highlight:", error);
  }
  hlInsertBracket(sel.prefix, sel.start, 'start');
  hlInsertBracket(sel.prefix, sel.end, 'end');
  var dragged = document.querySelector('.hl-bracket[data-which="' + which + '"]');
  if(dragged) {
    dragged.classList.add('hl-dragging');
  }
}

function hlBracketMouseDown(e) {
  if(!hl_select) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  hlMenuHide();
  var which = this.getAttribute('data-which');
  var sel = hl_select;
  var contents = document.getElementById('document-contents');
  var total = contents ? lengthUTF8(contents.textContent) : 0;
  var last_render = Date.now();
  hl_select_dragging = true;
  this.classList.add('hl-dragging');

  function onMove(e2) {
    if(hl_select !== sel) {
      return;
    }
    var b = hlCaretByte(e2.clientX, e2.clientY);
    if(b === null) {
      return;
    }
    if(which === 'start') {
      sel.start = Math.max(0, Math.min(b, sel.end - 1));
    } else {
      sel.end = Math.min(total, Math.max(b, sel.start + 1));
    }
    var now = Date.now();
    if(now - last_render > 100) {
      last_render = now;
      hlSelectRender(which);
    }
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    hl_select_dragging = false;
    if(hl_select !== sel) {
      // Selection dropped mid-drag (Escape key, highlight deleted, view
      // switch): put the stored extent back
      var stored = highlights[sel.id];
      if(stored) {
        removeHighlight(sel.id);
        try {
          highlightSelection([stored.start_offset, stored.end_offset], sel.id, highlightClicked, hlTitleFor(sel.id));
        } catch(err) {
          console.error("Error restoring highlight:", err);
        }
      }
      return;
    }
    var id = sel.id;
    var start = sel.start, end = sel.end;
    var hl = highlights[id];
    if(!hl) {
      hlSelectClear();
      return;
    }
    if(start == hl.start_offset && end == hl.end_offset) {
      // Nothing changed (simple click on the bracket): keep the
      // selection and its menu
      hlMenuShow();
      return;
    }
    hlSelectClear();
    console.log("Posting resize for highlight " + id);
    showSpinner();
    postJSON(
      '/api/project/' + project_id + '/document/' + current_document + '/highlight/' + id,
      {start_offset: start, end_offset: end}
    )
    .then(function() {
      console.log("Highlight resized");
    })
    .catch(function(error) {
      console.error("Failed to resize highlight:", error);
      alert(gettext("Couldn't update highlight!") + "\n\n" + error);
      // Put the highlight back the way it was
      removeHighlight(id);
      try {
        highlightSelection([hl.start_offset, hl.end_offset], id, highlightClicked, hlTitleFor(id));
      } catch(err) {
        console.error("Error restoring highlight:", err);
      }
    })
    .then(hideSpinner);
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
}

// Clicking elsewhere dismisses the brackets and the menu
document.addEventListener('mousedown', function(e) {
  if(!hl_select || hl_select_dragging) {
    return;
  }
  var t = e.target;
  if(t && t.closest && (t.closest('.hl-bracket') || t.closest('#hl-menu')
                        || t.closest('.highlight'))) {
    return;
  }
  hlSelectClear();
}, true);

// Escape dismisses the brackets and the menu
document.addEventListener('keydown', function(e) {
  if(e.key !== 'Escape' || !hl_select) {
    return;
  }
  var t = e.target;
  if(t && (t.tagName == 'INPUT' || t.tagName == 'TEXTAREA'
           || t.tagName == 'SELECT' || t.isContentEditable)) {
    return;
  }
  hlSelectClear();
});

// Keep the menu next to its bracket when the page scrolls or resizes
function hlMenuFollow() {
  if(hl_select && !hl_select_dragging) {
    hlMenuShow();
  }
}
window.addEventListener('scroll', hlMenuFollow);
window.addEventListener('resize', hlMenuFollow);


/*
 * Members
 */

function addMember(login, privileges) {
  members[login] = {privileges: privileges};
}

function removeMember(login) {
  delete members[login];
}

var members_modal = document.getElementById('members-modal');
var members_initial = {};
var members_displayed = {};

function _memberRow(login, user, can_edit, is_self) {
  var elem = document.createElement('div');
  elem.className = 'row members-item';
  elem.innerHTML =
    '<div class="col-md-4">' +
    '  <p class="members-item-login">' + login + '</p>' +
    '</div>' +
    '<div class="col-md-4 form-group">' +
    '  <select class="form-control"' + (can_edit?'':' disabled') + '>' +
    '    <option value="ADMIN">' + gettext("Full permissions") + '</option>' +
    '    <option value="MANAGE_DOCS">' + gettext("Can't change collaborators / delete project") + '</option>' +
    '    <option value="TAG">' + gettext("View & make changes") + '</option>' +
    '    <option value="READ">' + gettext("View only") + '</option>' +
    '  </select>' +
    '</div>' +
    (is_self?
    '<button type="button" class="btn btn-danger col-md-4 form-group">Leave project</button>'
    :
    '<button type="button" class="btn btn-danger col-md-4 form-group"' + (can_edit?'':' disabled') + '>Remove collaborator</button>'
    );

  [].forEach.call(elem.querySelectorAll('option'), function(e) {
    if(e.value == user.privileges) {
      e.selected = true;
    }
  });

  elem.querySelector('button').addEventListener('click', function(e) {
    elem.parentNode.removeChild(elem);
    delete members_displayed[login];
  });

  return elem;
}

function showMembers() {
  document.getElementById('members-add').reset();

  can_edit = members[user_login].privileges == 'ADMIN';

  if(can_edit) {
    document.getElementById('members-add-fields').removeAttribute('disabled');
  } else {
    document.getElementById('members-add-fields').setAttribute('disabled', 1);
  }

  var entries = Object.entries(members);
  sortByKey(entries, function(e) { return e[0]; });
  console.log(
    "Members:",
    entries.map(function(e) { return e[0] + " (" + e[1].privileges + ")"; })
    .join(", ")
  );

  // Empty the list
  var current_members = document.getElementById('members-current');
  current_members.innerHTML = '';

  // Fill it back up
  for(var i = 0; i < entries.length; ++i) {
    var login = entries[i][0];
    var user = entries[i][1];
    var elem = _memberRow(login, user, can_edit, login == user_login);

    current_members.appendChild(elem);
  }

  // Store current state so that we can compare later
  members_initial = Object.assign({}, members);
  members_displayed = Object.assign({}, members);

  $(members_modal).modal();
}

document.getElementById('members-add').addEventListener('submit', function(e) {
  e.preventDefault();

  var login = document.getElementById('member-add-name').value.toLowerCase();
  if(!login) { return; }
  var privileges = document.getElementById('member-add-privileges').value;

  // Check login
  if(login in members_displayed) {
    alert(gettext("Already a member!"));
    document.getElementById('members-add').reset();
    return;
  }
  postJSON(
    '/api/check_user',
    {login: login}
  )
  .then(function(result) {
    if(result.exists) {
      // Add it at the top
      var elem = _memberRow(login, {privileges: privileges});
      var current_members = document.getElementById('members-current');
      current_members.insertBefore(elem, current_members.firstChild);
      members_displayed[login] = true;

      document.getElementById('members-add').reset();
    } else {
      alert(gettext("This user doesn't exist!"));
    }
  })
});

function sendMembersPatch() {
  var patch = {};

  var members_before = Object.assign({}, members_initial);

  var rows = document.getElementById('members-current').querySelectorAll('.members-item');
  for(var i = 0; i < rows.length; ++i) {
    var row = rows[i];
    var login = row.querySelector('.members-item-login').textContent;
    var privileges = row.querySelector('select').value;

    // Add to patch, if different from stored version
    if(!members_before[login] || members_before[login].privileges != privileges) {
      patch[login] = {privileges: privileges};
    }

    // Remove from object, so what's left are the removed members
    delete members_before[login];
  }

  // Remove the members that are left
  var entries = Object.entries(members_before);
  for(var i = 0; i < entries.length; ++i) {
    patch[entries[i][0]] = null;
  }

  console.log("Patching members list");
  showSpinner();
  patchJSON(
    '/api/project/' + project_id + '/members',
    patch
  )
  .then(function() {
    console.log("Members list patched");
    $(members_modal).modal('hide');
  })
  .catch(function(error) {
    console.error("Failed to patch members list:", error);
    alert(gettext("Couldn't update collaborators!") + "\n\n" + error);
  })
  .then(hideSpinner);

  members_initial = {};
}

document.getElementById('members-submit').addEventListener('click', function(e) {
  e.preventDefault();
  sendMembersPatch();
});

document.getElementById('members-current').addEventListener('submit', function(e) {
  e.preventDefault();
  sendMembersPatch();
});


/*
 * Load contents
 */

var document_contents = document.getElementById('document-contents');
var export_button = document.getElementById('export-button');

function loadDocument(document_id, keep_scroll) {
  if(document_id === null) {
    hlSelectClear();
    document_contents.innerHTML = '<p style="font-style: oblique; text-align: center;">' + gettext("Load a document on the left") + '</p>';
    goto_last_button.style.display = 'none';
    return;
  }
  showSpinner();
  return getJSON(
    '/api/project/' + project_id + '/document/' + document_id + '/content'
  )
  .then(function(result) {
    hlSelectClear();
    document_contents.innerHTML = '';
    highlights = {};
    chunk_offsets = [];
    for(var i = 0; i < result.contents.length; ++i) {
      var chunk = result.contents[i];
      var elem = document.createElement('div');
      elem.setAttribute('id', 'doc-offset-' + chunk.offset);
      elem.innerHTML = chunk.contents;
      document_contents.appendChild(elem);
      chunk_offsets.push(chunk.offset);
    }
    current_document = document_id;
    var document_links = document.getElementsByClassName('document-link-current');
    for(var i = document_links.length - 1; i >= 0; --i) {
      document_links[i].classList.remove('document-link-current');
    }
    document.getElementById('document-link-' + current_document).classList.add('document-link-current');
    current_tag = null;
    var tag_links = document.getElementsByClassName('tag-current');
    for(var i = tag_links.length - 1; i >= 0; --i) {
      tag_links[i].classList.remove('tag-current');
    }
    console.log("Loaded document", document_id);
    for(var i = 0; i < result.highlights.length; ++i) {
      setHighlight(result.highlights[i]);
    }
    console.log("Loaded " + result.highlights.length + " highlights");

    // Update export button
    export_button.style.display = '';
    goto_last_button.style.display = '';
    var items = export_button.getElementsByClassName('dropdown-item');
    for(var i = 0; i < items.length; ++i) {
      var ext = items[i].getAttribute('data-extension');
      if(items[i].getAttribute('data-document') !== 'false') {
        items[i].setAttribute(
          'href',
          '/project/' + project_id + '/export/document/' + document_id + '.' + ext,
        );
        items[i].style.display = '';
      } else {
        items[i].style.display = 'none';
      }
    }

    // Scroll up (unless the caller keeps the position, e.g. after an edit)
    if(keep_scroll !== true) {
      window.setTimeout(function() { window.scrollTo(0, 0); }, 0);
    }
  })
  .catch(function(error) {
    console.error("Failed to load document:", error);
    alert(gettext("Error loading document!") + "\n\n" + error);
  })
  .then(hideSpinner);
}

/*
 * Tag view header (right panel): when a tag is selected, show its name as
 * a title and its definition below it, above the list of highlights.
 * Both are editable in place (✎ or click on the text).
 */

function tagByPath(path) {
  var entries = Object.entries(tags);
  for(var i = 0; i < entries.length; ++i) {
    if(entries[i][1].path == path) {
      return entries[i][1];
    }
  }
  return null;
}

function saveTagField(tag_id, patch) {
  return postJSON(
    '/api/project/' + project_id + '/tag/' + tag_id,
    patch
  );
}

function tagHeaderRefreshInPlace() {
  var header = document.getElementById('tag-view-header');
  if(header && header.parentNode) {
    header.parentNode.replaceChild(renderTagHeader(current_tag), header);
  }
}

// Replace one row's contents (title or description) with an inline editor;
// the other row stays visible and untouched
function tagHeaderEditField(row, tag, field, on_done) {
  while(row.firstChild) {
    row.removeChild(row.firstChild);
  }
  var is_desc = field == 'description';
  var editor = document.createElement(is_desc ? 'textarea' : 'input');
  editor.className = 'form-control';
  if(is_desc) {
    editor.rows = 3;
  }
  editor.value = is_desc ? (tag.description || '') : tag.path;

  var save = document.createElement('button');
  save.className = 'btn btn-primary btn-sm mr-1 mt-1';
  save.textContent = gettext("Save");
  var cancel = document.createElement('button');
  cancel.className = 'btn btn-secondary btn-sm mt-1';
  cancel.textContent = gettext("Cancel");

  row.appendChild(editor);
  row.appendChild(save);
  row.appendChild(cancel);
  editor.focus();

  function restore() {
    var cur = tags['' + tag.id];
    var fresh = is_desc ? tagHeaderBuildDescRow(cur) : tagHeaderBuildTitleRow(cur);
    row.parentNode.replaceChild(fresh, row);
  }
  cancel.addEventListener('click', function(e) {
    e.preventDefault();
    restore();
  });
  editor.addEventListener('keydown', function(e) {
    if(e.key === 'Escape') {
      restore();
    }
  });
  save.addEventListener('click', function(e) {
    e.preventDefault();
    var value = editor.value;
    if(!is_desc && !value.trim()) {
      alert(gettext("Invalid tag name"));
      return;
    }
    if(value == tag[field]) {
      restore();
      return;
    }
    var patch = {};
    patch[field] = value;
    showSpinner();
    saveTagField(tag.id, patch)
    .then(function() {
      console.log("Tag field updated:", field);
      tags['' + tag.id][field] = value;
      updateTagsList();
      on_done();
    })
    .catch(function(error) {
      console.error("Failed to update tag:", error);
      alert(gettext("Couldn't update the tag!") + "\n\n" + error);
    })
    .then(hideSpinner);
  });
}

function tagHeaderBuildTitleRow(tag) {
  var title = document.createElement('div');
  title.className = 'd-flex align-items-center flex-wrap';
  title.setAttribute('id', 'tag-view-title-row');
  var title_h = document.createElement('h2');
  title_h.textContent = tag.path;
  title_h.title = gettext("Edit tag name");
  var title_pencil = document.createElement('a');
  title_pencil.href = 'javascript:void(0)';
  title_pencil.className = 'tag-view-pencil';
  title_pencil.title = gettext("Edit tag name");
  title_pencil.innerHTML = '&#9998;';
  title.appendChild(title_h);
  title.appendChild(title_pencil);

  var edit_path = function(e) {
    e.preventDefault();
    tagHeaderEditField(title, tag, 'path', function() {
      // The rename changes which highlights match: reload the tag view
      var new_path = tags['' + tag.id].path;
      var url = '/project/' + project_id + '/highlights/' + encodeURIComponent(new_path);
      window.history.replaceState({tag_path: new_path}, 'Tag ' + new_path, url);
      loadTag(new_path);
    });
  };
  title_h.addEventListener('click', edit_path);
  title_pencil.addEventListener('click', edit_path);
  return title;
}

function tagHeaderBuildDescRow(tag) {
  var desc = document.createElement('div');
  desc.className = 'd-flex align-items-start flex-wrap';
  desc.setAttribute('id', 'tag-view-desc-row');
  var desc_p = document.createElement('p');
  desc_p.className = 'tag-view-desc';
  desc_p.title = gettext("Edit tag description");
  if(tag.description) {
    desc_p.textContent = tag.description;
  } else {
    desc_p.classList.add('tag-view-desc-empty');
    desc_p.textContent = gettext("(no definition)");
  }
  var desc_pencil = document.createElement('a');
  desc_pencil.href = 'javascript:void(0)';
  desc_pencil.className = 'tag-view-pencil';
  desc_pencil.title = gettext("Edit tag description");
  desc_pencil.innerHTML = '&#9998;';
  desc.appendChild(desc_p);
  desc.appendChild(desc_pencil);

  var edit_desc = function(e) {
    e.preventDefault();
    tagHeaderEditField(desc, tag, 'description', function() {
      // Only this row is replaced; the title row (even mid-edit) is kept
      var cur = tags['' + tag.id];
      desc.parentNode.replaceChild(tagHeaderBuildDescRow(cur), desc);
    });
  };
  desc_p.addEventListener('click', edit_desc);
  desc_pencil.addEventListener('click', edit_desc);
  return desc;
}

function renderTagHeader(tag_path) {
  if(tag_path === '') {
    // "All highlights" view: no header
    return null;
  }
  var header = document.createElement('div');
  header.className = 'tag-view-header';
  header.setAttribute('id', 'tag-view-header');

  var tag = tagByPath(tag_path);
  if(!tag) {
    // No exact match: a path that is a common prefix of several tags
    var prefix_h = document.createElement('h2');
    prefix_h.textContent = tag_path;
    header.appendChild(prefix_h);
    var prefix_p = document.createElement('p');
    prefix_p.className = 'tag-view-desc tag-view-desc-empty';
    prefix_p.textContent = gettext("Common prefix of several tags");
    header.appendChild(prefix_p);
    return header;
  }
  header.setAttribute('data-tag-id', '' + tag.id);

  header.appendChild(tagHeaderBuildTitleRow(tag));
  header.appendChild(tagHeaderBuildDescRow(tag));

  return header;
}

// A tag changed (possibly by a collaborator): refresh the header if it
// displays that tag, following a rename if needed
function refreshTagViewHeader(tag_id) {
  var header = document.getElementById('tag-view-header');
  if(!header || current_tag === null) {
    return;
  }
  var stored = header.getAttribute('data-tag-id');
  if(stored === null || parseInt(stored) !== parseInt(tag_id)) {
    return;
  }
  var tag = tags['' + tag_id];
  if(!tag) {
    return;
  }
  if(tag.path == current_tag) {
    tagHeaderRefreshInPlace();
  } else {
    var url = '/project/' + project_id + '/highlights/' + encodeURIComponent(tag.path);
    window.history.replaceState({tag_path: tag.path}, 'Tag ' + tag.path, url);
    loadTag(tag.path);
  }
}

function loadTag(tag_path, page) {
  if(page === undefined) {
    page = 1;
  }
  showSpinner();
  getJSON(
    '/api/project/' + project_id + '/highlights/' + encodeURIComponent(tag_path) + '?page=' + page
  )
  .then(function(result) {
    console.log("Loaded highlights for tag", tag_path || "''");
    hlSelectClear();
    current_tag = tag_path;
    current_document = null;
    var document_links = document.getElementsByClassName('document-link-current');
    for(var i = document_links.length - 1; i >= 0; --i) {
      document_links[i].classList.remove('document-link-current');
    }
    // No need to clear the 'tag-current', we are calling updateTagsList() below
    document_contents.innerHTML = '';
    highlights = {};
    // Tag header: name as title, definition below, above the highlights
    var tag_header = renderTagHeader(tag_path);
    if(tag_header) {
      document_contents.appendChild(tag_header);
    }
    for(var i = 0; i < result.highlights.length; ++i) {
      var hl = result.highlights[i];
      var elem = document.createElement('div');
      elem.className = 'highlight-entry';
      elem.setAttribute('id', 'highlight-entry-' + hl.id);
      elem.innerHTML = result.highlights[i].content;

      var doclink = document.createElement('a');
      doclink.className = 'badge badge-light';
      doclink.textContent = documents['' + hl.document_id].name;
      linkDocument(doclink, hl.document_id);
      elem.appendChild(doclink);
      elem.appendChild(document.createTextNode(' '));

      var tag_names = hl.tags.map(function(tag) { return tags['' + tag].path; });
      tag_names.sort();
      for(var j = 0; j < tag_names.length; ++j) {
        if(j > 0) {
          elem.appendChild(document.createTextNode(' '));
        }
        var taglink = document.createElement('a');
        taglink.className = 'badge badge-dark';
        taglink.textContent = tag_names[j];
        linkTag(taglink, taglink.textContent);
        elem.appendChild(taglink);
      }

      document_contents.appendChild(elem);
    }
    if(result.highlights.length == 0) {
      var no_hl = document.createElement('p');
      no_hl.style.fontStyle = 'oblique';
      no_hl.style.textAlign = 'center';
      no_hl.textContent = gettext("No highlights with this tag yet.");
      document_contents.appendChild(no_hl);
    }

    // Pagination controls
    function makePageLink(page_nb, label, current, enabled) {
      var item;
      if(current) {
        item = document.createElement('li');
        item.className = 'page-item active';
        item.innerHTML = '<span class="page-link">' + label + '<span class="sr-only">(current)</span></span>';
      } else if(!enabled) {
        item = document.createElement('li');
        item.className = 'page-item disabled';
        item.innerHTML = '<span class="page-link">' + label + '</span>';
      } else {
        item = document.createElement('li');
        item.className = 'page-item';
        var link = document.createElement('a');
        link.className = 'page-link';
        link.setAttribute('href', '#');
        link.innerText = label;
        link.addEventListener('click', function(e) {
          e.preventDefault();
          loadTag(tag_path, page_nb);
        });
        item.appendChild(link);
      }
      return item;
    }
    if(result.pages > 1 || page !== 1) {
      if(result.pages === undefined && page !== 1) {
        result.pages = 1;
      }
      pagination = document.createElement('nav');
      pagination.setAttribute('aria-label', "Page navigation");
      var pagination_ul = document.createElement('ul');
      pagination_ul.className = 'pagination justify-content-center';
      var min_page = Math.max(2, page - 2);
      var max_page = Math.min(result.pages - 1, page + 2);

      // Previous button
      pagination_ul.appendChild(makePageLink(page - 1, "Previous", false, page > 1));
      // Page 1
      pagination_ul.appendChild(makePageLink(1, 1, 1 === page, 1 !== page));
      // "..." between 1 and other pages, if appropriate
      if(min_page > 2) {
        pagination_ul.appendChild(makePageLink(page, "...", false, false));
      }
      // Other pages
      for(var i = min_page; i <= max_page; ++i) {
        pagination_ul.appendChild(makePageLink(i, i, i === page, i !== page));
      }
      // "..." between other pages and last page, if appropriate
      if(max_page < result.pages - 1) {
        pagination_ul.appendChild(makePageLink(page, "...", false, false));
      }
      // Last page
      pagination_ul.appendChild(makePageLink(result.pages, result.pages, result.pages === page, result.pages !== page));
      // Next button
      pagination_ul.appendChild(makePageLink(page + 1, "Next", false, page < result.pages));

      pagination.appendChild(pagination_ul);
      document_contents.appendChild(pagination);
    }

    updateTagsList();

    // Update export button (the "last highlight" button only makes sense
    // when a document is displayed)
    export_button.style.display = '';
    goto_last_button.style.display = 'none';
    var items = export_button.getElementsByClassName('dropdown-item');
    for(var i = 0; i < items.length; ++i) {
      var ext = items[i].getAttribute('data-extension');
      if(items[i].getAttribute('data-highlights') !== 'false') {
        items[i].setAttribute(
          'href',
          '/project/' + project_id + '/export/highlights/' + encodeURIComponent(tag_path) + '.' + ext,
        );
        items[i].style.display = '';
      } else {
        items[i].style.display = 'none';
      }
    }

    // Scroll up
    window.setTimeout(function() { window.scrollTo(0, 0); }, 0);
  })
  .catch(function(error) {
    console.error("Failed to load tag highlights:", error);
    alert(gettext("Error loading tag highlights!") + "\n\n" + error);
  })
  .then(hideSpinner);
}

// Load the document if the URL includes one
setTimeout(
  function() {
    var _document_url = new RegExp('/project/([0-9]+)/document/([0-9]+)');
    // Don't use RegExp literals https://github.com/python-babel/babel/issues/640
    var m = window.location.pathname.match(_document_url);
    if(m) {
      loadDocument(parseInt(m[2]));
    }
    // Or a tag
    var _tag_url = new RegExp('/project/([0-9]+)/highlights/([^/]*)');
    m = window.location.pathname.match(_tag_url);
    if(m) {
      loadTag(decodeURIComponent(m[2]));
    }
  },
  0,
);


// Load documents as we go through browser history
window.onpopstate = function(e) {
  if(e.state) {
    if(e.state.document_id !== undefined) {
      loadDocument(e.state.document_id);
    } else if(e.state.tag_path !== undefined) {
      loadTag(e.state.tag_path);
    } else {
      loadDocument(null);
    }
  } else {
    loadDocument(null);
  }
};


/*
 * Long polling
 */

// null: active now
// Date: inactive since then
var windowLastActive = new Date();
if(document.hasFocus()) {
  windowLastActive = null; // Focused now
}

window.addEventListener('focus', function() {
  // We are active as long as we have the focus
  windowLastActive = null;
  maybeResumePolling();
});
window.addEventListener('mousemove', function() {
  if(windowLastActive !== null) {
    // If the mouse moved over the window and we're not focused, refresh timer
    windowLastActive = new Date();
    maybeResumePolling();
  }
});
window.addEventListener('blur', function() {
  // We lost focus, start timer
  windowLastActive = new Date();
});

var lastPoll = null;
var polling = true;

function maybeResumePolling() {
  if(!polling) {
    longPollForEvents();
  }
}

function longPollForEvents() {
  // If we've been inactive for 10min, pause polling for now
  if(windowLastActive !== null && (new Date() - windowLastActive > 600000)) {
    console.log("Browser window inactive, stop polling");
    polling = false;
    return;
  }

  polling = true;
  lastPoll = Date.now();
  getJSON(
    '/api/project/' + project_id + '/events',
    {from: last_event}
  )
  .then(function(result) {
    if(result.reload) {
      console.log("Server sent signal to reload");
      window.location.reload();
      return;
    }
    for(var i = 0; i < result.events.length; ++i) {
      var event = result.events[i];
      if(event.type === 'project_meta') {
        setProjectMetadata({
          project_name: event.project_name,
          description: event.description
        });
      } else if(event.type === 'document_add') {
        addDocument({
          id: event.document_id,
          name: event.document_name,
          description: event.description
        });
      } else if(event.type === 'document_delete') {
        removeDocument(event.document_id);
      } else if(event.type === 'highlight_add') {
        setHighlight({
          id: event.highlight_id,
          start_offset: event.start_offset,
          end_offset: event.end_offset,
          tags: event.tags
        });
      } else if(event.type === 'highlight_delete') {
        if(hl_select && hl_select.id == '' + event.highlight_id) {
          hlSelectClear();
        }
        removeHighlight(event.highlight_id);
      } else if(event.type === 'tag_add') {
        addTag({
          id: event.tag_id,
          path: event.tag_path,
          description: event.description,
          parent_id: ('parent_id' in event) ? event.parent_id : null,
        });
        refreshTagViewHeader(event.tag_id);
      } else if(event.type === 'tag_move') {
        moveTagLocal(event.tag_id, event.parent_id);
      } else if(event.type === 'tag_delete') {
        // Children of the deleted tag move up to its own parent
        var deleted_tag = tags['' + event.tag_id];
        var orphan_parent = deleted_tag ? deleted_tag.parent_id : null;
        var tag_entries = Object.entries(tags);
        for(var i = 0; i < tag_entries.length; ++i) {
          if(tag_entries[i][1].parent_id != null
             && tag_entries[i][1].parent_id == event.tag_id) {
            tag_entries[i][1].parent_id = orphan_parent;
          }
        }
        removeTag(event.tag_id);
      } else if(event.type === 'tag_merge') {
        // Children of the source tag move to the destination tag
        var tag_entries = Object.entries(tags);
        for(var i = 0; i < tag_entries.length; ++i) {
          if(tag_entries[i][1].parent_id != null
             && tag_entries[i][1].parent_id == event.src_tag_id) {
            tag_entries[i][1].parent_id = event.dest_tag_id;
          }
        }
        mergeTags(event.src_tag_id, event.dest_tag_id);
      } else if(event.type === 'member_add') {
        addMember(event.member, event.privileges);
      } else if(event.type === 'member_remove') {
        removeMember(event.member);
      }

      if('tag_count_changes' in event) {
        var entries = Object.entries(event.tag_count_changes);
        for(var i = 0; i < entries.length; ++i) {
          updateTagCount(entries[i][0], entries[i][1]);
        }
      }
      last_event = event.id;
    }

    // Re-open connection
    setTimeout(longPollForEvents, 1);
  }, function(error) {
    console.error("Polling failed:", error);
    if(error instanceof ApiError && error.status == 403) {
      alert(gettext("It appears that you have been logged out."));
      window.location = '/';
    } else if(error instanceof ApiError && error.status == 404) {
      alert(gettext("You can no longer access this project."));
      window.location = '/';
    } else {
      setTimeout(longPollForEvents, Math.max(1, 5000 + lastPoll - Date.now()));
    }
  })
  .catch(function(error) {
    console.error("Polling function error:", error);
  });
}
longPollForEvents();
