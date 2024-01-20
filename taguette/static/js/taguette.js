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
 * Project metadata
 */

var project_name_input = document.getElementById('project-name');
var project_name = project_name_input.value;

var project_description_input = document.getElementById('project-description');
var project_description = project_description_input.value;

function setProjectMetadata(metadata, form = true) {
    if (project_name == metadata.project_name
        && project_description == metadata.description) {
        return;
    }
    // Update globals
    project_name = metadata.project_name;
    project_description = metadata.description;
    // Update form
    if (form) {
        project_name_input.value = project_name;
        project_description_input.value = project_description;
    }
    // Update elements
    var elems = document.getElementsByClassName('project-name');
    for (var i = 0; i < elems.length; ++i) {
        elems[i].textContent = project_name;
    }
    console.log("Project metadata updated");
}

function projectMetadataChanged() {
    if (project_name_input.value != project_name
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
            .then(function () {
                setProjectMetadata(meta, false);
            })
            .catch(function (error) {
                console.error("Failed to update project metadata:", error);
                alert(gettext("Couldn't update project metadata!") + "\n\n" + error);
                project_name_input.value = project_name;
                project_description_input.value = project_description;
            });
    }
}

document.getElementById('project-metadata-form').addEventListener('submit', function (e) {
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
    elem.addEventListener('click', function (e) {
        e.preventDefault();
        window.history.pushState({document_id: doc_id}, "Document " + doc_id, url);
        loadDocument(doc_id);
    });
}

function updateDocumentsList() {
    // Empty the list
    while (documents_list.firstChild) {
        var first = documents_list.firstChild;
        if (first.classList
            && first.classList.contains('special-item-button')) {
            break;
        }
        documents_list.removeChild(first);
    }

    // Fill up the list again
    var before = documents_list.firstChild;
    var entries = Object.entries(documents);
    sortByKey(entries, function (e) {
        return e[1].name;
    });
    for (var i = 0; i < entries.length; ++i) {
        var doc = entries[i][1];
        var elem = document.createElement('li');
        elem.setAttribute('id', 'document-link-' + doc.id);
        elem.className = 'list-group-item document-link';
        if (doc.id === current_document) {
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
    if (entries.length == 0) {
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
    if (document.id === current_document) {
        // Text direction is the only meaningful thing that can be mutated
        if (document.text_direction === 'RIGHT_TO_LEFT') {
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
    if (current_document == document_id) {
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
    $(document_add_modal).modal('show');
}

function basename(filename) {
    if (filename) {
        var idx = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
        if (idx > -1) {
            filename = filename.substring(idx + 1);
        }
    }
    return filename;
}

document.getElementById('document-add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    console.log("Uploading document...");

    var form_data = new FormData();
    var name = document.getElementById('document-add-name').value;
    if (!name) {
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
    xhr.onload = function () {
        if (xhr.status == 200) {
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
            } catch (e) {
            }
            if (!error) {
                error = "Status " + xhr.status;
            }
            alert(gettext("Error uploading file!") + "\n\n" + error);
        }
        hideSpinner();
    };
    xhr.onerror = function (e) {
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
    $(document_change_modal).modal('show');
}

document.getElementById('document-change-form').addEventListener('submit', function (e) {
    e.preventDefault();
    console.log("Changing document...");

    var update = {
        name: document.getElementById('document-change-name').value,
        description: document.getElementById('document-change-description').value,
        text_direction: document.getElementById('document-change-form').elements['document-change-direction'].value
    };
    if (!update.name || update.name.length == 0) {
        alert(gettext("Document name cannot be empty"));
        return;
    }

    var doc_id = document.getElementById('document-change-id').value;
    showSpinner();
    postJSON(
        '/api/project/' + project_id + '/document/' + doc_id,
        update
    )
        .then(function () {
            console.log("Document update posted");
            $(document_change_modal).modal('hide');
            document.getElementById('document-change-form').reset();
        })
        .catch(function (error) {
            console.error("Failed to update document:", error);
            alert(gettext("Couldn't update document!") + "\n\n" + error);
        })
        .then(hideSpinner);
});

document.getElementById('document-change-delete').addEventListener('click', function (e) {
    e.preventDefault();

    var doc_id = document.getElementById('document-change-id').value;
    if (!window.confirm(gettext("Are you sure you want to delete the document '%(doc)s'?", {doc: documents[doc_id].name}))) {
        return;
    }
    console.log("Deleting document " + doc_id + "...");
    deleteURL('/api/project/' + project_id + '/document/' + doc_id)
        .then(function () {
            console.log("Document deletion posted");
            $(document_change_modal).modal('hide');
            document.getElementById('document-change-form').reset();
        })
        .catch(function (error) {
            console.error("Failed to delete document:", error);
            alert(gettext("Couldn't delete document!") + "\n\n" + error);
        });
});


/*
 * Tags list
 */

var tags_sorter = document.getElementById('tag-sortby');
var sortTags = ['path', 'asc'];
var tags_list = document.getElementById('tags-list');

function sortTagsBy(field, dir) {
    sortTags = [field, dir];
    var options = document.getElementById('tag-sortby-menu').querySelectorAll('a.dropdown-item');
    var optionSorts = [
        ['path', 'asc'],
        ['path', 'desc'],
        ['count', 'asc'],
        ['count', 'desc'],
    ];
    for (var i = 0; i < optionSorts.length; ++i) {
        if (optionSorts[i][0] === field && optionSorts[i][1] === dir) {
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
    elem.addEventListener('click', function (e) {
        e.preventDefault();
        window.history.pushState({tag_path: tag_path}, "Tag " + tag_path, url);
        loadTag(tag_path);
    });
}

linkTag(document.getElementById('load-all-tags'), '');

function highlightModalReset() {
    document.getElementById('highlight-add-form').reset();
    initTagsHighlightTreeview(false);
}


var tag_add_modal = document.getElementById('tag-add-modal');

$(tag_add_modal).on('shown.bs.modal', function () {
    document.getElementById('tag-add-path').focus();
});

function createTag() {
    document.getElementById('tag-add-form').reset();
    document.getElementById('tag-add-id').value = '';
    document.getElementById('tag-add-label-new').style.display = '';
    document.getElementById('tag-add-label-change').style.display = 'none';
    document.getElementById('tag-add-cancel').style.display = '';
    document.getElementById('tag-add-delete').style.display = 'none';
    document.getElementById('tag-add-merge').style.display = 'none';
    $(tag_add_modal).modal('show');
}

function editTag(tag_id) {
    if (tag_id === undefined && selected_tag_id === 0) {
        alert('Select un tag');
        return;
    }
    if (selected_tag_id > 0) {
        tag_id = selected_tag_id
    }
    const tag = findTag(tag_id);
    document.getElementById('tag-add-form').reset();
    document.getElementById('tag-add-id').value = '' + tag_id;
    if (tag.parent) {
        document.getElementById('tag-add-parent-id').value = tag.parent;
        document.getElementById('dropdownMenuButtonTag').innerText = findTag(tag.parent).path;
    }
    document.getElementById('tag-add-path').value = tag.path;
    document.getElementById('tag-add-description').value = tag.description;
    document.getElementById('tag-add-label-new').style.display = 'none';
    document.getElementById('tag-add-label-change').style.display = '';
    document.getElementById('tag-add-cancel').style.display = 'none';
    document.getElementById('tag-add-delete').style.display = '';
    document.getElementById('tag-add-merge').style.display = '';
    $(tag_add_modal).modal('show');
}

// Save tag button
document.getElementById('tag-add-form').addEventListener('submit', function (e) {
    e.preventDefault();

    let tag_id = document.getElementById('tag-add-id').value;
    if (tag_id) {
        tag_id = parseInt(tag_id);
    } else {
        tag_id = null;
    }
    var tag_path = document.getElementById('tag-add-path').value;
    if (!tag_path) {
        alert(gettext("Invalid tag name"));
        return;
    }

    var tag_parent_id = document.getElementById('tag-add-parent-id').value;
    if (tag_parent_id !== '') {
        tag_parent_id = parseInt(tag_parent_id);
    } else {
        tag_parent_id = null;
    }

    var req;
    if (tag_id) {
        console.log("Posting update for tag " + tag_id);
        req = postJSON(
            '/api/project/' + project_id + '/tag/' + tag_id,
            {
                path: tag_path,
                description: document.getElementById('tag-add-description').value, parent_id: tag_parent_id
            }
        );
    } else {
        console.log("Posting new tag");
        req = postJSON(
            '/api/project/' + project_id + '/tag/new',
            {
                path: tag_path,
                description: document.getElementById('tag-add-description').value, parent_id: tag_parent_id
            }
        );
    }
    showSpinner();
    req.then(function (reply) {
        console.log("Tag posted");

        last_added_tag = reply.id;

        $(tag_add_modal).modal('hide');
        document.getElementById('tag-add-form').reset();
        document.getElementById('dropdownMenuButtonTag').innerText = 'None';

    })
        .catch(function (error) {
            console.error("Failed to create tag:", error);
            alert(gettext("Couldn't create tag!") + "\n\n" + error);
        })
        .then(hideSpinner);
});

// Delete tag button
document.getElementById('tag-add-delete').addEventListener('click', function (e) {
    var tag_id = document.getElementById('tag-add-id').value;
    const tag = findTag(tag_id)
    if (tag_id) {
        if (!window.confirm(gettext("Are you sure you want to delete the tag '%(tag)s'?", {tag: tag.path}))) {
            e.preventDefault();
            return;
        }
        tag_id = parseInt(tag_id);
        console.log("Posting tag " + tag_id + " deletion");
        deleteURL(
            '/api/project/' + project_id + '/tag/' + tag_id
        )
            .then(function () {
                $(tag_add_modal).modal('hide');
                document.getElementById('tag-add-form').reset();
            })
            .catch(function (error) {
                console.error("Failed to delete tag:", error);
                alert(gettext("Couldn't delete tag!") + "\n\n" + error);
            });
    }
});

// Merge tags button in tag edit modal: shows merge modal
document.getElementById('tag-add-merge').addEventListener('click', function (e) {
    e.preventDefault();

    let tag_id = document.getElementById('tag-add-id').value;
    if (!tag_id)
        return;
    tag_id = parseInt(tag_id);
    const tag = findTag(tag_id)

    document.getElementById('tag-merge-form').reset();

    // Set source tag
    document.getElementById('tag-merge-src-id').value = '' + tag_id;
    document.getElementById('tag-merge-src-name').value = tag.path;

    $(document.getElementById('tag-merge-modal')).modal('show');
});

// Merge modal submit button
document.getElementById('tag-merge-form').addEventListener('submit', function (e) {
    e.preventDefault();

    let tag_src = document.getElementById('tag-merge-src-id').value;
    if (!tag_src)
        return;
    tag_src = parseInt(tag_src);

    let tag_dest = document.getElementById('tag-merge-dest').value;
    if (!tag_dest)
        return;
    tag_dest = parseInt(tag_dest);

    // Todo : add good text
    if (tag_src === tag_dest) {
        alert('Merge not possible')
        return
    }

    showSpinner();
    postJSON(
        '/api/project/' + project_id + '/tag/merge',
        {src: tag_src, dest: tag_dest}
    )
        .then(function () {
            console.log("Tag merge posted");
            $(document.getElementById('tag-merge-modal')).modal('hide');
        })
        .catch(function (error) {
            console.error("Failed to merge tags:", error);
            alert(gettext("Couldn't merge tags!") + "\n\n" + error);
        })
        .then(hideSpinner);
});


// Backlight
var backlight_checkbox = document.getElementById('backlight');
backlight_checkbox.addEventListener('change', function () {
    var classes = document.getElementById('document-view').classList;
    if (backlight_checkbox.checked == classes.contains('backlight')) {
        ; // all good
    } else if (backlight_checkbox.checked) {
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
    if (current_selection !== null) {
        var current_range = window.getSelection().getRangeAt(0);
        if (current_range.toString().match(onlyWhitespace)) {
            hlinfo.style.display = 'none';
        } else if (current_range.endOffset > 0) {
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

function createHighlight(selection) {
    document.getElementById('highlight-add-id').value = '';
    document.getElementById('highlight-add-start').value = selection[0];
    document.getElementById('highlight-add-end').value = selection[1];
    highlightModalReset();
    $(highlight_add_modal).modal('show').drags({handle: '.modal-header'});
    // document.getElementById('highlight-search').focus();
}

// TRANSLATORS: Key used to create a new highlight
var newtag_key = gettext('n');

document.addEventListener('keyup', function (e) {
    if (event.key == newtag_key && current_selection !== null) {
        createHighlight(current_selection);
    }
});

function editHighlight() {
    highlightModalReset();
    const id = this.getAttribute('data-highlight-id');
    document.getElementById('highlight-add-id').value = id;
    document.getElementById('highlight-add-start').value = highlights[id].start_offset;
    document.getElementById('highlight-add-end').value = highlights[id].end_offset;
    const hl_tags = highlights['' + id].tags;
    const allNodes = treeview_tags_highlight.treeview('getEnabled');
    for (let i = 0; i < hl_tags.length; ++i) {
        const node = allNodes.find((node) => node.id === hl_tags[i]);
        treeview_tags_highlight.treeview('selectNode', node.nodeId);
    }
    $(highlight_add_modal).modal('show').drags({handle: '.modal-header'});
    // document.getElementById('highlight-search').focus();
}

// Save highlight button
document.getElementById('highlight-add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var highlight_id = document.getElementById('highlight-add-id').value;
    var selection = [
        parseInt(document.getElementById('highlight-add-start').value),
        parseInt(document.getElementById('highlight-add-end').value)
    ];
    var hl_tags = [];
    var selectedTags = treeview_tags_highlight.treeview('getSelected');
    hl_tags = selectedTags.map((tag) => tag.id);
    var req;
    if (highlight_id) {
        console.log("Posting update for highlight " + highlight_id);
        req = postJSON(
            '/api/project/' + project_id + '/document/' + current_document + '/highlight/' + highlight_id,
            {
                start_offset: selection[0],
                end_offset: selection[1],
                tags: hl_tags
            }
        );
    } else {
        console.log("Posting new highlight");
        req = postJSON(
            '/api/project/' + project_id + '/document/' + current_document + '/highlight/new',
            {
                start_offset: selection[0],
                end_offset: selection[1],
                tags: hl_tags
            }
        );
    }
    showSpinner();
    req.then(function () {
        console.log("Highlight posted");
        $(highlight_add_modal).modal('hide');
        highlightModalReset();
    })
        .catch(function (error) {
            console.error("Failed to create highlight:", error);
            alert(gettext("Couldn't create highlight!") + "\n\n" + error);
        })
        .then(hideSpinner);
});

// Delete highlight button
document.getElementById('highlight-delete').addEventListener('click', function () {
    var highlight_id = document.getElementById('highlight-add-id').value;
    if (highlight_id) {
        highlight_id = parseInt(highlight_id);
        console.log("Posting highlight " + highlight_id + " deletion");
        deleteURL(
            '/api/project/' + project_id + '/document/' + current_document + '/highlight/' + highlight_id
        )
            .then(function () {
                $(highlight_add_modal).modal('hide');
                highlightModalReset();
            })
            .catch(function (error) {
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
        '  <select class="form-control"' + (can_edit ? '' : ' disabled') + '>' +
        '    <option value="ADMIN">' + gettext("Full permissions") + '</option>' +
        '    <option value="MANAGE_DOCS">' + gettext("Can't change collaborators / delete project") + '</option>' +
        '    <option value="TAG">' + gettext("View & make changes") + '</option>' +
        '    <option value="READ">' + gettext("View only") + '</option>' +
        '  </select>' +
        '</div>' +
        (is_self ?
                '<button type="button" class="btn btn-danger col-md-4 form-group">Leave project</button>'
                :
                '<button type="button" class="btn btn-danger col-md-4 form-group"' + (can_edit ? '' : ' disabled') + '>Remove collaborator</button>'
        );

    [].forEach.call(elem.querySelectorAll('option'), function (e) {
        if (e.value == user.privileges) {
            e.selected = true;
        }
    });

    elem.querySelector('button').addEventListener('click', function () {
        elem.parentNode.removeChild(elem);
        delete members_displayed[login];
    });

    return elem;
}

function showMembers() {
    document.getElementById('members-add').reset();

    can_edit = members[user_login].privileges == 'ADMIN';

    if (can_edit) {
        document.getElementById('members-add-fields').removeAttribute('disabled');
    } else {
        document.getElementById('members-add-fields').setAttribute('disabled', 1);
    }

    var entries = Object.entries(members);
    sortByKey(entries, function (e) {
        return e[0];
    });
    console.log(
        "Members:",
        entries.map(function (e) {
            return e[0] + " (" + e[1].privileges + ")";
        })
            .join(", ")
    );

    // Empty the list
    var current_members = document.getElementById('members-current');
    current_members.innerHTML = '';

    // Fill it back up
    for (var i = 0; i < entries.length; ++i) {
        var login = entries[i][0];
        var user = entries[i][1];
        var elem = _memberRow(login, user, can_edit, login == user_login);

        current_members.appendChild(elem);
    }

    // Store current state so that we can compare later
    members_initial = Object.assign({}, members);
    members_displayed = Object.assign({}, members);

    $(members_modal).modal('show');
}

document.getElementById('members-add').addEventListener('submit', function (e) {
    e.preventDefault();

    var login = document.getElementById('member-add-name').value.toLowerCase();
    if (!login) {
        return;
    }
    var privileges = document.getElementById('member-add-privileges').value;

    // Check login
    if (login in members_displayed) {
        alert(gettext("Already a member!"));
        document.getElementById('members-add').reset();
        return;
    }
    postJSON(
        '/api/check_user',
        {login: login}
    )
        .then(function (result) {
            if (result.exists) {
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
    for (var i = 0; i < rows.length; ++i) {
        var row = rows[i];
        var login = row.querySelector('.members-item-login').textContent;
        var privileges = row.querySelector('select').value;

        // Add to patch, if different from stored version
        if (!members_before[login] || members_before[login].privileges != privileges) {
            patch[login] = {privileges: privileges};
        }

        // Remove from object, so what's left are the removed members
        delete members_before[login];
    }

    // Remove the members that are left
    var entries = Object.entries(members_before);
    for (var i = 0; i < entries.length; ++i) {
        patch[entries[i][0]] = null;
    }

    console.log("Patching members list");
    showSpinner();
    patchJSON(
        '/api/project/' + project_id + '/members',
        patch
    )
        .then(function () {
            console.log("Members list patched");
            $(members_modal).modal('hide');
        })
        .catch(function (error) {
            console.error("Failed to patch members list:", error);
            alert(gettext("Couldn't update collaborators!") + "\n\n" + error);
        })
        .then(hideSpinner);

    members_initial = {};
}

document.getElementById('members-submit').addEventListener('click', function (e) {
    e.preventDefault();
    sendMembersPatch();
});

document.getElementById('members-current').addEventListener('submit', function (e) {
    e.preventDefault();
    sendMembersPatch();
});


/*
 * Load contents
 */

var document_contents = document.getElementById('document-contents');
var export_button = document.getElementById('export-button');

function loadDocument(document_id) {
    if (document_id === null) {
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
        .then(function (results) {
            var info = results[0];
            var contents = results[1];
            document_contents.innerHTML = '';
            highlights = {};
            chunk_offsets = [];
            for (var i = 0; i < contents.contents.length; ++i) {
                var chunk = contents.contents[i];
                var elem = document.createElement('div');
                elem.setAttribute('id', 'doc-offset-' + chunk.offset);
                elem.innerHTML = chunk.contents;
                document_contents.appendChild(elem);
                chunk_offsets.push(chunk.offset);
            }
            if (info.text_direction === 'RIGHT_TO_LEFT') {
                document_contents.style.direction = 'rtl';
            } else {
                document_contents.style.direction = 'ltr';
            }
            current_document = document_id;

            // Update current document highlight in left panel
            var document_links = document.getElementsByClassName('document-link-current');
            for (var i = document_links.length - 1; i >= 0; --i) {
                document_links[i].classList.remove('document-link-current');
            }
            var document_link = document.getElementById('document-link-' + current_document);
            if (document_link) {
                document_link.classList.add('document-link-current');
            }

            current_tag = null;
            var tag_links = document.getElementsByClassName('tag-current');
            for (var i = tag_links.length - 1; i >= 0; --i) {
                tag_links[i].classList.remove('tag-current');
            }
            console.log("Loaded document", document_id);
            for (var i = 0; i < info.highlights.length; ++i) {
                setHighlight(info.highlights[i]);
            }
            console.log("Loaded " + info.highlights.length + " highlights");

            // Update export button
            export_button.style.display = '';
            var items = export_button.getElementsByClassName('dropdown-item');
            for (var i = 0; i < items.length; ++i) {
                var ext = items[i].getAttribute('data-extension');
                if (items[i].getAttribute('data-document') !== 'false') {
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
            window.setTimeout(function () {
                window.scrollTo(0, 0);
            }, 0);
        })
        .catch(function (error) {
            console.error("Failed to load document:", error);
            alert(gettext("Error loading document!") + "\n\n" + error);
        })
        .then(hideSpinner);
}

function loadTag(tag_path, page) {
    if (page === undefined) {
        page = 1;
    }
    showSpinner();
    getJSON(
        '/api/project/' + project_id + '/highlights/' + encodeURIComponent(tag_path) + '?page=' + page
    )
        .then(function (result) {
            console.log("Loaded highlights for tag", tag_path || "''");
            document_contents.style.direction = 'ltr';
            current_tag = tag_path;
            current_document = null;
            var document_links = document.getElementsByClassName('document-link-current');
            for (var i = document_links.length - 1; i >= 0; --i) {
                document_links[i].classList.remove('document-link-current');
            }
            // No need to clear the 'tag-current', we are calling updateTagsList() below
            document_contents.innerHTML = '';
            highlights = {};
            for (var i = 0; i < result.highlights.length; ++i) {
                var hl = result.highlights[i];
                var content = document.createElement('div');
                if (hl.text_direction === 'RIGHT_TO_LEFT') {
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

                var tag_names = hl.tags.map(function (tag) {
                    return findTag(tag).path;
                });
                tag_names.sort();
                for (var j = 0; j < tag_names.length; ++j) {
                    if (j > 0) {
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
            if (result.highlights.length == 0) {
                document_contents.innerHTML = '<p style="font-style: oblique; text-align: center;">' + gettext("No highlights with this tag yet.") + '</p>';
            }

            // Pagination controls
            function makePageLink(page_nb, label, current, enabled) {
                var item;
                if (current) {
                    item = document.createElement('li');
                    item.className = 'page-item active';
                    item.innerHTML = '<span class="page-link">' + label + '<span class="sr-only">(current)</span></span>';
                } else if (!enabled) {
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
                    link.addEventListener('click', function (e) {
                        e.preventDefault();
                        loadTag(tag_path, page_nb);
                    });
                    item.appendChild(link);
                }
                return item;
            }

            if (result.pages > 1 || page !== 1) {
                if (result.pages === undefined && page !== 1) {
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
                if (min_page > 2) {
                    pagination_ul.appendChild(makePageLink(page, "...", false, false));
                }
                // Other pages
                for (var i = min_page; i <= max_page; ++i) {
                    pagination_ul.appendChild(makePageLink(i, i, i === page, i !== page));
                }
                // "..." between other pages and last page, if appropriate
                if (max_page < result.pages - 1) {
                    pagination_ul.appendChild(makePageLink(page, "...", false, false));
                }
                // Last page
                pagination_ul.appendChild(makePageLink(result.pages, result.pages, result.pages === page, result.pages !== page));
                // Next button
                pagination_ul.appendChild(makePageLink(page + 1, "Next", false, page < result.pages));

                pagination.appendChild(pagination_ul);
                document_contents.appendChild(pagination);
            }

            // updateTagsList();

            // Update export button
            export_button.style.display = '';
            var items = export_button.getElementsByClassName('dropdown-item');
            for (var i = 0; i < items.length; ++i) {
                var ext = items[i].getAttribute('data-extension');
                if (items[i].getAttribute('data-highlights') !== 'false') {
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
            window.setTimeout(function () {
                window.scrollTo(0, 0);
            }, 0);
        })
        .catch(function (error) {
            console.error("Failed to load tag highlights:", error);
            alert(gettext("Error loading tag highlights!") + "\n\n" + error);
        })
        .then(hideSpinner);
}

// Load the document if the URL includes one
setTimeout(
    function () {
        var _document_url = new RegExp('^' + escapeRegExp(base_path) + '/project/([0-9]+)/document/([0-9]+)');
        // Don't use RegExp literals https://github.com/python-babel/babel/issues/640
        var m = window.location.pathname.match(_document_url);
        if (m) {
            loadDocument(parseInt(m[2]));
        }
        // Or a tag
        var _tag_url = new RegExp('^' + escapeRegExp(base_path) + '/project/([0-9]+)/highlights/([^/]*)');
        m = window.location.pathname.match(_tag_url);
        if (m) {
            loadTag(decodeURIComponent(m[2]));
        }
    },
    0,
);


// Load documents as we go through browser history
window.onpopstate = function (e) {
    if (e.state) {
        if (e.state.document_id !== undefined) {
            loadDocument(e.state.document_id);
        } else if (e.state.tag_path !== undefined) {
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
if (document.hasFocus()) {
    windowLastActive = null; // Focused now
}

window.addEventListener('focus', function () {
    // We are active as long as we have the focus
    windowLastActive = null;
    maybeResumePolling();
});
window.addEventListener('mousemove', function () {
    if (windowLastActive !== null) {
        // If the mouse moved over the window and we're not focused, refresh timer
        windowLastActive = new Date();
        maybeResumePolling();
    }
});
window.addEventListener('blur', function () {
    // We lost focus, start timer
    windowLastActive = new Date();
});


/*
 * Attach input change for tag search event
 */
const TAG_NOT_FOUND_MESSAGE = "No tag found";

document.getElementById('input-search-tags').addEventListener('input', function () {
    const alert_tag_treeview = $('#alert-tag-treeview');
    const filterText = $('#input-search-tags').val().toLowerCase();
    alert_tag_treeview.addClass('d-none')
    const filteredTags = handleSearch(filterText);
    initTagsTreeview(false, filteredTags);
    if (filteredTags.length === 0) {
        alert_tag_treeview.removeClass('d-none')
        alert_tag_treeview.html(`<strong>${TAG_NOT_FOUND_MESSAGE}</strong>`)
    }
});


document.getElementById('input-search-tags-highlight').addEventListener('input', function () {
    const alert_tag_highlight_treeview = $('#alert-tag-highlight-treeview');
    const filterText = $('#input-search-tags-highlight').val().toLowerCase();
    alert_tag_highlight_treeview.addClass('d-none')
    const filteredTags = handleSearch(filterText);
    initTagsHighlightTreeview(false, filteredTags);
    if (filteredTags.length === 0) {
        alert_tag_highlight_treeview.removeClass('d-none')
        alert_tag_highlight_treeview.html(`<strong>${TAG_NOT_FOUND_MESSAGE}</strong>`)
    }
});
