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

function openSidebar() {

    // Desktop behavior
    if (window.innerWidth > 768) {
        document.getElementById("project-sidebar").style.width = "600px";
    } else {
        document.getElementById("project-sidebar").style.width = "100%";
    }
    showMembers();
}

function closeSideBar() {
    document.getElementById("project-sidebar").style.width = "0";
}

document.getElementById('project-sidebar-open').addEventListener('click', openSidebar);

document.addEventListener('click', function(event) {
    const sidebar = document.getElementById('project-sidebar');
    const openButton = document.getElementById('project-sidebar-open');

    // Check if sidebar is open (width is not "0" or "0px")
    if (sidebar && sidebar.style.width && sidebar.style.width !== "0" && sidebar.style.width !== "0px") {
        // If click is outside sidebar AND not on the button that opens it
        if (!sidebar.contains(event.target) && !openButton.contains(event.target)) {
            closeSideBar();
        }
    }
});

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
 * Add document
 */


const document_add_modal = document.getElementById('document-add-modal');

function createDocument() {
    document.getElementById('document-add-form').reset();
    
    cleanupDocumentDispatchInterface();
    
    initDocumentCollectionHierarchySelect();
    
    $(document_add_modal).modal('show').drags({handle: '.modal-header'});
    customSelect.classList.remove("active");
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

function doUpload(form_data, percent=0) {
    return new Promise(function(resolve, reject) {
        let xhr = new XMLHttpRequest(),
            name = form_data.get('name');
        
        
        xhr.responseType = 'json';
        xhr.open('POST', base_path + '/api/project/' + project_id + '/document/new');
        xhr.onload = function () {
            if (xhr.status === 200) {
                log("Document upload complete");
                resolve({
                    'doc_to_load': xhr.response.created,
                    'percent': percent
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
                    'error_msg': error,
                    'percent': percent
                });
            }
        };
        xhr.onerror = function (e) {
            log("Document upload failed:", 'error', {e});
            reject({
                'error_msg': `<p>${e}</p>`,
                'percent': percent
            });
        }
        
        xhr.send(form_data);
    });
}

async function uploadFiles(files) {
    
    showSpinner(function(){ upload_canceled = true; }, true);
    await delay(100); // Trick to refresh dom
    let error_msg = '',
        doc_to_load = null,
        num_files = files.length,
        file_number = 1;
    upload_canceled = false;
    for(let f in files) {
        if(isNaN(f) || upload_canceled) {
            continue;
        }
        log(files[f]);
        let form_data = new FormData(),
            name = files[f].name,
            percent = Math.ceil(100*file_number/num_files);
        name = name.substring(0, 50);

        form_data.append('name', name);
        form_data.append('description', document.getElementById('document-add-description').value);
        form_data.append('file', files[f]);
        form_data.append('_xsrf', getCookie('_xsrf'));

        const fileIndex = parseInt(f);
        const fileSelector = document.querySelector(`#document-files-list select[data-file-index="${fileIndex}"]:not(.text-direction-selector)`);
        const textDirectionSelector = document.querySelector(`#document-files-list .text-direction-selector[data-file-index="${fileIndex}"]`);
        
        // Use individual text direction if available, otherwise fall back to global
        const textDirection = textDirectionSelector?.value || document.getElementById('document-add-form').elements['document-add-direction'].value;
        form_data.append('text_direction', textDirection);
        
        if (fileSelector) {
            if (fileSelector.dataset.createNew === 'true') {
                const newCollectionName = fileSelector.dataset.newCollectionName || `Collection for ${name}`;
                form_data.append('create_collection_name', newCollectionName);
            } else {
                const selectedCollectionId = fileSelector.value;
                if (selectedCollectionId) {
                    form_data.append('collection_ids', selectedCollectionId);
                }
            }
        }

        file_number++;

        await doUpload(form_data, percent).then(
            function(success) {
                updateProgress(success.percent);
                if(doc_to_load === null) {
                    doc_to_load = success.doc_to_load;
                }
            },
            function(error) {
                updateProgress(error.percent);
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
        
        cleanupDocumentDispatchInterface();
        
        const url = `${base_path}/project/${project_id}/document/${doc_to_load}`;
        window.history.pushState({document_id: doc_to_load}, "Document " + doc_to_load, url);
        updateDocumentsList();
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

    initDocumentChangeCollectionHierarchySelect(true);

    const docCollections = documents['' + doc_id].collections || [];
    if (docCollections.length > 0) {
        const firstCollectionId = docCollections[0];
        document.getElementById('document-change-collection-id').value = firstCollectionId;
        const collection = findCollection(firstCollectionId);
        if (collection) {
            document.getElementById('dropdownMenuButtonDocumentChangeCollection').innerText = collection.name;
        }
    } else {
        document.getElementById('document-change-collection-id').value = '';
        document.getElementById('dropdownMenuButtonDocumentChangeCollection').innerText = gettext('None');
    }

    $(document_change_modal).modal('show').drags({handle: '.modal-header'});
}

function doDeleteDocument(project_id, doc_id, successCallback=null, errorCallback=null) {
    deleteURL(`/api/project/${project_id}/document/${doc_id}`)
        .then(successCallback)
        .catch(function (error) {
            if(errorCallback === null) {
                log("Failed to delete document", 'error', {error});
                showAlert(`${gettext("Couldn't delete document!!")} \n \n`, 'error', {error})
            } else {
                errorCallback(error)
            }
        });
}

function deleteDocument(doc_id) {
    showConfirm(gettext("Are you sure you want to delete the document '%(doc)s'?", {doc: documents[doc_id].name}), function () {
        log(`document ${doc_id} ...`);
        doDeleteDocument(project_id, doc_id, function () {
            log("Document deletion posted");
            $(document_change_modal).modal('hide');
            document.getElementById('document-change-form').reset();

            if (document && document.collections) {
                for (let collectionId of document.collections) {
                    const collection = findCollection(parseInt(collectionId));
                    if (collection && collection.document_ids) {
                        const index = collection.document_ids.indexOf(parseInt(doc_id));
                        if (index !== -1) {
                            collection.document_ids.splice(index, 1);
                        }
                    }
                }
            }

            delete documents['' + doc_id];
            updateDocumentsList();
            initDocumentsTreeview();

            if (current_document === doc_id) {
                window.history.pushState({}, "Project", base_path + '/project/' + project_id);
                loadDocument(null);
            }
        });
    }, true);
}

document.getElementById('document-change-form').addEventListener('submit', function (e) {
    e.preventDefault();
    log("Changing document...");

    const doc_id = document.getElementById('document-change-id').value

    const updatedDocument = {
        id: doc_id,
        name: document.getElementById('document-change-name').value,
        description: document.getElementById('document-change-description').value,
        text_direction: document.getElementById('document-change-form').elements['document-change-direction'].value
    };

    if (!updatedDocument.name || updatedDocument.name.length === 0) {
        showAlert(gettext("Document name cannot be empty"));
        return;
    }

    const selectedCollectionId = document.getElementById('document-change-collection-id').value;
    updatedDocument.collections = selectedCollectionId ? [selectedCollectionId] : [];

    const callbackSuccess = (response) => {
        log("Document update posted");
        $(document_change_modal).modal('hide');
        document.getElementById('document-change-form').reset();
        loadDocument(current_document);
    }

    const callbackFail = (error) => {
        log("Document upload failed:", 'error', {error});
        showAlert(`${gettext("Error uploading file!")} \n \n`, 'error', {error})
    };

    submitDocumentUpdate(updatedDocument, callbackSuccess, callbackFail)

});

document.getElementById('document-change-delete').addEventListener('click', function (e) {
    e.preventDefault();
    const doc_id = parseInt(document.getElementById('document-change-id').value);
    deleteDocument(doc_id);
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
        selectAllTag();
    });
}

linkTag(document.getElementById('load-all-tags'), '');

function highlightModalReset() {
    document.getElementById('highlight-add-form').reset();
    highlightSelectedTags.length = 0;
    showHighlightTagSelection();
    hideSearchErrorMessage();
    savedSelections = [];
    initTagsHighlightTreeview();
}


const tag_add_modal = document.getElementById('tag-add-modal');

$(tag_add_modal).on('shown.bs.modal', function () {
    document.getElementById('tag-add-path').focus();
});
let createTagFromHighlight;
function createTag(fromHighlight, selection, parent) {
    document.getElementById('hlinfo').style.display = 'none';
    createTagFromHighlight = fromHighlight;
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
    if (fromHighlight) {
        document.getElementById('tag-add-path').value = document.getElementById('input-search-tags-highlight').value;
    }

    if(selection) {
        document.getElementById('tag-highlight-add-start').value = selection[0];
        document.getElementById('tag-highlight-add-end').value = selection[1];
    }

    if(parent) {
        document.getElementById('tag-add-parent-id').value = parent;
        document.getElementById('dropdownMenuButtonTag').innerText = findTag(parent).path
    }

    $(tag_add_modal).modal('show').drags({handle: '.modal-header'});
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
    $(tag_add_modal).modal('show').drags({handle: '.modal-header'});
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
        if(!containsNaN && !tag_id) {
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
        document.getElementById('dropdownMenuButtonTag').innerText = gettext('None');

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
    deleteTag(tag_id);
});

function deleteTag(tag_id) {
    if (tag_id) {
        const tag = findTag(tag_id)
        showConfirm(gettext("Are you sure you want to delete the tag '%(tag)s'?", {tag: tag.path}), function () {
            tag_id = parseInt(tag_id);
            log(`Posting tag ${tag_id} deletion`);
            const callbackSuccess = (result) => {
                $(tag_add_modal).modal('hide');
                document.getElementById('tag-add-form').reset();
            };

            const callbackFail = (error) => {
                log("Failed to delete tag", 'error', {error});
                showAlert(`${gettext("Couldn't delete tag!")} \n \n`, 'error', {error})
            };

            submitTagDelete(tag_id, callbackSuccess, callbackFail);
        }, true);
    }
}



// Merge tags button in tag edit modal: shows merge modal
document.getElementById('tag-add-merge').addEventListener('click', function (e) {
    e.preventDefault();

    let tag_id = document.getElementById('tag-add-id').value;
    if (!tag_id) return;
    mergeTag(tag_id);
});

function mergeTag(tag_id) {

    tag_id = parseInt(tag_id);
    const tag = findTag(tag_id);

    document.getElementById('tag-merge-form').reset();
    document.getElementById('tag-merge-src-id').value = '' + tag_id;
    document.getElementById('tag-merge-src-name').value = tag.path;

    document.getElementById('tag-merge-warning').classList.add('d-none');
    document.getElementById('tag-merge-warning-text').textContent = '';

    $(document.getElementById('tag-merge-modal')).modal('show');
}

function updateMergeWarning() {
    const warningDiv = document.getElementById('tag-merge-warning');
    const warningText = document.getElementById('tag-merge-warning-text');

    const srcId = document.getElementById('tag-merge-src-id').value;
    const destId = document.getElementById('tag-merge-dest').value;

    if (!srcId || !destId) {
        warningDiv.classList.add('d-none');
        return;
    }

    const srcTag = findTag(parseInt(srcId));
    const destTag = findTag(parseInt(destId));

    if (srcTag && srcTag.children && srcTag.children.length > 0 && destTag) {
        const childCount = srcTag.children.length;
        warningText.textContent = gettext("This tag has %(count)s child tag(s) that will be moved to \"%(dest)s\".", {count: childCount, dest: destTag.path});
        warningDiv.classList.remove('d-none');
    } else {
        warningDiv.classList.add('d-none');
    }
}

const mergeSelectDropdown = document.getElementById('tag-hierarchy-merge-select');
if (mergeSelectDropdown) {
    mergeSelectDropdown.addEventListener('click', function(e) {
        if (e.target.classList.contains('dropdown-item')) {
            setTimeout(updateMergeWarning, 50);
        }
    });
}

// Merge modal submit button
document.getElementById('tag-merge-form').addEventListener('submit', function (e) {
    e.preventDefault();

    let tag_src = document.getElementById('tag-merge-src-id').value;
    if (!tag_src) return;
    tag_src = parseInt(tag_src);

    let tag_dest = document.getElementById('tag-merge-dest').value;
    if (!tag_dest) return;
    tag_dest = parseInt(tag_dest);

    if (tag_src === tag_dest) {
        showAlert(gettext("Couldn't merge tags!"))
        return
    }

    const callbackSuccess = (result) => {
        log("Tag merge posted");
        $(document.getElementById('tag-merge-modal')).modal('hide');
    };

    const callbackFail = (error) => {
        log("Failed to merge tags", 'error', {error});
        showAlert(`${gettext("Couldn't merge tags!")} \n \n`, 'error', {error})
    };

    submitTagMerge(tag_src, tag_dest, callbackSuccess, callbackFail);
});


/*
 * Add highlight
 */

const highlight_add_modal = document.getElementById('highlight-add-modal');

// Updates current_selection and visibility of the controls
function selectionChanged() {
    current_selection = describeSelection();
    log('current selection offset : ' + current_selection);
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
    document.getElementById('hlinfo').style.display = 'none';
    document.getElementById('highlight-add-id').value = '';
    document.getElementById('highlight-add-start').value = selection[0];
    document.getElementById('highlight-add-end').value = selection[1];
    highlightModalReset();
    $(highlight_add_modal).modal('show').drags({handle: '.modal-header'});
}

function editHighlight() {
    const selection = describeSelection();
    if(selection) {
        createHighlight(selection);
        return;
    }
    highlightModalReset();
    const id = this.getAttribute('data-highlight-id');
    document.getElementById('highlight-add-id').value = id;
    document.getElementById('highlight-add-start').value = highlights[id].start_offset;
    document.getElementById('highlight-add-end').value = highlights[id].end_offset;
    const hl_tags = highlights['' + id].tags;
    const allNodes = treeview_tags_highlight.treeview('getEnabled');
    for (let i = 0; i < hl_tags.length; ++i) {
        highlightSelectedTags.push(hl_tags[i]);
        const node = allNodes.find((node) => node.id === hl_tags[i]);
        treeview_tags_highlight.treeview('selectNode', node.nodeId);
    }
    showHighlightTagSelection();
    $(highlight_add_modal).modal('show').drags({handle: '.modal-header'});
}

$('#highlight-add-form').off().on('submit', (e) => {

    e.preventDefault();

    const highlight_id = document.getElementById('highlight-add-id').value;
    const selection = [parseInt(document.getElementById('highlight-add-start').value), parseInt(document.getElementById('highlight-add-end').value)];

    const selectedTags = highlightSelectedTags;

    const hl_tags = selectedTags;

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
    elem.innerHTML = '<div class="col-md-4 text-center">' +
        '  <i class="fas fa-user fa-2x"></i>' +
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
        (is_self ? '<button type="button" style="height: 35px" class="btn btn-danger col-md-4 form-group">Leave project</button>' :
            '<button type="button" style="height: 35px" class="btn btn-danger col-md-4 form-group"' + (can_edit ? '' : ' disabled') + '>Remove collaborator</button>') +
        '<hr class="custom-hr" />';

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

     // $(members_modal).modal('show');
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

function loadDocument(document_id, highlight_id = null, splitParagraphs = true, search_text = null) {
    loadDocumentHighlights(document_id, highlight_id, splitParagraphs, search_text);
}

function disableEditing(element) {
    element.addEventListener('keydown', function (event) {
        event.preventDefault();
    });
    element.addEventListener('paste', function (event) {
        event.preventDefault();
    });
    element.addEventListener('input', function (event) {
        event.preventDefault();
    });
}

function addDragFunctionality(element) {
    element.addEventListener('dragstart', function (event) {
        event.dataTransfer.effectAllowed = 'move';
    });
}

function scrollToHighlight(highlight_id, search_text=null) {
    window.setTimeout(function () {
        let scroll_position = 0,
            toolbar_height = $("#document-view").prev(".toolbar-container").outerHeight();
        // Find highlight position and go to it
        if (highlight_id !== null && !isNaN(highlight_id)) {
            const hl = highlights['' + highlight_id];
            const container = document.getElementById('highlight-content');
            if (hl && container) {
                const textNodes = collectTextNodes(container);
                const { fullText, charMap } = buildCharMap(textNodes);
                const startChar = getCharIndexFromUTF8Index(fullText, hl.start_offset);
                const endChar = getCharIndexFromUTF8Index(fullText, hl.end_offset);
                const startEntry = charMap[Math.max(0, startChar)];
                const endEntry = charMap[Math.min(charMap.length - 1, endChar - 1)];

                if (startEntry && endEntry) {
                    const range = document.createRange();
                    range.setStart(startEntry.node, startEntry.offset);
                    range.setEnd(endEntry.node, endEntry.offset + 1);

                    const rects = range.getClientRects();
                    if (rects.length > 0) {
                        scroll_position = rects[0].top + window.scrollY - 25;
                    }

                    // Flash only the block elements that contain the highlighted text
                    const startBlock = startEntry.node.parentElement.closest('p, .document-chunk');
                    const endBlock = endEntry.node.parentElement.closest('p, .document-chunk');
                    if (startBlock) startBlock.classList.add('flash-once');
                    if (endBlock && endBlock !== startBlock) endBlock.classList.add('flash-once');
                }
            }
        }

        if(search_text !== null) {
            search_text = decodeURI(search_text.toLowerCase());
            let lastIndex = search_text.lastIndexOf('/'),
                position = parseInt(search_text.substring(lastIndex+1));
            search_text = search_text.substring(0, lastIndex);
            log(`Go to ${position+1} occurence of ${search_text}`);

            let elements = $(`*:contains_insensitive("${search_text}")`),
                count= 0,
                nb_occurences_in_container = 0,
                goto = null;
            elements.each(function() {
                if($(this)[0].children.length === 0){
                    if($(this).parents('#document-contents').length) {
                        nb_occurences_in_container = $(this).text().toLowerCase().split(search_text).length - 1;
                        if((position >= count) && (position <= (count + nb_occurences_in_container))) {
                            goto = $(this);
                        }
                        count += nb_occurences_in_container;
                    }
                }
            });
            if(goto) {
                scroll_position = goto.offset().top;
                goto.addClass('flash-once');
            } else {
                log('Text container not found..')
            }
        }
        window.scrollTo({
            top: scroll_position - toolbar_height*3,
            behavior: 'instant'
        });
    }, 0);
}

function updateLinksTarget(document_contents) {
    $("A", document_contents).each(function(){
        $(this).attr('target', '_blank');
    });
}

function updateDocumentExportButton(project_id, document_id) {
    const items = document.querySelectorAll('#document-export-dropdown-menu a');
    for (let i = 0; i < items.length; ++i) {
        const ext = items[i].getAttribute('data-extension');
        if (items[i].getAttribute('data-document') !== 'false') {
            items[i].setAttribute('href', `${base_path}/project/${project_id}/export/document/${document_id}.${ext}`);
            items[i].style.display = '';
        } else {
            items[i].style.display = 'none';
        }
    }
}

function updateDocumentLinkHighlight(current_document) {
    let document_links = document.getElementsByClassName('document-link-current');
    for (let i = document_links.length - 1; i >= 0; --i) {
        document_links[i].classList.remove('document-link-current');
    }
    let document_link = document.getElementById('document-link-' + current_document);
    if (document_link) {
        document_link.classList.add('document-link-current');
    }
    
    // Also update treeview highlighting if the function exists
    if (typeof updateDocumentTreeviewHighlight === 'function') {
        updateDocumentTreeviewHighlight(current_document);
    }
}

function showTagUnderlineTooltip(event, tagId, color) {
    let tooltip = document.getElementById('tag-underline-tooltip');

    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'tag-underline-tooltip';
        document.body.appendChild(tooltip);

        Object.assign(tooltip.style, {
            position: 'fixed',
            padding: '10px',
            background: '#fff',
            border: '2px solid #333',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            fontSize: '13px',
            pointerEvents: 'none',
            zIndex: '10000',
            maxWidth: '300px',
            wordWrap: 'break-word',
            overflowWrap: 'break-word',
        });
    }

    const tag = findTag(tagId);
    if (!tag) return;

    tooltip.innerHTML = `
        <div style="display: flex; gap: 4px; flex-wrap: wrap; max-width: 280px;">
            <div style="
                display: inline-block;
                padding: 4px 8px;
                border-radius: 3px;
                background-color: ${color};
                color: white;
                font-size: 11px;
                max-width: 100%;
                word-wrap: break-word;
                overflow-wrap: break-word;
            ">
                ${tag.path}
            </div>
        </div>
    `;

    tooltip.style.display = 'block';
    tooltip.style.left = (event.clientX + 10) + 'px';
    tooltip.style.top = (event.clientY + 10) + 'px';
}

function hideTagUnderlineTooltip() {
    const tooltip = document.getElementById('tag-underline-tooltip');
    if (tooltip) tooltip.style.display = 'none';
}

/**
 * Collect all text nodes under a DOM element in document order.
 */
function collectTextNodes(node) {
    const textNodes = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
    let n;
    while ((n = walker.nextNode())) {
        textNodes.push(n);
    }
    return textNodes;
}

/**
 * Apply colored SVG underlines to a content div based on tag_ranges.
 * Uses Range.getClientRects() to get pixel positions, then draws SVG lines.
 */
function applyTagUnderlines(contentDiv, tagRanges, principalTagId) {
    if (!tagRanges || tagRanges.length === 0) return;

    // Make contentDiv a positioning context for the SVG overlay
    contentDiv.style.position = 'relative';

    const textNodes = collectTextNodes(contentDiv);
    const fullText = textNodes.map(n => n.nodeValue).join('');
    if (fullText.length === 0) return;

    // Build char index -> { node, offsetInNode } mapping
    const charMap = [];
    for (let tni = 0; tni < textNodes.length; tni++) {
        const nodeText = textNodes[tni].nodeValue;
        for (let j = 0; j < nodeText.length; j++) {
            charMap.push({ node: textNodes[tni], offset: j });
        }
    }

    // Convert UTF-8 byte offsets to char indices
    const ranges = tagRanges.map(tr => ({
        tag_id: tr.tag_id,
        color: tr.color,
        startChar: getCharIndexFromUTF8Index(fullText, tr.start),
        endChar: getCharIndexFromUTF8Index(fullText, tr.end),
    }));

    // Sort by start, then larger ranges first
    ranges.sort((a, b) => a.startChar - b.startChar || (b.endChar - b.startChar) - (a.endChar - a.startChar));

    // Assign lanes for overlapping ranges
    const laneEnds = [];
    const rangeLanes = ranges.map(range => {
        for (let lane = 0; lane < laneEnds.length; lane++) {
            if (laneEnds[lane] <= range.startChar) {
                laneEnds[lane] = range.endChar;
                return lane;
            }
        }
        laneEnds.push(range.endChar);
        return laneEnds.length - 1;
    });

    const totalLanes = laneEnds.length;
    const LINE_HEIGHT = 3;
    const LINE_GAP = 2;
    const BASE_OFFSET = 2;
    const extraSpace = BASE_OFFSET + totalLanes * (LINE_HEIGHT + LINE_GAP);

    // Add bottom padding so SVG lines don't overlap the badges
    contentDiv.style.paddingBottom = extraSpace + 'px';

    // Increase line-height to make room for stacked underlines between text lines
    if (totalLanes > 0) {
        contentDiv.style.lineHeight = (1.6 + totalLanes * 0.3) + 'em';
    }

    // Create SVG overlay
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('tag-underline-svg');
    svg.style.position = 'absolute';
    svg.style.left = '0';
    svg.style.top = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.overflow = 'visible';

    const containerRect = contentDiv.getBoundingClientRect();

    for (let ri = 0; ri < ranges.length; ri++) {
        const range = ranges[ri];
        const lane = rangeLanes[ri];
        if (range.startChar >= range.endChar || range.startChar >= charMap.length) continue;

        const effectiveEnd = Math.min(range.endChar, charMap.length);

        // Create a DOM Range to get bounding rects
        const domRange = document.createRange();
        const startEntry = charMap[range.startChar];
        const endEntry = charMap[effectiveEnd - 1];
        domRange.setStart(startEntry.node, startEntry.offset);
        domRange.setEnd(endEntry.node, endEntry.offset + 1);

        const rects = domRange.getClientRects();

        for (let r = 0; r < rects.length; r++) {
            const rect = rects[r];
            const x = rect.left - containerRect.left;
            const y = rect.bottom - containerRect.top + BASE_OFFSET + lane * (LINE_HEIGHT + LINE_GAP);

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', x);
            line.setAttribute('y1', y + LINE_HEIGHT / 2);
            line.setAttribute('x2', x + rect.width);
            line.setAttribute('y2', y + LINE_HEIGHT / 2);
            line.setAttribute('stroke', range.color);
            line.setAttribute('stroke-width', LINE_HEIGHT);
            line.setAttribute('stroke-linecap', 'round');
            if (range.tag_id !== principalTagId) {
                line.setAttribute('stroke-dasharray', '8 6');
                line.setAttribute('stroke-linecap', 'butt');
            }
            line.classList.add('smooth-stroke');
            line.style.pointerEvents = 'all';
            line.style.cursor = 'pointer';
            line.style.transition = 'stroke-width 0.2s';

            line.addEventListener('mouseenter', function (e) {
                line.setAttribute('stroke-width', LINE_HEIGHT + 2);
                showTagUnderlineTooltip(e, range.tag_id, range.color);
            });
            line.addEventListener('mouseleave', function () {
                line.setAttribute('stroke-width', LINE_HEIGHT);
                hideTagUnderlineTooltip();
            });

            svg.appendChild(line);
        }
    }

    contentDiv.appendChild(svg);
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
            // current_document = null;
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

                // Badge row: doclink + principal left, associated right
                let badgeRow = document.createElement('div');
                badgeRow.className = 'row';

                let leftBadges = document.createElement('div');
                leftBadges.className = 'col-10';

                let doclink = document.createElement('a');
                doclink.className = 'badge badge-primary';
                const documentPath = buildDocumentPath(hl.document_id);
                doclink.textContent = documentPath;
                linkDocument(doclink, hl.document_id, hl.id);
                leftBadges.appendChild(doclink);
                leftBadges.appendChild(document.createTextNode(' '));

                // Separate principal tag from associated tags
                const principalTagInfo = findTag(tag_path);
                const principalTagId = principalTagInfo ? principalTagInfo.id : null;

                let principalTags = [];
                let associatedTags = [];
                hl.tags.forEach(function (tagId) {
                    const tag = findTag(tagId);
                    if (tag) {
                        if (tag.id === principalTagId) {
                            principalTags.push(tag);
                        } else {
                            associatedTags.push(tag);
                        }
                    }
                });

                // Principal tag badge (left)
                for (let j = 0; j < principalTags.length; j++) {
                    let taglink = document.createElement('a');
                    taglink.className = 'badge';
                    taglink.setAttribute('style', `background-color: ${principalTags[j].color}; color: white; font-weight: bold;`);
                    taglink.textContent = principalTags[j].path;
                    leftBadges.appendChild(taglink);
                }

                badgeRow.appendChild(leftBadges);

                // Associated tags (right, outline style)
                if (associatedTags.length > 0) {
                    let rightBadges = document.createElement('div');
                    rightBadges.className = 'col-2 text-end';

                    let label = document.createElement('small');
                    label.textContent = gettext('tags associés :');
                    label.style.color = '#6c757d';
                    label.style.marginRight = '4px';
                    rightBadges.appendChild(label);

                    associatedTags.sort((a, b) => a.path.localeCompare(b.path));
                    for (let j = 0; j < associatedTags.length; j++) {
                        if (j > 0) {
                            rightBadges.appendChild(document.createTextNode(' '));
                        }
                        let taglink = document.createElement('a');
                        taglink.className = 'badge badge-outline-tag';
                        taglink.setAttribute('style',
                            `border: 2px dashed ${associatedTags[j].color}; color: ${associatedTags[j].color}; background: transparent; font-weight: bold;`
                        );
                        taglink.textContent = associatedTags[j].path;
                        rightBadges.appendChild(taglink);
                    }
                    badgeRow.appendChild(rightBadges);
                }

                elem.appendChild(badgeRow);

                document_contents.appendChild(elem);

                // Apply SVG underlines after element is in the DOM (needed for getBoundingClientRect)
                if (hl.tag_ranges && hl.tag_ranges.length > 0) {
                    const principalTag = findTag(tag_path);
                    const principalTagId = principalTag ? principalTag.id : null;
                    applyTagUnderlines(content, hl.tag_ranges, principalTagId);
                }
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
            const  items = document.querySelectorAll('#document-export-dropdown-menu a');
            for (let i = 0; i < items.length; ++i) {
                const ext = items[i].getAttribute('data-extension');
                if (items[i].getAttribute('data-highlights') !== 'false') {
                    items[i].setAttribute('href', base_path + '/project/' + project_id + '/export/highlights/' + encodeURIComponent(tag_path) + '.' + ext,);
                    items[i].style.display = '';
                } else {
                    items[i].style.display = 'none';
                }
            }

            toggleToolbarActions(true)

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
    const _document_url_highlight = new RegExp(`^${escapeRegExp(base_path)}/project/([0-9]+)/document/([0-9]+)(/highlight/([0-9]+))?`);
  //  const _document_url_highlight = new RegExp(`^${escapeRegExp(base_path)}/project/([0-9]+)/document/([0-9]+)(/highlight/([0-9]+))+`),
    const _document_url_search_text = new RegExp(`^${escapeRegExp(base_path)}/project/([0-9]+)/document/([0-9]+)(/search/([^\/]+/[0-9]+))+`);
    // Don't use RegExp literals https://github.com/python-babel/babel/issues/640
    let m = window.location.pathname.match(_document_url_highlight),
        m2 = window.location.pathname.match(_document_url_search_text);
    if (m) {
        let h_id = null;
        if(typeof m[4] !== 'undefined') {
            h_id = parseInt(m[4]);
        }
        loadDocument(parseInt(m[2]), h_id);
    // Or a search in document text
    } else if (m2) {
        let search_text = null;
        if(typeof m2[4] !== 'undefined') {
            search_text = m2[4];
        }
        loadDocument(parseInt(m2[2]), null, true, search_text);
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
            let highlight_id = (e.state.highlight_id !== undefined ) ? e.state.highlight_id : null,
                search_text = (e.state.search_text !== undefined ) ? e.state.search_text : null;
            loadDocument(e.state.document_id, highlight_id, true, search_text);
        } else if (e.state.tag_path !== undefined) {
            loadTag(e.state.tag_path);
        } else {
            loadDocument(null);
        }
    } else {
        loadDocument(null);
    }
};

// documents tab filter
const DOCUMENT_NOT_FOUND_MESSAGE = gettext("No document or collection found");
const alert_document_treeview = $('#alert-title-search');

function filterTitles() {
    const filterText = document.getElementById("input-search-titles").value.toLowerCase();
    alert_document_treeview.addClass('d-none');
    
    if(filterText === '') {
        initDocumentsTreeview();
        return;
    }
    
    const filteredCollections = handleDocumentSearch(filterText);
    
    // Check if there are uncategorized documents that match the search
    let hasUncategorizedMatches = false;
    for (let [docId, document] of Object.entries(documents)) {
        const docCollections = document.collections || [];
        if (docCollections.length === 0 && document.name.toLowerCase().includes(filterText)) {
            hasUncategorizedMatches = true;
            break;
        }
    }
    
    initDocumentsTreeview(filteredCollections);
    
    // Only show "no results" message if there are no filtered collections AND no uncategorized matches
    if (filteredCollections.length === 0 && !hasUncategorizedMatches) {
        alert_document_treeview.removeClass('d-none');
        alert_document_treeview.html(`<strong>${DOCUMENT_NOT_FOUND_MESSAGE}</strong>`);
    }
}

document.getElementById("input-search-titles").addEventListener('input', filterTitles);


/*
 * Attach input change for tag search event
 */
const TAG_NOT_FOUND_MESSAGE = gettext("No tag found");
const alert_tag_treeview = $('#alert-tag-treeview');
const alert_tag_highlight_treeview = $('#alert-tag-highlight-treeview');

document.getElementById('input-search-tags').addEventListener('input', function () {
    const filterText = $(this).val().toLowerCase();
    alert_tag_treeview.addClass('d-none')
    if(filterText === '') {
        initTagsTreeview();
        collapseAllNodes(treeview_tags);
        return;
    }
    const filteredTags = handleSearch(filterText);
    initTagsTreeview(filteredTags);
    expandAllNodes(treeview_tags);
    if (filteredTags.length === 0) {
        alert_tag_treeview.removeClass('d-none')
        alert_tag_treeview.html(`<strong>${TAG_NOT_FOUND_MESSAGE}</strong>`)
    }
});

function saveSelectedNodes(treeview) {
    const selectedNodes = treeview.treeview('getSelected');
    return selectedNodes.map(node => node.id);
}

function restoreSelectedNodes(treeview, savedNodeIds) {
    savedNodeIds.forEach(id => {
        const nodeId = getNodeIdFromTreeviewByTagId(treeview_tags_highlight, id)
        selectNode(treeview_tags_highlight, nodeId);
    });
}

let savedSelections = [];

document.getElementById('input-search-tags-highlight').addEventListener('input', function () {

        const filterText = $(this).val().toLowerCase();
        hideSearchErrorMessage();

        // save selected tags
        const tempSavedSelections = saveSelectedNodes(treeview_tags_highlight);

        tempSavedSelections.forEach(id => {
            if (!savedSelections.includes(id)) {
                savedSelections.push(id);
            }
        });

        const filteredTags = handleSearch(filterText);
        initTagsHighlightTreeview(filteredTags);
        if (filteredTags.length === 0) {
            showSearchErrorMessage();
            alert_tag_highlight_treeview.html(`<strong>${TAG_NOT_FOUND_MESSAGE}</strong>`)
        }

        // Restore tags selections
        restoreSelectedNodes(treeview_tags_highlight, savedSelections);
});

function showSearchErrorMessage() {
    alert_tag_highlight_treeview.removeClass('d-none');
}

function hideSearchErrorMessage() {
    alert_tag_highlight_treeview.addClass('d-none');
}

function updateToggleButtons() {
    const isDesktop = window.innerWidth > 768;

    const leftButton = document.getElementById('toggle-left-panel');
    const rightButton = document.getElementById('toggle-right-panel');

    if (isDesktop) {
        leftButton.querySelector('i').className = 'fas fa-chevron-left';
        rightButton.querySelector('i').className = 'fas fa-chevron-right';
    } else {
        leftButton.querySelector('i').className = 'fas fa-chevron-down';
        rightButton.querySelector('i').className = 'fas fa-chevron-down';
    }
}

document.getElementById('toggle-left-panel').addEventListener('click', function() {
    const leftPanel = document.getElementById('left-panel');
    leftPanel.classList.toggle('reduced-col');
    if (window.innerWidth > 768) {
        adjustMiddlePanelWidth();
    }
});

document.getElementById('toggle-right-panel').addEventListener('click', function() {
    const rightPanel = document.getElementById('right-panel');
    rightPanel.classList.toggle('reduced-col');
    if (window.innerWidth > 768) {
        adjustMiddlePanelWidth();
    }
});

function adjustMiddlePanelWidth() {
    const leftPanel = document.getElementById('left-panel');
    const rightPanel = document.getElementById('right-panel');
    const middlePanel = document.getElementById('middle-panel');

    // Desktop behavior
    if (window.innerWidth > 768) {
        let leftWidth = leftPanel.classList.contains('reduced-col') ? '5%' : '20.8333%';
        let rightWidth = rightPanel.classList.contains('reduced-col') ? '5%' : '20.8333%';
        let middleWidth = `calc(100% - ${leftWidth} - ${rightWidth})`;
        middlePanel.style.setProperty('width', middleWidth, 'important');
    } else {
        // Mobile behavior
        middlePanel.style.setProperty('width', '100%', 'important');
    }

    loadDocument(current_document);
}

document.addEventListener('DOMContentLoaded', () => {

    updateToggleButtons();

    const scrollBtn = document.getElementById('scroll-to-top-button');

    window.addEventListener('scroll', function() {
        if ((window.pageYOffset || document.documentElement.scrollTop) > 300) {
            scrollBtn.classList.remove('d-none');
        } else {
            scrollBtn.classList.add('d-none');
        }
    });

    scrollBtn.addEventListener('click', function() {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    });
});

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

window.addEventListener('resize', debounce(() => {
    // Issue in test
    // loadDocument(current_document);
}, 250));

let scrollPos = 0;
window.addEventListener('scroll', function() {
    let isScrollUp = scrollPos > document.documentElement.scrollTop;
    if(document.documentElement.scrollTop < 150 || isScrollUp) {
        $('body').removeClass('scrolled');
    } else if(!$('body').hasClass('scrolled')) {
        $('body').addClass('scrolled');
    }
    scrollPos = document.documentElement.scrollTop;
});



function editCollection(collectionId) {
    const collection = findCollection(collectionId);
    if (!collection) {
        log('Collection not found:', 'error', {collectionId});
        return;
    }
    
    document.getElementById('collection-add-form').reset();
    document.getElementById('collection-add-id').value = '' + collectionId;
    document.getElementById('collection-add-name').value = collection.name;
    document.getElementById('collection-add-description').value = collection.description || '';

    initCollectionHierarchySelect();
    
    if (collection.parent) {
        document.getElementById('collection-add-parent-id').value = collection.parent;
        const parentCollection = findCollection(collection.parent);
        if (parentCollection) {
            document.getElementById('dropdownMenuButtonCollection').innerText = parentCollection.name;
        }
    } else {
        document.getElementById('collection-add-parent-id').value = '';
        document.getElementById('dropdownMenuButtonCollection').innerText = gettext('None');
    }

    populateDocumentsList(collectionId);
    
    document.getElementById('collection-add-label-new').style.display = 'none';
    document.getElementById('collection-add-label-change').style.display = '';
    document.getElementById('collection-add-cancel').style.display = 'none';
    document.getElementById('collection-add-delete').style.display = '';
    
    $('#collection-add-modal').modal('show').drags({handle: '.modal-header'});
}

function deleteCollection(collectionId) {
    const collection = findCollection(collectionId);
    if (!collection) {
        log('Collection not found:', 'error', {collectionId});
        return;
    }
    
    if (collection.children && collection.children.length > 0) {
        showCollectionDeleteOptions(collection);
    } else {
        showConfirm(gettext("Are you sure you want to delete the collection '%(name)s'? Its documents will be moved.", {name: collection.name}), function () {
            deleteURL(`/api/project/${project_id}/collection/${collectionId}`)
                .then(function() {
                })
                .catch(function(error) {
                    log('Error deleting collection:', 'error', {error});
                    showAlert(gettext('Error deleting collection: ') + (error.error || error), 'error');
                });
        }, true);
    }
}

function showCollectionDeleteOptions(collection, successCallback = null) {
    const message = gettext("The collection '%(name)s' has subcollections. How do you want to proceed?", {name: collection.name});
    
    const legend = `
        <div class="alert alert-info mt-3 mb-0">
            <strong>${gettext('Delete all')}:</strong> ${gettext('Deletes this collection and all its subcollections recursively.')}<br>
            <strong>${gettext('Delete only')}:</strong> ${gettext('Deletes only this collection. Subcollections will become root collections (parent removed).')}
        </div>
    `;
    
    $('#confirmMessage').html(message + legend);
    $('#confirmModalLabel').text(gettext('Delete collection'));
    
    const originalFooter = $('#confirmModal .modal-footer').html();
    
    const customFooter = `
        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">${gettext('Cancel')}</button>
        <button type="button" class="btn btn-danger" id="deleteAllButton">${gettext('Delete all')}</button>
        <button type="button" class="btn btn-warning" id="deleteOnlyButton">${gettext('Delete only')}</button>
    `;
    
    $('#confirmModal .modal-footer').html(customFooter);
    $('#confirmModal').modal('show');
    
    $('#deleteAllButton, #deleteOnlyButton').off('click');
    
    $('#deleteAllButton').on('click', function() {
        $('#confirmModal').modal('hide');
        deleteURL(`/api/project/${project_id}/collection/${collection.id}`, {delete_mode: 'cascade'})
            .then(function() {
                log('Collection and children deleted successfully');
                if (successCallback) {
                    successCallback();
                }
            })
            .catch(function(error) {
                log('Error deleting collection:', 'error', {error});
                showAlert(gettext('Error deleting collection: ') + (error.error || error), 'error');
            });
        $('#confirmModal .modal-footer').html(originalFooter);
    });
    
    $('#deleteOnlyButton').on('click', function() {
        $('#confirmModal').modal('hide');
        deleteURL(`/api/project/${project_id}/collection/${collection.id}`, {delete_mode: 'orphan'})
            .then(function() {
                log('Collection deleted, children orphaned successfully');
                if (successCallback) {
                    successCallback();
                }
            })
            .catch(function(error) {
                log('Error deleting collection:', 'error', {error});
                showAlert(gettext('Error deleting collection: ') + (error.error || error), 'error');
            });
        $('#confirmModal .modal-footer').html(originalFooter);
    });
    
    $('#confirmModal').on('hidden.bs.modal', function() {
        $('#confirmModal .modal-footer').html(originalFooter);
        $('#confirmModal').off('hidden.bs.modal');
    });
}

function removeCollectionParent(collectionId) {
    const collection = findCollection(collectionId);
    if (!collection) {
        log('Collection not found:', 'error', {collectionId});
        return;
    }
    
    if (!collection.parent) {
        log('Collection has no parent to remove:', 'warn', {collectionId});
        return;
    }
    
    const parentCollection = findCollection(collection.parent);
    const parentName = parentCollection ? parentCollection.name : '';
    
    showConfirm(gettext("Are you sure you want to remove collection '%(name)s' from parent '%(parent)s'?", {name: collection.name, parent: parentName}), function () {
        const data = {
            name: collection.name,
            description: collection.description || '',
            document_ids: collection.document_ids || [],
            parent_id: null
        };
        
        const url = `/api/project/${project_id}/collection/${collectionId}`;
        
        postJSON(url, data)
            .then(function(response) {
                log('Collection parent removed successfully');
            })
            .catch(function(error) {
                log('Error removing collection parent:', 'error', {error});
                showAlert(gettext('Error removing collection parent: ') + (error.error || error), 'error');
            });
    }, true);
}

function createChildCollection(parentId) {
    const parentCollection = findCollection(parentId);
    if (!parentCollection) {
        log('Parent collection not found:', 'error', {parentId});
        return;
    }

    initCollectionHierarchySelect();
    resetCollectionUI();
    
    document.getElementById('collection-add-form').reset();
    document.getElementById('collection-add-id').value = '';
    
    document.getElementById('collection-add-parent-id').value = parentId;
    document.getElementById('dropdownMenuButtonCollection').innerText = parentCollection.name;

    populateDocumentsList();
    
    document.getElementById('collection-add-label-new').style.display = '';
    document.getElementById('collection-add-label-change').style.display = 'none';
    document.getElementById('collection-add-cancel').style.display = '';
    document.getElementById('collection-add-delete').style.display = 'none';
    
    $('#collection-add-modal').modal('show').drags({handle: '.modal-header'});
}

const collection_add_modal = document.getElementById('collection-add-modal');

function createCollection() {
    document.getElementById('collection-add-form').reset();
    document.getElementById('collection-add-id').value = '';
    
    initCollectionHierarchySelect();
    
    populateDocumentsList();

    document.getElementById('collection-add-label-new').style.display = '';
    document.getElementById('collection-add-label-change').style.display = 'none';
    document.getElementById('collection-add-cancel').style.display = '';
    document.getElementById('collection-add-delete').style.display = 'none';

    resetCollectionUI();
    
    $('#collection-add-modal').modal('show').drags({handle: '.modal-header'});
}

    $('#collection-add-form').on('submit', function(e) {
        e.preventDefault();
        const collectionId = $('#collection-add-id').val();
        const name = $('#collection-add-name').val().trim();
        const description = $('#collection-add-description').val().trim();
        const parentId = $('#collection-add-parent-id').val();
        
        if (!name) {
            showAlert(gettext('Collection name is required'), 'error');
            return;
        }
        
        if (collectionId && parentId && parseInt(collectionId, 10) === parseInt(parentId, 10)) {
            showAlert(gettext('A collection cannot be its own parent.'), 'error');
            return;
        }
        
        const selectedDocs = Array.from(selectedDocuments);
        
        const data = {
            name: name,
            description: description,
            document_ids: selectedDocs,
            parent_id: parentId || null
        };
        
        let url;
        if (collectionId) {
            url = `/api/project/${project_id}/collection/${collectionId}`;
            method = 'POST';
        } else {
            url = `/api/project/${project_id}/collection/new`;
            method = 'POST';
        }
        
        postJSON(url, data)
            .then(function(response) {
                $('#collection-add-modal').modal('hide');
                $('#collection-add-form')[0].reset();
            })
            .catch(function(error) {
                const errorMsg = collectionId ? 
                    gettext('Error updating collection: ') : 
                    gettext('Error creating collection: ');
                showAlert(errorMsg + (error.error || error), 'error');
            });
    });
    

    $('#collection-add-delete').on('click', function(e) {
        e.preventDefault();
        const collectionId = $('#collection-add-id').val();
        if (!collectionId) return;
        
        const collection = findCollection(parseInt(collectionId));
        if (!collection) return;
        
        if (collection.children && collection.children.length > 0) {
            showCollectionDeleteOptions(collection, function() {
                $('#collection-add-modal').modal('hide');
                $('#collection-add-form')[0].reset();
                showAlert(gettext('Collection deleted!'), 'success');
            });
        } else {
            showConfirm(gettext("Are you sure you want to delete the collection '%(name)s'? Its documents will be moved.", {name: collection.name}), function() {
                deleteURL(`/api/project/${project_id}/collection/${collectionId}`)
                    .then(function() {
                        $('#collection-add-modal').modal('hide');
                        $('#collection-add-form')[0].reset();
                        showAlert(gettext('Collection deleted!'), 'success');
                    })
                    .catch(function(error) {
                        showAlert(gettext('Error deleting collection: ') + (error.error || error), 'error');
                    });
            }, true);
        }
    });

    $('#collection-reset-selection').on('click', function(e) {
        e.preventDefault();
        if (typeof resetDocumentSelection === 'function') {
            resetDocumentSelection();
        }
    });

function handleDocumentSearch(filterText) {
    function searchInChildren(item) {
        const filteredChildren = [];

        item.children.forEach(child => {
            const childMatches = child.name.toLowerCase().includes(filterText);
            const childDocumentMatches = searchInDocuments(child);
            const matchingChildren = searchInChildren(child);

            if (childMatches || childDocumentMatches.length > 0 || matchingChildren.length > 0) {
                filteredChildren.push({
                    ...child,
                    document_ids: childMatches ? child.document_ids : childDocumentMatches.map(doc => doc.document_id),
                    children: matchingChildren
                });
            }
        });

        return filteredChildren;
    }

    function searchInDocuments(item) {
        const matchingDocuments = [];
        
        if (item.document_ids && item.document_ids.length > 0) {
            for (let docId of item.document_ids) {
                const document = documents[docId.toString()];
                if (document && document.name.toLowerCase().includes(filterText)) {
                    matchingDocuments.push({
                        id: 'document_' + docId,
                        text: document.name,
                        icon: 'fas fa-file-alt',
                        selectable: false,
                        document_id: parseInt(docId)
                    });
                }
            }
        }
        
        return matchingDocuments;
    }

    return collections
        .map(item => {
            const collectionMatches = item.name.toLowerCase().includes(filterText);
            const documentMatches = searchInDocuments(item);
            const filteredChildren = searchInChildren(item);

            // Keep the collection if it matches OR if it has matching children OR if it has matching documents
            if (collectionMatches || documentMatches.length > 0 || filteredChildren.length > 0) {
                return {
                    ...item,
                    document_ids: collectionMatches ? item.document_ids : documentMatches.map(doc => doc.document_id),
                    children: filteredChildren
                };
            }

            return null;
        })
        .filter(item => item !== null);
}
