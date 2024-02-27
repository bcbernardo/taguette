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

const project_name_input = document.getElementById('project-name');
let project_name = project_name_input.value;

const project_description_input = document.getElementById('project-description');
let project_description = project_description_input.value;
let upload_canceled = false;

function setProjectMetadata(metadata, form = true) {
    if (project_name === metadata.project_name && project_description === metadata.description) {
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
    const elems = document.getElementsByClassName('project-name');
    for (let i = 0; i < elems.length; ++i) {
        elems[i].textContent = project_name;
    }
    log("Project metadata updated");
}

function projectMetadataChanged() {
    if (project_name_input.value !== project_name || project_description_input.value !== project_description) {
        log("Posting project metadata update");
        const meta = {
            name: project_name_input.value, description: project_description_input.value
        };
        postJSON(`/api/project/${project_id}`, meta)
            .then(function () {
                setProjectMetadata(meta, false);
            })
            .catch(function (error) {
                log("Failed to update project metadata:", 'error', {error});
                showAlert(`${gettext("Couldn't update project metadata!")} \n \n ${error}`, 'error');
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

let current_document = null;
let current_tag = null;
let last_added_tag = null;
const documents_list = document.getElementById('documents-list');

function linkDocument(elem, doc_id) {
    const url = `${base_path}/project/${project_id}/document/${doc_id}`;
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
        const first = documents_list.firstChild;
        if (first.classList && first.classList.contains('special-item-button')) {
            break;
        }
        documents_list.removeChild(first);
    }

    // Fill up the list again
    const before = documents_list.firstChild;
    const entries = Object.entries(documents);
    sortByKey(entries, function (e) {
        return e[1].name;
    });
    for (let i = 0; i < entries.length; ++i) {
        let doc = entries[i][1];
        let elem = document.createElement('li');
        elem.setAttribute('id', 'document-link-' + doc.id);
        elem.className = 'list-group-item document-link';
        if (doc.id === current_document) {
            elem.classList.add('document-link-current');
        }
        elem.innerHTML = '<div class="d-flex justify-content-between align-items-center">' + '  <a class="document-link-a">' + escapeHtml(doc.name) + '</a>' + '  <a href="javascript:editDocument(' + doc.id + ');" class="btn btn-primary btn-sm">' + gettext("Edit") + '</a>' + '</div>';
        documents_list.insertBefore(elem, before);
        const links = elem.getElementsByTagName('a');
        linkDocument(links[0], doc.id);
    }
    if (entries.length === 0) {
        let elem = document.createElement('div');
        elem.className = 'list-group-item disabled';
        elem.textContent = gettext("There are no documents in this project yet.");
        documents_list.insertBefore(elem, before);
    }
    log("Documents list updated");
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
    if (current_document === document_id) {
        window.history.pushState({}, "Project", base_path + '/project/' + project_id);
        loadDocument(null);
    }
}


/*
 * Add document
 */

const document_add_modal = document.getElementById('document-add-modal');

function createDocument() {
    document.getElementById('document-add-form').reset();
    $(document_add_modal).modal('show');
}

function basename(filename) {
    if (filename) {
        const idx = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
        if (idx > -1) {
            filename = filename.substring(idx + 1);
        }
    }
    return filename;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function doUpload(form_data) {
    return new Promise(function(resolve, reject) {
        let xhr = new XMLHttpRequest(),
            name = form_data.get('name');
        xhr.responseType = 'json';
        xhr.open('POST', base_path + '/api/project/' + project_id + '/document/new');
        xhr.onload = function () {
            if (xhr.status === 200) {
                log("Document upload complete");
                resolve({
                    'doc_to_load': xhr.response.created
                })
            } else {
                const context = xhr.status;
                log("Document upload failed: status", 'error', {context})
                let error = null;
                try {
                    error = `<p>(${name}) ${xhr.response.error}</p>`;
                } catch (e) {
                }
                if (!error) {
                    error = `<p>(${name}) Status ${xhr.status}</p>`;
                }
                reject({
                    'error_msg': error
                });
            }
        };
        xhr.onerror = function (e) {
            log("Document upload failed:", 'error', {e});
            reject({
                'error_msg': `<p>${e}</p>`
            });
        }
        xhr.send(form_data);
    });
}

async function uploadFiles(files) {
    showSpinner(function(){ upload_canceled = true; });
    await delay(100); // Trick to refresh dom
    let error_msg = '',
        doc_to_load = null;
    upload_canceled = false;
    for(let f in files) {
        if(isNaN(f) || upload_canceled) {
            continue;
        }
        let form_data = new FormData(),
            name = files[f].name;
        name = name.substring(0, 50);

        form_data.append('name', name);
        form_data.append('description', document.getElementById('document-add-description').value);
        form_data.append('file', files[f]);
        form_data.append('text_direction', document.getElementById('document-add-form').elements['document-add-direction'].value);
        form_data.append('_xsrf', getCookie('_xsrf'));

        await doUpload(form_data).then(
            function(success) {
                if(doc_to_load === null) {
                    doc_to_load = success.doc_to_load;
                }
            },
            function(error) {
                error_msg += error.error_msg;
            }
        );
    }

    if(error_msg !== '') {
        showAlert(`${gettext("Error uploading file!")} \n \n${error_msg}`, 'error')
    }

    // Load first uploaded document
    if(doc_to_load !== null) {
        $(document_add_modal).modal('hide');
        document.getElementById('document-add-form').reset();
        const url = `${base_path}/project/${project_id}/document/${doc_to_load}`;
        window.history.pushState({document_id: doc_to_load}, "Document " + doc_to_load, url);
        loadDocument(doc_to_load);
    }
    hideSpinner();
}

document.getElementById('document-add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    log("Uploading documents...");
    uploadFiles(document.getElementById('document-add-file').files)
});


/*
 * Change document
 */

const document_change_modal = document.getElementById('document-change-modal');

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
    log("Changing document...");

    let update = {
        name: document.getElementById('document-change-name').value,
        description: document.getElementById('document-change-description').value,
        text_direction: document.getElementById('document-change-form').elements['document-change-direction'].value
    };
    if (!update.name || update.name.length === 0) {
        showAlert(gettext("Document name cannot be empty"));
        return;
    }

    const doc_id = document.getElementById('document-change-id').value;
    showSpinner();
    postJSON(`/api/project/${project_id}/document/${doc_id}`, update)
        .then(function () {
            log("Document update posted");
            $(document_change_modal).modal('hide');
            document.getElementById('document-change-form').reset();
        })
        .catch(function (error) {
            log("Document upload failed:", 'error', {error});
            showAlert(`${gettext("Error uploading file!")} \n \n`, 'error', {error})
        })
        .then(hideSpinner);
});

document.getElementById('document-change-delete').addEventListener('click', function (e) {
    e.preventDefault();

    const doc_id = document.getElementById('document-change-id').value;

    showConfirm(gettext("Are you sure you want to delete the document '%(doc)s'?", {doc: documents[doc_id].name}), function () {
        log(`document ${doc_id} ...`);
        deleteURL(`/api/project/${project_id}/document/${doc_id}`)
            .then(function () {
                log("Document deletion posted");
                $(document_change_modal).modal('hide');
                document.getElementById('document-change-form').reset();
            })
            .catch(function (error) {
                log("Failed to delete document", 'error', {error});
                showAlert(`${gettext("Couldn't delete document!!")} \n \n`, 'error', {error})
            });
    });
});


/*
 * Tags list
 */

let sortTags = ['path', 'asc'];

function sortTagsBy(field, dir) {
    sortTags = [field, dir];
    let options = document.getElementById('tag-sortby-menu').querySelectorAll('a.dropdown-item');
    let optionSorts = [['path', 'asc'], ['path', 'desc'], ['count', 'asc'], ['count', 'desc'],];
    for (let i = 0; i < optionSorts.length; ++i) {
        if (optionSorts[i][0] === field && optionSorts[i][1] === dir) {
            options[i].classList.add('active');
        } else {
            options[i].classList.remove('active');
        }
    }
    updateTagsList();
}

function linkTag(elem, tag_path, selectAll = true) {
    const url = `${base_path}/project/${project_id}/highlights/${encodeURIComponent(tag_path)}`;
    elem.setAttribute('href', url);
    elem.addEventListener('click', function (e) {
        e.preventDefault();
        window.history.pushState({tag_path: tag_path}, "Tag " + tag_path, url);
        loadTag(tag_path);
        if (selectAll) {
            selectAllTag();
        } else {
            const tag = findTag(tag_path)
            selectTag(treeview_tags ,tag.id)
        }
    });
}

linkTag(document.getElementById('load-all-tags'), '');

function highlightModalReset() {
    document.getElementById('highlight-add-form').reset();
    hideSearchErrorMessage();
    initTagsHighlightTreeview(false);
}


const tag_add_modal = document.getElementById('tag-add-modal');

$(tag_add_modal).on('shown.bs.modal', function () {
    document.getElementById('tag-add-path').focus();
});

function createTag(from, selection) {
    document.getElementById('tag-add-form').reset();
    document.getElementById('tag-add-id').value = '';
    document.getElementById('tag-add-path').value = '';
    document.getElementById('tag-add-color').value = '';
    document.getElementById('tag-highlight-add-start').value = '';
    document.getElementById('tag-highlight-add-end').value = '';
    document.getElementById('tag-add-label-new').style.display = '';
    document.getElementById('tag-add-label-change').style.display = 'none';
    document.getElementById('tag-add-cancel').style.display = '';
    document.getElementById('tag-add-delete').style.display = 'none';
    document.getElementById('tag-add-merge').style.display = 'none';
    if (from === 2) {
        document.getElementById('tag-add-path').value = document.getElementById('input-search-tags-highlight').value;
    }

    if(selection) {
        document.getElementById('tag-highlight-add-start').value = selection[0];
        document.getElementById('tag-highlight-add-end').value = selection[1];
    }

    $(tag_add_modal).modal('show');
}

function editTag(tag_id) {
    const tag = findTag(tag_id);
    document.getElementById('tag-add-form').reset();
    document.getElementById('tag-add-id').value = '' + tag_id;
    if (tag.parent) {
        document.getElementById('tag-add-parent-id').value = tag.parent;
        document.getElementById('dropdownMenuButtonTag').innerText = findTag(tag.parent).path;
    }
    document.getElementById('tag-add-path').value = tag.path;
    document.getElementById('tag-add-color').value = tag.color;
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

    let tag_id = document.getElementById('tag-add-id').value
        ? parseInt(document.getElementById('tag-add-id').value) : null;
    let tag_path = document.getElementById('tag-add-path').value;
    let tag_parent_id = document.getElementById('tag-add-parent-id').value
        ? parseInt(document.getElementById('tag-add-parent-id').value) : null;

    if (!tag_path) {
        showAlert(gettext("Invalid tag name"));
        return;
    }

    if (tag_id && tag_parent_id && tag_id === tag_parent_id) {
        showAlert(gettext("Impossible to define the same tag as parent"), 'warning');
        return;
    }

    const new_tag = {
        id: tag_id,
        path: tag_path,
        description: document.getElementById('tag-add-description').value,
        color: document.getElementById('tag-add-color').value,
        parent_id: tag_parent_id
    };

    const callbackSuccess = (reply) => {

        log("Tag posted");

        last_added_tag = reply.id;

        const selection = [
            parseInt(document.getElementById('tag-highlight-add-start').value),
            parseInt(document.getElementById('tag-highlight-add-end').value)
        ];

        // Check if either element of the selection array is NaN
        const containsNaN = selection.some(isNaN);

        // add highlight if it created from selection
        if(!containsNaN) {
            const highlight = {
                id: undefined, selection, tags: [last_added_tag]
            }

            setTimeout(function() {
                //call submit
                submitHighLightCreation(highlight);
            }, 60);
        }

        $(tag_add_modal).modal('hide');
        document.getElementById('input-search-tags-highlight').value = '';
        document.getElementById('dropdownMenuButtonTag').innerText = 'None';

    };
    const callbackFail = (error) => {
        log("Failed to create tag", 'error', {error});
        showAlert(`${gettext("Couldn't create tag!")} \n \n`, 'error', {error})
    };

    // Call submitTagCreation with the new_tag object and callbacks
    submitTagCreation(new_tag, callbackSuccess, callbackFail);

});

// Delete tag button
document.getElementById('tag-add-delete').addEventListener('click', function (e) {
    let tag_id = document.getElementById('tag-add-id').value;
    const tag = findTag(tag_id)
    if (tag_id) {
        showConfirm(gettext("Are you sure you want to delete the tag '%(tag)s'?", {tag: tag.path}), function () {
            tag_id = parseInt(tag_id);
            log(`Posting tag ${tag_id} deletion`);
            deleteURL(`/api/project/${project_id}/tag/${tag_id}`)
                .then(function () {
                    $(tag_add_modal).modal('hide');
                    document.getElementById('tag-add-form').reset();
                })
                .catch(function (error) {
                    log("Failed to delete tag", 'error', {error});
                    showAlert(`${gettext("Couldn't delete tag!")} \n \n`, 'error', {error})
                });
        });
    }
});

// Merge tags button in tag edit modal: shows merge modal
document.getElementById('tag-add-merge').addEventListener('click', function (e) {
    e.preventDefault();

    let tag_id = document.getElementById('tag-add-id').value;
    if (!tag_id) return;
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
    if (!tag_src) return;
    tag_src = parseInt(tag_src);

    let tag_dest = document.getElementById('tag-merge-dest').value;
    if (!tag_dest) return;
    tag_dest = parseInt(tag_dest);

    // Todo : add trans key
    if (tag_src === tag_dest) {
        showAlert('Merge not possible')
        return
    }

    showSpinner();
    postJSON(`/api/project/${project_id}/tag/merge`, {src: tag_src, dest: tag_dest})
        .then(function () {
            log("Tag merge posted");
            $(document.getElementById('tag-merge-modal')).modal('hide');
        })
        .catch(function (error) {
            log("Failed to merge tags", 'error', {error});
            showAlert(`${gettext("Couldn't merge tags!")} \n \n`, 'error', {error})
        })
        .then(hideSpinner);
});


// Backlight
const backlight_checkbox = document.getElementById('backlight');
backlight_checkbox.addEventListener('change', function () {
    const documentView = document.getElementById('document-view');

    documentView.classList.toggle('backlight', backlight_checkbox.checked);
});


/*
 * Add highlight
 */

const highlight_add_modal = document.getElementById('highlight-add-modal');

// Updates current_selection and visibility of the controls
function selectionChanged() {
    current_selection = describeSelection();
    let hlinfo = document.getElementById('hlinfo');
    if (current_selection !== null) {
        const current_range = window.getSelection().getRangeAt(0);
        if (current_range.toString().match(onlyWhitespace)) {
            hlinfo.style.display = 'none';
        } else if (current_range.endOffset > 0) {
            let last_char_range = document.createRange();
            last_char_range.setStart(current_range.endContainer, current_range.endOffset - 1);
            last_char_range.setEnd(current_range.endContainer, current_range.endOffset);
            let rect = last_char_range.getClientRects().item(0);
            let scrollPos = getScrollPos();
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
    //$(highlight_add_modal).modal('show').drags({handle: '.modal-header'});
    $(highlight_add_modal).modal('show');
}

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
    //$(highlight_add_modal).modal('show').drags({handle: '.modal-header'});
    $(highlight_add_modal).modal('show');
}

$('#highlight-add-form').off().on('submit', (e) => {

    e.preventDefault();

    const highlight_id = document.getElementById('highlight-add-id').value;
    const selection = [parseInt(document.getElementById('highlight-add-start').value), parseInt(document.getElementById('highlight-add-end').value)];

    const selectedTags = treeview_tags_highlight.treeview('getSelected');

    const hl_tags = selectedTags.map((tag) => tag.id);

    if (hl_tags.length === 0) return;

    const highlight = {
        id: highlight_id, selection, tags: hl_tags
    }

    const callbackSuccess = () => {
        log("Highlight posted");
        $(highlight_add_modal).modal('hide');
        highlightModalReset();
    };
    const callbackFail = (error) => {
        log("Failed to create highlight", 'error', {error})
        showAlert(`${gettext("Couldn't create highlight!")} \n\n`,'error');
    };

    //call submit
    submitHighLightCreation(highlight, callbackSuccess, callbackFail);
})

// Delete highlight button
document.getElementById('highlight-delete').addEventListener('click', function () {
    let highlight_id = document.getElementById('highlight-add-id').value;
    if (highlight_id) {
        highlight_id = parseInt(highlight_id);
        log(`Posting highlight ${highlight_id} deletion`);
        deleteURL(`/api/project/${project_id}/document/${current_document}/highlight/${highlight_id}`)
            .then(function () {
                $(highlight_add_modal).modal('hide');
                highlightModalReset();
            })
            .catch(function (error) {
                log("Failed to delete highlight", 'error', {error});
                showAlert(`${gettext("Couldn't delete highlight!")} \n \n`, 'error', {error})
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

const members_modal = document.getElementById('members-modal');
let members_initial = {};
let members_displayed = {};

function _memberRow(login, user, can_edit, is_self) {
    let elem = document.createElement('div');
    elem.className = 'row members-item';
    elem.innerHTML = '<div class="col-md-4">' + '  <p class="members-item-login">' + login + '</p>' + '</div>' + '<div class="col-md-4 form-group">' + '  <select class="form-control"' + (can_edit ? '' : ' disabled') + '>' + '    <option value="ADMIN">' + gettext("Full permissions") + '</option>' + '    <option value="MANAGE_DOCS">' + gettext("Can't change collaborators / delete project") + '</option>' + '    <option value="TAG">' + gettext("View & make changes") + '</option>' + '    <option value="READ">' + gettext("View only") + '</option>' + '  </select>' + '</div>' + (is_self ? '<button type="button" class="btn btn-danger col-md-4 form-group">Leave project</button>' : '<button type="button" class="btn btn-danger col-md-4 form-group"' + (can_edit ? '' : ' disabled') + '>Remove collaborator</button>');

    [].forEach.call(elem.querySelectorAll('option'), function (e) {
        if (e.value === user.privileges) {
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

    const can_edit = members[user_login].privileges === 'ADMIN';

    if (can_edit) {
        document.getElementById('members-add-fields').removeAttribute('disabled');
    } else {
        document.getElementById('members-add-fields').setAttribute('disabled', 1);
    }

    let entries = Object.entries(members);
    sortByKey(entries, function (e) {
        return e[0];
    });
    log("Members:", entries.map(function (e) {
        return e[0] + " (" + e[1].privileges + ")";
    })
        .join(", "));

    // Empty the list
    let current_members = document.getElementById('members-current');
    current_members.innerHTML = '';

    // Fill it back up
    for (let i = 0; i < entries.length; ++i) {
        const login = entries[i][0];
        const user = entries[i][1];
        const elem = _memberRow(login, user, can_edit, login === user_login);

        current_members.appendChild(elem);
    }

    // Store current state so that we can compare later
    members_initial = Object.assign({}, members);
    members_displayed = Object.assign({}, members);

    $(members_modal).modal('show');
}

document.getElementById('members-add').addEventListener('submit', function (e) {
    e.preventDefault();

    const login = document.getElementById('member-add-name').value.toLowerCase();
    if (!login) {
        return;
    }
    const privileges = document.getElementById('member-add-privileges').value;

    // Check login
    if (login in members_displayed) {
        showAlert(gettext("Already a member!"));
        document.getElementById('members-add').reset();
        return;
    }
    postJSON('/api/check_user', {login: login})
        .then(function (result) {
            if (result.exists) {
                // Add it at the top
                const elem = _memberRow(login, {privileges: privileges});
                const current_members = document.getElementById('members-current');
                current_members.insertBefore(elem, current_members.firstChild);
                members_displayed[login] = true;

                document.getElementById('members-add').reset();
            } else {
                showAlert(gettext("This user doesn't exist!"));
            }
        })
});

function sendMembersPatch() {
    let patch = {};

    let members_before = Object.assign({}, members_initial);

    const rows = document.getElementById('members-current').querySelectorAll('.members-item');
    for (let i = 0; i < rows.length; ++i) {
        const row = rows[i];
        const login = row.querySelector('.members-item-login').textContent;
        const privileges = row.querySelector('select').value;

        // Add to patch, if different from stored version
        if (!members_before[login] || members_before[login].privileges !== privileges) {
            patch[login] = {privileges: privileges};
        }

        // Remove from object, so what's left are the removed members
        delete members_before[login];
    }

    // Remove the members that are left
    const entries = Object.entries(members_before);
    for (let i = 0; i < entries.length; ++i) {
        patch[entries[i][0]] = null;
    }

    log("Patching members list");
    showSpinner();
    patchJSON('/api/project/' + project_id + '/members', patch)
        .then(function () {
            log("Members list patched");
            $(members_modal).modal('hide');
        })
        .catch(function (error) {
            log("Failed to patch members list", 'error', {error});
            showAlert(`${gettext("Couldn't update collaborators!")} \n \n`, 'error', {error})
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

const document_contents = document.getElementById('document-contents');
const export_button = document.getElementById('export-button');

function loadDocument(document_id) {
    if (document_id === null) {
        document_contents.style.direction = 'ltr';
        document_contents.innerHTML = '<p style="font-style: oblique; text-align: center;">' + gettext("Load a document on the left") + '</p>';
        return;
    }
    showSpinner();
    const info = getJSON(`/api/project/${project_id}/document/${document_id}`);
    const contents = getJSON(`/api/project/${project_id}/document/${document_id}/contents`);
    Promise.all([info, contents])
        .then(function (results) {
            const info = results[0];
            const contents = results[1];
            document_contents.innerHTML = '';
            highlights = {};
            chunk_offsets = [];
            for (let i = 0; i < contents.contents.length; ++i) {
                let chunk = contents.contents[i];
                let elem = document.createElement('div');
                elem.setAttribute('id', 'doc-offset-' + chunk.offset);
                elem.classList.add('draggable');
                elem.setAttribute('contenteditable', 'true');
                elem.addEventListener('dragstart', function (event) {
                        event.dataTransfer.effectAllowed = 'move';
                });
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
            let document_links = document.getElementsByClassName('document-link-current');
            for (let i = document_links.length - 1; i >= 0; --i) {
                document_links[i].classList.remove('document-link-current');
            }
            let document_link = document.getElementById('document-link-' + current_document);
            if (document_link) {
                document_link.classList.add('document-link-current');
            }

            current_tag = null;
            let tag_links = document.getElementsByClassName('tag-current');
            for (let i = tag_links.length - 1; i >= 0; --i) {
                tag_links[i].classList.remove('tag-current');
            }
            log(`Loaded document ${document_id}`);
            for (let i = 0; i < info.highlights.length; ++i) {
                setHighlight(info.highlights[i]);
            }
            log(`Loaded ${info.highlights.length} highlight`);

            // Update export button
            export_button.style.display = '';
            let items = export_button.getElementsByClassName('dropdown-item');
            for (let i = 0; i < items.length; ++i) {
                const ext = items[i].getAttribute('data-extension');
                if (items[i].getAttribute('data-document') !== 'false') {
                    items[i].setAttribute('href', `${base_path}/project/${project_id}/export/document/${document_id}.${ext}`);
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
            log("Failed to load document", 'error', {error});
            showAlert(`${gettext("Error loading document!")} \n \n`, 'error', {error})
        })
        .then(hideSpinner);
}

function loadTag(tag_path, page) {
    if (page === undefined) {
        page = 1;
    }
    if(tag_path !== undefined) {
        showSpinner();
    }
    getJSON(
        `/api/project/${project_id}/highlights/${encodeURIComponent(tag_path)}?page=${page}`
    )
        .then(function (result) {
            log(`Loaded highlights for tag ${tag_path}`);
            document_contents.style.direction = 'ltr';
            current_tag = tag_path;
            current_document = null;
            let document_links = document.getElementsByClassName('document-link-current');
            for (let i = document_links.length - 1; i >= 0; --i) {
                document_links[i].classList.remove('document-link-current');
            }
            // No need to clear the 'tag-current', we are calling updateTagsList() below
            document_contents.innerHTML = '';
            highlights = {};
            for (let i = 0; i < result.highlights.length; ++i) {
                const hl = result.highlights[i];
                let content = document.createElement('div');
                if (hl.text_direction === 'RIGHT_TO_LEFT') {
                    content.style.direction = 'rtl';
                } else {
                    content.style.direction = 'ltr';
                }
                content.innerHTML = result.highlights[i].content;
                let elem = document.createElement('div');
                elem.className = 'highlight-entry';
                elem.setAttribute('id', 'highlight-entry-' + hl.id);
                elem.appendChild(content);
                elem.appendChild(document.createTextNode(' '));

                let doclink = document.createElement('a');
                doclink.className = 'badge badge-primary';
                doclink.textContent = documents['' + hl.document_id].name;
                linkDocument(doclink, hl.document_id);
                elem.appendChild(doclink);
                elem.appendChild(document.createTextNode(' '));

                let tag_names = hl.tags.map(function (tag) {
                    return findTag(tag).path;
                });
                tag_names.sort();
                for (let j = 0; j < tag_names.length; ++j) {
                    if (j > 0) {
                        elem.appendChild(document.createTextNode(' '));
                    }
                    let taglink = document.createElement('a');
                    const tag = findTag(tag_names[j])
                    taglink.className = 'badge';
                    taglink.setAttribute('style', `background-color: ${tag.color}; color: white; font-weight: bold;`);
                    taglink.textContent = tag_names[j];
                    linkTag(taglink, taglink.textContent, false);
                    elem.appendChild(taglink);
                }

                document_contents.appendChild(elem);
            }
            if (result.highlights.length === 0) {
                document_contents.innerHTML = '<p style="font-style: oblique; text-align: center;">' + gettext("No highlights with this tag yet.") + '</p>';
            }

            // Pagination controls
            function makePageLink(page_nb, label, current, enabled) {
                let item;
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
                    let link = document.createElement('a');
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
                let pagination = document.createElement('nav');
                pagination.setAttribute('aria-label', "Page navigation");
                let pagination_ul = document.createElement('ul');
                pagination_ul.className = 'pagination justify-content-center';
                const min_page = Math.max(2, page - 2);
                const max_page = Math.min(result.pages - 1, page + 2);

                // Previous button
                pagination_ul.appendChild(makePageLink(page - 1, "Previous", false, page > 1));
                // Page 1
                pagination_ul.appendChild(makePageLink(1, 1, 1 === page, 1 !== page));
                // "..." between 1 and other pages, if appropriate
                if (min_page > 2) {
                    pagination_ul.appendChild(makePageLink(page, "...", false, false));
                }
                // Other pages
                for (let i = min_page; i <= max_page; ++i) {
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

            // Update export button
            export_button.style.display = '';
            let items = export_button.getElementsByClassName('dropdown-item');
            for (let i = 0; i < items.length; ++i) {
                const ext = items[i].getAttribute('data-extension');
                if (items[i].getAttribute('data-highlights') !== 'false') {
                    items[i].setAttribute('href', base_path + '/project/' + project_id + '/export/highlights/' + encodeURIComponent(tag_path) + '.' + ext,);
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
            log("Failed to load tag highlights", 'error', {error});
            showAlert(`${gettext("Error loading tag highlights!")} \n \n`, 'error', {error})
        })
        .then(function (result) {
            hideSpinner();
        });
}

// Load the document if the URL includes one
setTimeout(function () {
    const _document_url = new RegExp(`^${escapeRegExp(base_path)}/project/([0-9]+)/document/([0-9]+)`);
    // Don't use RegExp literals https://github.com/python-babel/babel/issues/640
    let m = window.location.pathname.match(_document_url);
    if (m) {
        loadDocument(parseInt(m[2]));
    }
    // Or a tag
    const _tag_url = new RegExp(`^${escapeRegExp(base_path)}/project/([0-9]+)/highlights/([^/]*)`);
    m = window.location.pathname.match(_tag_url);
    if (m) {
        loadTag(decodeURIComponent(m[2]));
    }
}, 0,);


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

const alert_tag_highlight_treeview = $('#alert-tag-highlight-treeview');
document.getElementById('input-search-tags-highlight').addEventListener('input', function () {
    const filterText = $('#input-search-tags-highlight').val().toLowerCase();
    hideSearchErrorMessage();
    const filteredTags = handleSearch(filterText);
    initTagsHighlightTreeview(false, filteredTags);
    if (filteredTags.length === 0) {
        showSearchErrorMessage();
        alert_tag_highlight_treeview.html(`<strong>${TAG_NOT_FOUND_MESSAGE}</strong>`)
    }
});

function showSearchErrorMessage() {
    alert_tag_highlight_treeview.removeClass('d-none');
}

function hideSearchErrorMessage() {
    alert_tag_highlight_treeview.addClass('d-none');
}