/*
 * Table of contents
 *
 * - Utilities
 * - Selection stuff
 * - Project metadata
 * - Documents list
 * - Add document
 * - Tags list
 * - Highlights
 * - Add highlight
 * - Members
 * - Load contents
 * - Long polling
 */


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

function sortByKey(array, key, reverse) {
  var orderByX = 1;
  if(reverse){
    orderByX = -1
  }
  array.sort(function(a, b) {
    if(key(a) < key(b)) {
      return -1 * orderByX;
    } else if(key(a) > key(b)) {
      return 1 * orderByX;
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

var onlyWhitespace = new RegExp('^[\r\n\t]*$');

function getScrollPos() {
  var doc = document.scrollingElement || document.documentElement, body = document.body;
  var x = (doc && doc.scrollLeft || body && body.scrollLeft || 0) - (doc.clientLeft || 0);
  var y = (doc && doc.scrollTop || body && body.scrollTop || 0) - (doc.clientTop || 0);
  return {x: x, y: y};
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
    base_path + url + args,
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
    return response.json().catch(function() { throw new ApiError(response, "Invalid JSON"); });
  });
}

function deleteURL(url='', args) {
  if(args) {
    args = encodeGetParams(args);
  } else {
    args = '';
  }
  var xsrf = getCookie('_xsrf');
  return fetch(
    base_path + url + '?' + (xsrf !== undefined ? '_xsrf=' + encodeURIComponent(xsrf) + '&' : '') + args,
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
    args = encodeGetParams(args);
  } else {
    args = '';
  }
  var xsrf = getCookie('_xsrf');
  return fetch(
    base_path + url + '?' + (xsrf !== undefined ? '_xsrf=' + encodeURIComponent(xsrf) + '&' : '') + args,
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
    return response.json().catch(function() { throw new ApiError(response, "Invalid JSON"); });
  });
}

function patchJSON(url='', data={}, args) {
  if(args) {
    args = encodeGetParams(args);
  } else {
    args = '';
  }
  var xsrf = getCookie('_xsrf');
  return fetch(
    base_path + url + '?' + (xsrf !== undefined ? '_xsrf=' + encodeURIComponent(xsrf) + '&' : '') + args,
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
    } else {
      return null;
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

// Escape a string for use in a regexp
// https://stackoverflow.com/a/6969486/711380
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
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
  return parseInt(node.id.substring(11)) + offset;
}

// Find a position from the document offset
function locatePos(pos) {
  // Find the right chunk
  var chunk_start = 0;
  for(var i = 0; i < chunk_offsets.length; ++i) {
    if(chunk_offsets[i] > pos) {
      break;
    }
    chunk_start = chunk_offsets[i];
  }

  var offset = pos - chunk_start;
  var node = document.getElementById('doc-offset-' + chunk_start);
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

// Highlight a described selection
function highlightSelection(saved, id, clickedCallback, title) {
  console.log("Highlighting", saved);
  if(saved === null) {
    return;
  }
  var start = locatePos(saved[0]);
  start = splitAtPos(start, false);
  var end = locatePos(saved[1]);
  end = splitAtPos(end, true);

  var node = start;
  while(node != end) {
    var next = nextElement(node);
    if(node.nodeType == 3 // TEXT_NODE
     && node.textContent
     && !node.textContent.match(onlyWhitespace)) {
      var span = document.createElement('a');
      span.className = 'highlight highlight-' + id;
      span.setAttribute('data-highlight-id', '' + id);
      span.setAttribute('title', title);
      span.addEventListener('click', clickedCallback);
      node.parentNode.insertBefore(span, node);
      span.appendChild(node);
    }
    node = next;
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
    .then(function() {
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
var last_added_tag = null;
var documents_list = document.getElementById('documents-list');

function linkDocument(elem, doc_id) {
  var url = base_path + '/project/' + project_id + '/document/' + doc_id;
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
    if(doc.id === current_document) {
      elem.classList.add('document-link-current');
    }
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
  if(document.id === current_document) {
    // Text direction is the only meaningful thing that can be mutated
    if(document.text_direction === 'RIGHT_TO_LEFT') {
      document_contents.style.direction = 'rtl';
    } else {
      document_contents.style.direction = 'ltr';
    }
  }
  updateDocumentsList();
}

function removeDocument(document_id) {
  delete documents['' + document_id];
  updateDocumentsList();
  if(current_document == document_id) {
    window.history.pushState({}, "Project", base_path + '/project/' + project_id);
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
    name = name.substring(0, 50);
  }
  form_data.append('name', name);
  form_data.append('description',
                   document.getElementById('document-add-description').value);
  form_data.append('file',
                   document.getElementById('document-add-file').files[0]);
  form_data.append('text_direction',
                   document.getElementById('document-add-form').elements['document-add-direction'].value);
  form_data.append('_xsrf', getCookie('_xsrf'));

  var xhr = new XMLHttpRequest();
  xhr.responseType = 'json';
  xhr.open('POST', base_path + '/api/project/' + project_id + '/document/new');
  showSpinner();
  xhr.onload = function() {
    if(xhr.status == 200) {
      $(document_add_modal).modal('hide');
      document.getElementById('document-add-form').reset();
      console.log("Document upload complete");
      var doc_id = xhr.response.created;
      var url = base_path + '/project/' + project_id + '/document/' + doc_id;
      window.history.pushState({document_id: doc_id}, "Document " + doc_id, url);
      loadDocument(doc_id);
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
  document.getElementById('document-change-form').elements['document-change-direction'].value = documents['' + doc_id].text_direction;
  $(document_change_modal).modal();
}

document.getElementById('document-change-form').addEventListener('submit', function(e) {
  e.preventDefault();
  console.log("Changing document...");

  var update = {
    name: document.getElementById('document-change-name').value,
    description: document.getElementById('document-change-description').value,
    text_direction: document.getElementById('document-change-form').elements['document-change-direction'].value
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
 * Tags list & Hierarchical Navigation
 */

var tags_sorter = document.getElementById('tag-sortby');
var sortTags = ['path', 'asc'];
var tags_list = document.getElementById('tags-list');
var tags_modal_list = document.getElementById('highlight-add-tags');

var expandedTagNodes = new Set();
var highlightNavFolder = null;
var highlightSelectedTags = {};
var pendingReparentData = null;

function getTagFullPath(tag_id) {
  var tag = tags['' + tag_id];
  if(!tag) return '';
  var parts = [];
  var curr = tag;
  var visited = {};
  while(curr && !visited[curr.id]) {
    visited[curr.id] = true;
    parts.unshift(curr.path);
    if(curr.parent_id && tags['' + curr.parent_id]) {
      curr = tags['' + curr.parent_id];
    } else {
      break;
    }
  }
  return parts.join(' | ');
}

function getTagChildren(tag_id) {
  var res = [];
  for(var id in tags) {
    if(tag_id === null || tag_id === undefined) {
      if(!tags[id].parent_id) res.push(tags[id]);
    } else {
      if(tags[id].parent_id == tag_id) res.push(tags[id]);
    }
  }
  return res;
}

function getTagDescendants(tag_id) {
  var descendants = [];
  var queue = getTagChildren(tag_id);
  while(queue.length > 0) {
    var curr = queue.shift();
    descendants.push(curr);
    var children = getTagChildren(curr.id);
    for(var i = 0; i < children.length; ++i) {
      queue.push(children[i]);
    }
  }
  return descendants;
}

function sortTagsBy(field, dir) {
  sortTags = [field, dir];
  var options = document.getElementById('tag-sortby-menu').querySelectorAll('a.dropdown-item');
  var optionSorts = [
    ['path', 'asc'],
    ['path', 'desc'],
    ['count', 'asc'],
    ['count', 'desc'],
  ];
  for(var i = 0; i < optionSorts.length; ++i) {
    if(optionSorts[i][0] === field && optionSorts[i][1] === dir) {
      options[i].classList.add('active');
    } else {
      options[i].classList.remove('active');
    }
  }
  updateTagsList();
}

function linkTag(elem, tag_path) {
  var url = base_path + '/project/' + project_id + '/highlights/' + encodeURIComponent(tag_path);
  elem.setAttribute('href', url);
  elem.addEventListener('click', function(e) {
    e.preventDefault();
    window.history.pushState({tag_path: tag_path}, "Tag " + tag_path, url);
    loadTag(tag_path);
  });
}

linkTag(document.getElementById('load-all-tags'), '');

function addTag(tag) {
  if(!('count' in tag) && tag.id in tags) {
    tag.count = tags[tag.id].count;
  } else if(!('count' in tag)) {
    tag = Object.assign({'count': 0}, tag);
  }
  tags[tag.id] = tag;
  if(tag.parent_id && !expandedTagNodes.has(tag.parent_id)) {
    expandedTagNodes.add(tag.parent_id);
  }
  updateTagsList();

  if(tag.id == last_added_tag) {
    toggleHighlightSelectedTag(tag.id, true);
  }
}

function removeTag(tag_id) {
  delete tags['' + tag_id];
  delete highlightSelectedTags['' + tag_id];
  var hl_entries = Object.entries(highlights);
  for(var i = 0; i < hl_entries.length; ++i) {
    var hl = hl_entries[i][1];
    hl.tags = hl.tags.filter(function(v) { return v != tag_id; });
  }
  updateTagsList();
}

function mergeTags(tag_src, tag_dest) {
  for(var id in highlights) {
    var hl_tags = highlights[id].tags;
    if(hl_tags.includes(tag_src)) {
      var idx = hl_tags.indexOf(tag_src);
      hl_tags.splice(idx, 1);
      if(!hl_tags.includes(tag_dest)) {
        hl_tags.push(tag_dest);
      }
    }
  }
  for(var tid in tags) {
    if(tags[tid].parent_id == tag_src) {
      tags[tid].parent_id = tag_dest;
    }
  }
  delete tags['' + tag_src];
  delete highlightSelectedTags['' + tag_src];
  updateTagsList();
}

function updateTagsList() {
  var stickyPane = document.querySelector('div.sticky-top');
  var prevPaneScroll = stickyPane ? stickyPane.scrollTop : 0;
  var prevWindowScroll = window.scrollY || document.documentElement.scrollTop;

  while(tags_list.firstChild) {
    var first = tags_list.firstChild;
    if(first.classList && first.classList.contains('special-item-button')) {
      break;
    }
    tags_list.removeChild(first);
  }

  var isReverse = sortTags[1] == 'desc';

  function renderTreeNode(tag, depth, container) {
    var children = getTagChildren(tag.id);
    sortByKey(children, function(c) { return c[sortTags[0]]; }, isReverse);

    var li = document.createElement('li');
    li.className = 'list-group-item p-1 border-0';
    li.id = 'tag-item-' + tag.id;

    var isCurrent = current_tag !== null && tag.path.substr(0, current_tag.length) == current_tag;
    if(isCurrent) {
      li.classList.add('tag-current');
    }

    var row = document.createElement('div');
    row.className = 'd-flex justify-content-between align-items-center py-1';
    row.style.paddingLeft = (depth * 18) + 'px';

    var left = document.createElement('div');
    left.className = 'tag-name d-flex align-items-center text-truncate mr-1';

    if(children.length > 0) {
      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'btn btn-sm btn-link p-0 mr-1 text-secondary';
      toggleBtn.style.textDecoration = 'none';
      toggleBtn.style.width = '16px';
      var isExpanded = expandedTagNodes.has(tag.id);
      toggleBtn.innerHTML = isExpanded ? '<i class="fa fa-caret-down"></i>' : '<i class="fa fa-caret-right"></i>';
      toggleBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var childUl = li.querySelector(':scope > ul');
        if(expandedTagNodes.has(tag.id)) {
          expandedTagNodes.delete(tag.id);
          toggleBtn.innerHTML = '<i class="fa fa-caret-right"></i>';
          if(childUl) {
            childUl.style.display = 'none';
          }
        } else {
          expandedTagNodes.add(tag.id);
          toggleBtn.innerHTML = '<i class="fa fa-caret-down"></i>';
          if(childUl) {
            childUl.style.display = 'block';
          }
          li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
      left.appendChild(toggleBtn);
    } else {
      var spacer = document.createElement('span');
      spacer.style.display = 'inline-block';
      spacer.style.width = '16px';
      spacer.className = 'mr-1';
      left.appendChild(spacer);
    }

    var a = document.createElement('a');
    a.id = 'tag-link-' + tag.id;
    a.className = 'text-dark text-truncate';
    a.textContent = tag.path;
    a.title = getTagFullPath(tag.id) + (tag.description ? '\n' + tag.description : '');
    left.appendChild(a);
    row.appendChild(left);

    var right = document.createElement('div');
    right.className = 'd-flex align-items-center flex-shrink-0';
    right.innerHTML =
      '<span class="badge badge-secondary badge-pill mr-1" id="tag-' + tag.id + '-count">' + tag.count + '</span>' +
      '<button type="button" class="btn btn-outline-success btn-xs mr-1 p-0 px-1" title="' + gettext("Criar subtag nesta categoria") + '" onclick="createSubtag(' + tag.id + ')"><i class="fa fa-plus"></i></button>' +
      '<a href="javascript:editTag(' + tag.id + ');" class="btn btn-primary btn-sm py-0 px-1">' + gettext("Edit") + '</a>';
    row.appendChild(right);

    li.appendChild(row);
    container.appendChild(li);
    linkTag(a, tag.path);

    if(children.length > 0) {
      var childUl = document.createElement('ul');
      childUl.className = 'list-unstyled mb-0';
      if(!expandedTagNodes.has(tag.id)) {
        childUl.style.display = 'none';
      }
      for(var i = 0; i < children.length; ++i) {
        renderTreeNode(children[i], depth + 1, childUl);
      }
      li.appendChild(childUl);
    }
  }

  var rootTags = getTagChildren(null);
  sortByKey(rootTags, function(t) { return t[sortTags[0]]; }, isReverse);

  if(rootTags.length === 0 && Object.keys(tags).length === 0) {
    var elem = document.createElement('div');
    elem.className = 'list-group-item disabled';
    elem.textContent = gettext("There are no tags in this project yet.");
    tags_list.appendChild(elem);
  } else {
    for(var i = 0; i < rootTags.length; ++i) {
      renderTreeNode(rootTags[i], 0, tags_list);
    }
  }

  if(stickyPane) {
    stickyPane.scrollTop = prevPaneScroll;
  }
  window.scrollTo(0, prevWindowScroll);

  updateModalTagsList();

  var hl_entries = Object.entries(highlights);
  for(var i = 0; i < hl_entries.length; ++i) {
    setHighlight(hl_entries[i][1]);
  }
}

updateTagsList();

function updateTagCount(id, delta) {
  var tag = tags['' + id];
  if(tag) {
    tag.count += delta;
    var elem = document.getElementById('tag-' + id + '-count');
    if(elem) elem.textContent = tag.count;
  }
}

var tag_add_modal = document.getElementById('tag-add-modal');

$(tag_add_modal).on('shown.bs.modal', function() {
  document.getElementById('tag-add-path').focus();
});

$(tag_add_modal).on('hidden.bs.modal', function() {
  if($('#highlight-add-modal').hasClass('show')) {
    $('body').addClass('modal-open');
  }
});

function populateTagParentSelect(selectedParentId, disabledTagId) {
  var select = document.getElementById('tag-add-parent');
  select.innerHTML = '<option value="">' + gettext("(None - Root Tag)") + '</option>';

  var disabledIds = new Set();
  if(disabledTagId) {
    disabledIds.add(disabledTagId);
    var desc = getTagDescendants(disabledTagId);
    for(var d = 0; d < desc.length; ++d) {
      disabledIds.add(desc[d].id);
    }
  }

  function addOption(tag, prefix) {
    var opt = document.createElement('option');
    opt.value = tag.id;
    opt.textContent = prefix + tag.path;
    if(disabledIds.has(tag.id)) {
      opt.disabled = true;
    }
    if(selectedParentId && tag.id == selectedParentId) {
      opt.selected = true;
    }
    select.appendChild(opt);

    var children = getTagChildren(tag.id);
    sortByKey(children, function(c) { return c.path.toLowerCase(); }, false);
    for(var i = 0; i < children.length; ++i) {
      addOption(children[i], prefix + '— ');
    }
  }

  var roots = getTagChildren(null);
  sortByKey(roots, function(r) { return r.path.toLowerCase(); }, false);
  for(var r = 0; r < roots.length; ++r) {
    addOption(roots[r], '');
  }
}

function createTag() {
  document.getElementById('tag-add-form').reset();
  document.getElementById('tag-add-id').value = '';
  populateTagParentSelect(null, null);
  document.getElementById('tag-add-label-new').style.display = '';
  document.getElementById('tag-add-label-change').style.display = 'none';
  document.getElementById('tag-add-cancel').style.display = '';
  document.getElementById('tag-add-delete').style.display = 'none';
  document.getElementById('tag-add-merge').style.display = 'none';
  $(tag_add_modal).modal();
}

function createSubtag(parentId) {
  document.getElementById('tag-add-form').reset();
  document.getElementById('tag-add-id').value = '';
  populateTagParentSelect(parentId, null);
  document.getElementById('tag-add-label-new').style.display = '';
  document.getElementById('tag-add-label-change').style.display = 'none';
  document.getElementById('tag-add-cancel').style.display = '';
  document.getElementById('tag-add-delete').style.display = 'none';
  document.getElementById('tag-add-merge').style.display = 'none';
  $(tag_add_modal).modal();
}

function createTagInCurrentLevel() {
  createSubtag(highlightNavFolder);
}

function editTag(tag_id) {
  document.getElementById('tag-add-form').reset();
  var tag = tags['' + tag_id];
  document.getElementById('tag-add-id').value = '' + tag_id;
  document.getElementById('tag-add-path').value = tag.path;
  document.getElementById('tag-add-description').value = tag.description;
  populateTagParentSelect(tag.parent_id, tag.id);
  document.getElementById('tag-add-label-new').style.display = 'none';
  document.getElementById('tag-add-label-change').style.display = '';
  document.getElementById('tag-add-cancel').style.display = 'none';
  document.getElementById('tag-add-delete').style.display = '';
  document.getElementById('tag-add-merge').style.display = '';
  $(tag_add_modal).modal();
}

// Salvar tag
document.getElementById('tag-add-form').addEventListener('submit', function(e) {
  e.preventDefault();

  var tag_id = document.getElementById('tag-add-id').value;
  tag_id = tag_id ? parseInt(tag_id) : null;
  var tag_path = document.getElementById('tag-add-path').value.trim();
  if(!tag_path) {
    alert(gettext("Invalid tag name"));
    return;
  }
  if(tag_path.indexOf('|') !== -1) {
    alert(gettext("O caractere '|' não é permitido no nome da tag."));
    return;
  }
  var parent_val = document.getElementById('tag-add-parent').value;
  var parent_id = parent_val ? parseInt(parent_val) : null;
  var description = document.getElementById('tag-add-description').value;

  // Se o pai foi alterado e a tag possui descendentes, abre confirmação de reorganização Antes/Depois
  if(tag_id !== null) {
    var oldTag = tags['' + tag_id];
    var oldParentId = oldTag.parent_id ? parseInt(oldTag.parent_id) : null;
    var descendants = getTagDescendants(tag_id);

    if(oldParentId !== parent_id && descendants.length > 0) {
      pendingReparentData = {
        id: tag_id,
        path: tag_path,
        parent_id: parent_id,
        description: description
      };
      showReparentConfirmModal(tag_id, oldParentId, parent_id, descendants);
      return;
    }
  }

  executeSaveTag(tag_id, tag_path, parent_id, description);
});

function executeSaveTag(tag_id, tag_path, parent_id, description) {
  var payload = {
    path: tag_path,
    parent_id: parent_id,
    description: description
  };
  var req = tag_id !== null
    ? postJSON('/api/project/' + project_id + '/tag/' + tag_id, payload)
    : postJSON('/api/project/' + project_id + '/tag/new', payload);

  showSpinner();
  req.then(function(reply) {
    if(parent_id && !expandedTagNodes.has(parent_id)) {
      expandedTagNodes.add(parent_id);
    }
    last_added_tag = reply.id;
    if(tags[reply.id] || reply.id) {
      toggleHighlightSelectedTag(reply.id, true);
    }
    $(tag_add_modal).modal('hide');
    document.getElementById('tag-add-form').reset();
  })
  .catch(function(error) {
    console.error("Failed to save tag:", error);
    alert(gettext("Erro ao salvar tag!") + "\n\n" + error);
  })
  .then(hideSpinner);
}

function showReparentConfirmModal(tag_id, oldParentId, newParentId, descendants) {
  var tag = tags['' + tag_id];
  document.getElementById('reparent-tag-name').textContent = tag.path;

  var oldParentName = oldParentId && tags['' + oldParentId] ? tags['' + oldParentId].path : gettext("Raiz do Projeto");
  var newParentName = newParentId && tags['' + newParentId] ? tags['' + newParentId].path : gettext("Raiz do Projeto");

  var beforeHtml = '<div>📁 <strong>' + escapeHtml(oldParentName) + '</strong></div>' +
                   '<div style="padding-left:16px;">└─ 🏷️ <strong>' + escapeHtml(tag.path) + '</strong>';
  for(var i = 0; i < descendants.length; ++i) {
    beforeHtml += '<div style="padding-left:16px;">└─ 🏷️ ' + escapeHtml(descendants[i].path) + '</div>';
  }
  beforeHtml += '</div>';
  document.getElementById('reparent-preview-before').innerHTML = beforeHtml;

  var afterHtml = '<div>📁 <strong>' + escapeHtml(newParentName) + '</strong></div>' +
                  '<div style="padding-left:16px;">└─ 🏷️ <strong class="text-primary">' + escapeHtml(tag.path) + '</strong>';
  for(var j = 0; j < descendants.length; ++j) {
    afterHtml += '<div style="padding-left:16px;">└─ 🏷️ ' + escapeHtml(descendants[j].path) + '</div>';
  }
  afterHtml += '</div>';
  document.getElementById('reparent-preview-after').innerHTML = afterHtml;

  $(tag_add_modal).modal('hide');
  $('#tag-reparent-confirm-modal').modal();
}

document.getElementById('btn-reparent-confirm').addEventListener('click', function() {
  if(!pendingReparentData) return;
  $('#tag-reparent-confirm-modal').modal('hide');
  executeSaveTag(
    pendingReparentData.id,
    pendingReparentData.path,
    pendingReparentData.parent_id,
    pendingReparentData.description
  );
  pendingReparentData = null;
});

// Exclusão de tag
document.getElementById('tag-add-delete').addEventListener('click', function(e) {
  var tag_id = document.getElementById('tag-add-id').value;
  if(!tag_id) return;
  tag_id = parseInt(tag_id);
  var tag = tags['' + tag_id];
  var descendants = getTagDescendants(tag_id);

  if(descendants.length > 0) {
    document.getElementById('tag-delete-confirm-name').textContent = tag.path;
    document.getElementById('tag-delete-children-count').textContent = descendants.length;
    $(tag_add_modal).modal('hide');
    $('#tag-delete-confirm-modal').modal();
  } else {
    if(!window.confirm(gettext("Are you sure you want to delete the tag '%(tag)s'?", {tag: tag.path}))) {
      return;
    }
    executeDeleteTag(tag_id, 'promote');
  }
});

function executeDeleteTag(tag_id, action) {
  showSpinner();
  deleteURL('/api/project/' + project_id + '/tag/' + tag_id + '?action=' + action)
  .then(function() {
    $(tag_add_modal).modal('hide');
    $('#tag-delete-confirm-modal').modal('hide');
    document.getElementById('tag-add-form').reset();
  })
  .catch(function(error) {
    console.error("Failed to delete tag:", error);
    alert(gettext("Couldn't delete tag!") + "\n\n" + error);
  })
  .then(hideSpinner);
}

document.getElementById('btn-delete-promote').addEventListener('click', function() {
  var tag_id = parseInt(document.getElementById('tag-add-id').value);
  executeDeleteTag(tag_id, 'promote');
});

document.getElementById('btn-delete-cascade').addEventListener('click', function() {
  var tag_id = parseInt(document.getElementById('tag-add-id').value);
  executeDeleteTag(tag_id, 'cascade');
});

// Botão de merge no modal de edição
document.getElementById('tag-add-merge').addEventListener('click', function(e) {
  e.preventDefault();

  var tag_id = document.getElementById('tag-add-id').value;
  if(!tag_id) return;
  tag_id = parseInt(tag_id);

  document.getElementById('tag-merge-form').reset();
  document.getElementById('tag-merge-src-id').value = '' + tag_id;
  document.getElementById('tag-merge-src-name').value = tags['' + tag_id].path;

  var target = document.getElementById('tag-merge-dest');
  target.innerHTML = '';

  var entries = Object.entries(tags);
  sortByKey(entries, function(e) { return e[1].path.toLowerCase(); }, false);
  for(var i = 0; i < entries.length; ++i) {
    if(entries[i][0] == '' + tag_id) {
      continue;
    }
    var option = document.createElement('option');
    option.setAttribute('value', entries[i][0]);
    option.innerText = getTagFullPath(entries[i][0]);
    target.appendChild(option);
  }

  $(tag_add_modal).modal('hide');
  $(document.getElementById('tag-merge-modal')).modal();
});

// Submissão de merge
document.getElementById('tag-merge-form').addEventListener('submit', function(e) {
  e.preventDefault();

  var tag_src = document.getElementById('tag-merge-src-id').value;
  if(!tag_src) return;
  tag_src = parseInt(tag_src);

  var tag_dest = document.getElementById('tag-merge-dest').value;
  if(!tag_dest) return;
  tag_dest = parseInt(tag_dest);

  var preserve = document.getElementById('tag-merge-preserve-description').checked;

  showSpinner();
  postJSON(
    '/api/project/' + project_id + '/tag/merge',
    {src: tag_src, dest: tag_dest, preserve_description: preserve}
  )
  .then(function() {
    $(document.getElementById('tag-merge-modal')).modal('hide');
  })
  .catch(function(error) {
    console.error("Failed to merge tags:", error);
    alert(gettext("Couldn't merge tags!") + "\n\n" + error);
  })
  .then(hideSpinner);
});


/*
 * Highlights
 */

// Add or replace a highlight
function setHighlight(highlight) {
  var id = '' + highlight.id;
  if(highlights[id]) {
    removeHighlight(id);
  }
  highlights[id] = highlight;
  var tag_names = highlight.tags.map(function(id) { return tags[id].path; });
  sortByKey(tag_names, function(path) { return path; });
  tag_names = tag_names.join(", ");
  try {
    highlightSelection([highlight.start_offset, highlight.end_offset], id, editHighlight, tag_names);
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

// Backlight
var backlight_checkbox = document.getElementById('backlight');
backlight_checkbox.addEventListener('change', function() {
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
  var hlinfo = document.getElementById('hlinfo');
  if(current_selection !== null) {
    var current_range = window.getSelection().getRangeAt(0);
    if(current_range.toString().match(onlyWhitespace)) {
      hlinfo.style.display = 'none';
    } else if(current_range.endOffset > 0) {
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
    hlinfo.style.display = 'none';
  }
}
document.addEventListener('selectionchange', selectionChanged);

function renderHighlightSelectedChips() {
  var container = document.getElementById('highlight-selected-tags-container');
  var bar = document.getElementById('highlight-selected-tags-bar');
  if(!container || !bar) return;
  bar.innerHTML = '';

  var ids = Object.keys(highlightSelectedTags);
  if(ids.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';

  for(var i = 0; i < ids.length; ++i) {
    var tagId = ids[i];
    var item = highlightSelectedTags[tagId];
    var tag = item.tag;
    var isExcluded = item.excluded;

    var chip = document.createElement('span');
    chip.className = isExcluded ? 'badge badge-danger p-2 mr-1 mb-1' : 'badge badge-primary p-2 mr-1 mb-1';
    chip.style.cursor = 'pointer';
    chip.style.userSelect = 'none';
    chip.style.transition = 'all 0.15s ease';
    chip.setAttribute('data-tag-id', tagId);
    chip.title = gettext("1 clique: desmarcar/recuperar | Duplo clique: navegar até pasta");

    if(isExcluded) {
      chip.style.textDecoration = 'line-through';
      chip.style.opacity = '0.75';
      chip.innerHTML = '<span class="mr-1"><s>' + escapeHtml(tag.path) + '</s></span> <i class="fa fa-undo" title="Recuperar"></i>';
    } else {
      chip.innerHTML = '<span class="mr-1">' + escapeHtml(tag.path) + '</span> <i class="fa fa-times-circle" title="Desmarcar"></i>';
    }

    // 1 clique: desmarca ou recupera a tag sem fechar o modal
    chip.addEventListener('click', (function(id) {
      return function(e) {
        e.preventDefault();
        highlightSelectedTags[id].excluded = !highlightSelectedTags[id].excluded;
        var cb = document.getElementById('highlight-add-tags-' + id);
        if(cb) {
          cb.checked = !highlightSelectedTags[id].excluded;
        }
        renderHighlightSelectedChips();
      };
    })(tagId));

    // 2 cliques: salta para a pasta da tag e exibe seus irmãos
    chip.addEventListener('dblclick', (function(itemTag) {
      return function(e) {
        e.preventDefault();
        highlightNavFolder = itemTag.parent_id ? itemTag.parent_id : null;
        document.getElementById('highlight-search').value = '';
        updateModalTagsList();
      };
    })(tag));

    bar.appendChild(chip);
  }

  // Rolagem suave
  bar.scrollLeft = bar.scrollWidth;
}

function toggleHighlightSelectedTag(tagId, isChecked) {
  var tag = tags['' + tagId];
  if(!tag) return;
  if(isChecked) {
    highlightSelectedTags[tagId] = { tag: tag, excluded: false };
  } else {
    delete highlightSelectedTags[tagId];
  }
  renderHighlightSelectedChips();
}

function updateModalBreadcrumbs() {
  var nav = document.getElementById('highlight-breadcrumbs-nav');
  var ol = document.getElementById('highlight-breadcrumbs');
  if(!nav || !ol) return;
  ol.innerHTML = '';

  if(highlightNavFolder === null) {
    nav.style.display = 'none';
    var labelElem = document.getElementById('highlight-contextual-label');
    if(labelElem) labelElem.textContent = gettext("Create a tag");
    var indElem = document.getElementById('highlight-level-indicator');
    if(indElem) indElem.textContent = gettext("Nível: Raiz");
    return;
  }

  nav.style.display = 'block';
  var trail = [];
  var curr = tags['' + highlightNavFolder];
  var visited = {};
  while(curr && !visited[curr.id]) {
    visited[curr.id] = true;
    trail.unshift(curr);
    curr = curr.parent_id && tags['' + curr.parent_id] ? tags['' + curr.parent_id] : null;
  }

  var rootLi = document.createElement('li');
  rootLi.className = 'breadcrumb-item';
  rootLi.innerHTML = '<a href="javascript:void(0)" class="text-primary"><i class="fa fa-folder-open"></i> Raiz</a>';
  rootLi.addEventListener('click', function() {
    highlightNavFolder = null;
    document.getElementById('highlight-search').value = '';
    updateModalTagsList();
  });
  ol.appendChild(rootLi);

  for(var i = 0; i < trail.length; ++i) {
    var t = trail[i];
    var li = document.createElement('li');
    if(i === trail.length - 1) {
      li.className = 'breadcrumb-item active font-weight-bold text-dark';
      li.textContent = t.path;
      var labelElem = document.getElementById('highlight-contextual-label');
      if(labelElem) labelElem.textContent = gettext("Create a subtag in '%(folder)s'", {folder: t.path});
      var indElem = document.getElementById('highlight-level-indicator');
      if(indElem) indElem.textContent = gettext("Pasta: ") + t.path;
    } else {
      li.className = 'breadcrumb-item';
      li.innerHTML = '<a href="javascript:void(0)" class="text-primary">' + escapeHtml(t.path) + '</a>';
      li.addEventListener('click', (function(folderId) {
        return function() {
          highlightNavFolder = folderId;
          document.getElementById('highlight-search').value = '';
          updateModalTagsList();
        };
      })(t.id));
    }
    ol.appendChild(li);
  }
}

function updateModalTagsList() {
  updateModalBreadcrumbs();
  renderHighlightSelectedChips();

  if(!tags_modal_list) return;

  while(tags_modal_list.firstChild) {
    tags_modal_list.removeChild(tags_modal_list.firstChild);
  }

  var searchFor = document.getElementById('highlight-search').value.toLowerCase().trim();
  var entries = Object.entries(tags);

  if(searchFor.length > 0) {
    var matches = [];
    for(var i = 0; i < entries.length; ++i) {
      var tag = entries[i][1];
      var full = getTagFullPath(tag.id);
      if(tag.path.toLowerCase().indexOf(searchFor) > -1 || full.toLowerCase().indexOf(searchFor) > -1) {
        matches.push(tag);
      }
    }
    sortByKey(matches, function(m) { return m.path.toLowerCase(); }, false);

    if(matches.length === 0) {
      var emptyLi = document.createElement('li');
      emptyLi.className = 'text-muted small py-2';
      emptyLi.textContent = gettext("Nenhuma tag encontrada para '%(query)s'", {query: searchFor});
      tags_modal_list.appendChild(emptyLi);
      return;
    }

    for(var m = 0; m < matches.length; ++m) {
      var matchTag = matches[m];
      var isChecked = highlightSelectedTags[matchTag.id] && !highlightSelectedTags[matchTag.id].excluded;
      var matchChildren = getTagChildren(matchTag.id);

      var li = document.createElement('li');
      li.className = 'tag-name form-check py-1 border-bottom d-flex align-items-center justify-content-between';

      var leftDiv = document.createElement('div');
      leftDiv.className = 'd-flex align-items-center flex-grow-1 text-truncate';
      leftDiv.innerHTML =
        '<input type="checkbox" class="form-check-input" value="' + matchTag.id + '" name="highlight-add-tags" id="highlight-add-tags-' + matchTag.id + '" ' + (isChecked ? 'checked' : '') + ' />' +
        '<label for="highlight-add-tags-' + matchTag.id + '" class="form-check-label text-truncate mb-0 ml-1">' +
        '  <span><strong>' + escapeHtml(matchTag.path) + '</strong> <small class="text-muted ml-1">(' + escapeHtml(getTagFullPath(matchTag.id)) + ')</small></span>' +
        '</label>';

      (function(t) {
        var cb = leftDiv.querySelector('input');
        cb.addEventListener('change', function() {
          toggleHighlightSelectedTag(t.id, this.checked);
        });
      })(matchTag);

      li.appendChild(leftDiv);

      var actionsDiv = document.createElement('div');
      actionsDiv.className = 'd-flex align-items-center flex-shrink-0 ml-2';

      var addSubBtn = document.createElement('button');
      addSubBtn.type = 'button';
      addSubBtn.className = 'btn btn-xs btn-outline-success py-0 px-2 mr-1';
      addSubBtn.title = gettext("Criar subtag nesta categoria");
      addSubBtn.innerHTML = '<i class="fa fa-plus"></i>';
      (function(tid) {
        addSubBtn.addEventListener('click', function(e) {
          e.preventDefault();
          createSubtag(tid);
        });
      })(matchTag.id);
      actionsDiv.appendChild(addSubBtn);

      var folderBtn = document.createElement('button');
      folderBtn.type = 'button';
      folderBtn.className = matchChildren.length > 0
        ? 'btn btn-sm btn-outline-info py-0 px-2'
        : 'btn btn-sm btn-outline-secondary py-0 px-2';
      folderBtn.innerHTML = matchChildren.length > 0
        ? '<i class="fa fa-folder-open"></i> ' + matchChildren.length + ' subtags'
        : '<i class="fa fa-folder"></i> 0 subtags';
      folderBtn.title = matchChildren.length > 0
        ? gettext("Entrar na pasta de subtags")
        : gettext("Entrar na pasta desta tag (vazia)");
      (function(folderId) {
        folderBtn.addEventListener('click', function(e) {
          e.preventDefault();
          highlightNavFolder = folderId;
          document.getElementById('highlight-search').value = '';
          updateModalTagsList();
        });
      })(matchTag.id);
      actionsDiv.appendChild(folderBtn);

      li.appendChild(actionsDiv);
      tags_modal_list.appendChild(li);
    }
    return;
  }

  var currentLevelTags = getTagChildren(highlightNavFolder);
  sortByKey(currentLevelTags, function(t) { return t.path.toLowerCase(); }, false);

  if(currentLevelTags.length === 0) {
    var liEmpty = document.createElement('li');
    liEmpty.className = 'text-muted small py-2';
    liEmpty.textContent = highlightNavFolder === null
      ? gettext("Não há tags cadastradas no projeto ainda.")
      : gettext("Esta categoria não possui subtags.");
    tags_modal_list.appendChild(liEmpty);
    return;
  }

  for(var c = 0; c < currentLevelTags.length; ++c) {
    var tagItem = currentLevelTags[c];
    var children = getTagChildren(tagItem.id);
    var isTagChecked = highlightSelectedTags[tagItem.id] && !highlightSelectedTags[tagItem.id].excluded;

    var rowLi = document.createElement('li');
    rowLi.className = 'tag-name form-check py-1 border-bottom d-flex align-items-center justify-content-between';

    var leftDiv = document.createElement('div');
    leftDiv.className = 'd-flex align-items-center flex-grow-1 text-truncate';
    leftDiv.innerHTML =
      '<input type="checkbox" class="form-check-input" value="' + tagItem.id + '" name="highlight-add-tags" id="highlight-add-tags-' + tagItem.id + '" ' + (isTagChecked ? 'checked' : '') + ' />' +
      '<label for="highlight-add-tags-' + tagItem.id + '" class="form-check-label text-truncate mb-0 ml-1" title="' + (tagItem.description || '') + '">' +
      '  <strong>' + escapeHtml(tagItem.path) + '</strong>' +
      '</label>';

    (function(t) {
      var chk = leftDiv.querySelector('input');
      chk.addEventListener('change', function() {
        toggleHighlightSelectedTag(t.id, this.checked);
      });
    })(tagItem);

    rowLi.appendChild(leftDiv);

    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'd-flex align-items-center flex-shrink-0 ml-2';

    var addSubBtn = document.createElement('button');
    addSubBtn.type = 'button';
    addSubBtn.className = 'btn btn-xs btn-outline-success py-0 px-2 mr-1';
    addSubBtn.title = gettext("Criar subtag nesta categoria");
    addSubBtn.innerHTML = '<i class="fa fa-plus"></i>';
    (function(tid) {
      addSubBtn.addEventListener('click', function(e) {
        e.preventDefault();
        createSubtag(tid);
      });
    })(tagItem.id);
    actionsDiv.appendChild(addSubBtn);

    var folderBtn = document.createElement('button');
    folderBtn.type = 'button';
    folderBtn.className = children.length > 0
      ? 'btn btn-sm btn-outline-info py-0 px-2'
      : 'btn btn-sm btn-outline-secondary py-0 px-2';
    folderBtn.innerHTML = children.length > 0
      ? '<i class="fa fa-folder-open"></i> ' + children.length + ' subtags'
      : '<i class="fa fa-folder"></i> 0 subtags';
    folderBtn.title = children.length > 0
      ? gettext("Entrar na pasta de subtags")
      : gettext("Entrar na pasta desta tag (vazia)");
    (function(folderId) {
      folderBtn.addEventListener('click', function(e) {
        e.preventDefault();
        highlightNavFolder = folderId;
        document.getElementById('highlight-search').value = '';
        updateModalTagsList();
      });
    })(tagItem.id);
    actionsDiv.appendChild(folderBtn);

    rowLi.appendChild(actionsDiv);
    tags_modal_list.appendChild(rowLi);
  }
}

var highlightSearch = document.getElementById('highlight-search');
if(highlightSearch) {
  highlightSearch.addEventListener('input', function() {
    updateModalTagsList();
  });
}

function highlightModalReset() {
  document.getElementById('highlight-add-form').reset();
  highlightNavFolder = null;
  highlightSelectedTags = {};
  if(highlightSearch) highlightSearch.value = '';
  updateModalTagsList();
}

function createHighlight(selection) {
  document.getElementById('highlight-add-id').value = '';
  document.getElementById('highlight-add-start').value = selection[0];
  document.getElementById('highlight-add-end').value = selection[1];
  highlightModalReset();
  $(highlight_add_modal).modal().drags({handle: '.modal-header'});
  document.getElementById('highlight-search').focus();
}

// TRANSLATORS: Key used to create a new highlight
var newtag_key = gettext('n');

document.addEventListener('keyup', function(e) {
  if(event.key == newtag_key && current_selection !== null) {
    createHighlight(current_selection);
  }
});

function editHighlight() {
  highlightModalReset();
  var id = this.getAttribute('data-highlight-id');
  document.getElementById('highlight-add-id').value = id;
  document.getElementById('highlight-add-start').value = highlights[id].start_offset;
  document.getElementById('highlight-add-end').value = highlights[id].end_offset;

  var hl_tags = highlights['' + id].tags;
  for(var i = 0; i < hl_tags.length; ++i) {
    var tid = hl_tags[i];
    if(tags['' + tid]) {
      highlightSelectedTags[tid] = { tag: tags['' + tid], excluded: false };
    }
  }

  updateModalTagsList();
  $(highlight_add_modal).modal().drags({handle: '.modal-header'});
  document.getElementById('highlight-search').focus();
}

// Salvar highlight salvando somente as tags marcadas (sem x)
document.getElementById('highlight-add-form').addEventListener('submit', function(e) {
  e.preventDefault();
  var highlight_id = document.getElementById('highlight-add-id').value;
  var selection = [
    parseInt(document.getElementById('highlight-add-start').value),
    parseInt(document.getElementById('highlight-add-end').value)
  ];

  var hl_tags = [];
  for(var id in highlightSelectedTags) {
    if(!highlightSelectedTags[id].excluded) {
      hl_tags.push(parseInt(id));
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
    highlightModalReset();
  })
  .catch(function(error) {
    console.error("Failed to save highlight:", error);
    alert(gettext("Não foi possível salvar o destaque!") + "\n\n" + error);
  })
  .then(hideSpinner);
});

// Delete highlight button
document.getElementById('highlight-delete').addEventListener('click', function() {
  var highlight_id = document.getElementById('highlight-add-id').value;
  if(highlight_id) {
    highlight_id = parseInt(highlight_id);
    console.log("Posting highlight " + highlight_id + " deletion");
    deleteURL(
      '/api/project/' + project_id + '/document/' + current_document + '/highlight/' + highlight_id
    )
    .then(function() {
      $(highlight_add_modal).modal('hide');
      highlightModalReset();
    })
    .catch(function(error) {
      console.error("Failed to delete highlight:", error);
      alert(gettext("Couldn't delete highlight!") + "\n\n" + error);
    });
  }
});


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

  elem.querySelector('button').addEventListener('click', function() {
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

function loadDocument(document_id) {
  if(document_id === null) {
    document_contents.style.direction = 'ltr';
    document_contents.innerHTML = '<p style="font-style: oblique; text-align: center;">' + gettext("Load a document on the left") + '</p>';
    return;
  }
  showSpinner();
  var info = getJSON(
    '/api/project/' + project_id + '/document/' + document_id
  );
  var contents = getJSON(
    '/api/project/' + project_id + '/document/' + document_id + '/contents'
  );
  Promise.all([info, contents])
  .then(function(results) {
    var info = results[0];
    var contents = results[1];
    document_contents.innerHTML = '';
    highlights = {};
    chunk_offsets = [];
    for(var i = 0; i < contents.contents.length; ++i) {
      var chunk = contents.contents[i];
      var elem = document.createElement('div');
      elem.setAttribute('id', 'doc-offset-' + chunk.offset);
      elem.innerHTML = chunk.contents;
      document_contents.appendChild(elem);
      chunk_offsets.push(chunk.offset);
    }
    if(info.text_direction === 'RIGHT_TO_LEFT') {
      document_contents.style.direction = 'rtl';
    } else {
      document_contents.style.direction = 'ltr';
    }
    current_document = document_id;

    // Update current document highlight in left panel
    var document_links = document.getElementsByClassName('document-link-current');
    for(var i = document_links.length - 1; i >= 0; --i) {
      document_links[i].classList.remove('document-link-current');
    }
    var document_link = document.getElementById('document-link-' + current_document);
    if(document_link) {
      document_link.classList.add('document-link-current');
    }

    current_tag = null;
    var tag_links = document.getElementsByClassName('tag-current');
    for(var i = tag_links.length - 1; i >= 0; --i) {
      tag_links[i].classList.remove('tag-current');
    }
    console.log("Loaded document", document_id);
    for(var i = 0; i < info.highlights.length; ++i) {
      setHighlight(info.highlights[i]);
    }
    console.log("Loaded " + info.highlights.length + " highlights");

    // Update export button
    export_button.style.display = '';
    var btnExport = document.getElementById('dropdown-export');
    if(btnExport) {
      btnExport.innerText = gettext("Export document");
    }
    var btnConfigHighlights = document.getElementById('btn-open-export-highlights-modal');
    if(btnConfigHighlights) btnConfigHighlights.style.display = 'none';
    var divConfigHighlights = document.getElementById('dropdown-export-divider');
    if(divConfigHighlights) divConfigHighlights.style.display = 'none';

    var items = export_button.getElementsByClassName('dropdown-item');
    for(var i = 0; i < items.length; ++i) {
      if(items[i].id === 'btn-open-export-highlights-modal') continue;
      var ext = items[i].getAttribute('data-extension');
      if(items[i].getAttribute('data-document') !== 'false') {
        items[i].setAttribute(
          'href',
          base_path + '/project/' + project_id + '/export/document/' + document_id + '.' + ext,
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
    console.error("Failed to load document:", error);
    alert(gettext("Error loading document!") + "\n\n" + error);
  })
  .then(hideSpinner);
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
    document_contents.style.direction = 'ltr';
    current_tag = tag_path;
    current_document = null;
    var document_links = document.getElementsByClassName('document-link-current');
    for(var i = document_links.length - 1; i >= 0; --i) {
      document_links[i].classList.remove('document-link-current');
    }
    // No need to clear the 'tag-current', we are calling updateTagsList() below
    document_contents.innerHTML = '';

    // Encontra o objeto da tag atual se for visualização de uma tag específica
    var currentTagObj = null;
    if(tag_path) {
      for(var tid in tags) {
        if(tags[tid].path === tag_path || getTagFullPath(tags[tid].id) === tag_path) {
          currentTagObj = tags[tid];
          break;
        }
      }
    }

    if(currentTagObj) {
      var headerDiv = document.createElement('div');
      headerDiv.className = 'card mb-3 border-info';
      var headerBody = document.createElement('div');
      headerBody.className = 'card-body py-2 px-3';

      var titleH5 = document.createElement('h5');
      titleH5.className = 'card-title mb-1 text-info';
      titleH5.innerHTML = '<i class="fa fa-tag mr-1"></i> ' + escapeHtml(currentTagObj.path);

      var fullPathSmall = document.createElement('div');
      fullPathSmall.className = 'text-muted small mb-2';
      fullPathSmall.textContent = getTagFullPath(currentTagObj.id);
      headerBody.appendChild(titleH5);
      headerBody.appendChild(fullPathSmall);

      if(currentTagObj.description) {
        var descP = document.createElement('p');
        descP.className = 'card-text small mb-2 text-secondary';
        descP.textContent = currentTagObj.description;
        headerBody.appendChild(descP);
      }

      var subChildren = getTagChildren(currentTagObj.id);
      if(subChildren.length > 0) {
        var subDiv = document.createElement('div');
        subDiv.className = 'mt-2 pt-2 border-top';
        var subLabel = document.createElement('strong');
        subLabel.className = 'small text-muted d-block mb-1';
        subLabel.textContent = gettext("Subtags:") + " ";
        subDiv.appendChild(subLabel);

        sortByKey(subChildren, function(c) { return c.path.toLowerCase(); }, false);
        for(var s = 0; s < subChildren.length; ++s) {
          var ch = subChildren[s];
          var chLink = document.createElement('a');
          chLink.className = 'badge badge-info p-2 mr-1 mb-1';
          chLink.style.fontSize = '0.85rem';
          chLink.style.cursor = 'pointer';
          chLink.innerHTML = '<i class="fa fa-folder-open-o mr-1"></i>' + escapeHtml(ch.path) + ' <span class="badge badge-light ml-1">' + (ch.count || 0) + '</span>';
          (function(childTag) {
            chLink.addEventListener('click', function(e) {
              e.preventDefault();
              var url = base_path + '/project/' + project_id + '/highlights/' + encodeURIComponent(childTag.path);
              window.history.pushState({tag_path: childTag.path}, "Tag " + childTag.path, url);
              loadTag(childTag.path);
            });
          })(ch);
          subDiv.appendChild(chLink);
        }
        headerBody.appendChild(subDiv);
      }

      headerDiv.appendChild(headerBody);
      document_contents.appendChild(headerDiv);
    }

    highlights = {};
    for(var i = 0; i < result.highlights.length; ++i) {
      var hl = result.highlights[i];
      var content = document.createElement('div');
      if(hl.text_direction === 'RIGHT_TO_LEFT') {
        content.style.direction = 'rtl';
      } else {
        content.style.direction = 'ltr';
      }
      content.innerHTML = result.highlights[i].content;
      var elem = document.createElement('div');
      elem.className = 'highlight-entry';
      elem.setAttribute('id', 'highlight-entry-' + hl.id);
      elem.appendChild(content);
      elem.appendChild(document.createTextNode(' '));

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
      var emptyP = document.createElement('p');
      emptyP.style.fontStyle = 'oblique';
      emptyP.style.textAlign = 'center';
      emptyP.textContent = gettext("No highlights with this tag yet.");
      document_contents.appendChild(emptyP);
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

    // Update export button
    export_button.style.display = '';
    var btnExport = document.getElementById('dropdown-export');
    if(btnExport) {
      btnExport.innerText = gettext("Export highlights");
    }
    var btnConfigHighlights = document.getElementById('btn-open-export-highlights-modal');
    if(btnConfigHighlights) btnConfigHighlights.style.display = '';
    var divConfigHighlights = document.getElementById('dropdown-export-divider');
    if(divConfigHighlights) divConfigHighlights.style.display = '';

    var items = export_button.getElementsByClassName('dropdown-item');
    for(var i = 0; i < items.length; ++i) {
      if(items[i].id === 'btn-open-export-highlights-modal') continue;
      var ext = items[i].getAttribute('data-extension');
      if(items[i].getAttribute('data-highlights') !== 'false') {
        items[i].setAttribute(
          'href',
          base_path + '/project/' + project_id + '/export/highlights/' + encodeURIComponent(tag_path) + '.' + ext,
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
    var _document_url = new RegExp('^' + escapeRegExp(base_path) + '/project/([0-9]+)/document/([0-9]+)');
    // Don't use RegExp literals https://github.com/python-babel/babel/issues/640
    var m = window.location.pathname.match(_document_url);
    if(m) {
      loadDocument(parseInt(m[2]));
    }
    // Or a tag
    var _tag_url = new RegExp('^' + escapeRegExp(base_path) + '/project/([0-9]+)/highlights/([^/]*)');
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
    {version: version, from: last_event}
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
          description: event.description,
          text_direction: event.text_direction
        });
      } else if(event.type === 'document_delete') {
        removeDocument(event.document_id);
      } else if(event.type === 'highlight_add') {
        if(event.document_id === current_document) {
          setHighlight({
            id: event.highlight_id,
            start_offset: event.start_offset,
            end_offset: event.end_offset,
            tags: event.tags
          });
        }
      } else if(event.type === 'highlight_delete') {
        removeHighlight(event.highlight_id);
      } else if(event.type === 'tag_add') {
        addTag({
          id: event.tag_id,
          path: event.tag_path,
          parent_id: event.parent_id,
          description: event.description
        });
      } else if(event.type === 'tag_delete') {
        removeTag(event.tag_id);
      } else if(event.type === 'tag_merge') {
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

