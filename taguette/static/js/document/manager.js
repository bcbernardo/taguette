
let current_document = null;
let current_tag = null;
let last_added_tag = null;
const documents_list = document.getElementById('documents-list');

function linkDocument(elem, doc_id, highlight_id=null, search_text=null) {
    let url = `${base_path}/project/${project_id}/document/${doc_id}`;
    if(highlight_id !== null && !isNaN(highlight_id)) {
        url += `/highlight/${highlight_id}`;
    }
    if(search_text !== null) {
        url += `/search/${search_text}`;
    }
    elem.setAttribute('href', url);
    elem.addEventListener('click', function (e) {
        e.preventDefault();
        window.history.pushState({document_id: doc_id, highlight_id: highlight_id, search_text: search_text}, "Document " + doc_id, url);
        loadDocument(doc_id, highlight_id, true, search_text);
        if(highlight_id !== null && !isNaN(highlight_id)) {
            const tags_return = $('#tag-selection-return'),
                tags_return_link = $('a', tags_return);
            tags_return_link.show();
        }
    });
}

function updateDocumentsList() {

    generateDocumentSelectPicker();

    if(typeof addEventListenerToOption === "function") {
        addEventListenerToOption()
    }
    
    // Update documents treeview if the function exists
    if (typeof initDocumentsTreeview === 'function') {
        initDocumentsTreeview();
    }
}

function toggleFavorite(documentId) {
    const favoriteIcon = document.querySelector(`#favorite-icon-${documentId}`);
    const updatedDocument = {
        id: parseInt(documentId),
        favorite: favoriteIcon.classList.contains('far')
    };
    
    submitDocumentUpdate(updatedDocument, function(response) {
        // Update documents list and treeview after successful update
        updateDocumentsList();
        
        // Find and expand the parent collection after treeview is fully reconstructed
        if (typeof findDocumentParentCollection === 'function' && typeof expandDocumentNode === 'function') {
            setTimeout(function() {
                const parentCollectionNodeId = findDocumentParentCollection(documentId);
                if (parentCollectionNodeId) {
                    expandDocumentNode(treeview_documents, parentCollectionNodeId);
                }
            }, 100);
        }
    }, function(error) {
        console.error('Error updating document favorite:', error);
    });
}

function generateDocumentList() {
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
        let favoriteIconClass = doc.favorite === true ? 'fas fa-star' : 'far fa-star';
        let favoriteTitle = doc.favorite === true ? gettext("Remove from Favorites") : gettext("Add to Favorites");
        elem.innerHTML = `
        <div class="d-flex justify-content-between align-items-center">
            <a class="document-link-a text-truncate" style="flex: 1; margin-right: 10px;" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</a>
            <div class="d-flex flex-shrink-0">
                <a href="javascript:editDocument(${doc.id});" class="btn btn-primary btn-sm rounded-1 me-2">
                    <i class="fas fa-edit" aria-hidden="true"></i>
                </a>
                <a href="javascript:toggleFavorite(${doc.id});" class="favorite-icon" title="${favoriteTitle}">
                    <i id="favorite-icon-${doc.id}" class="${favoriteIconClass}" aria-hidden="true"></i> 
                </a>
            </div>
        </div>`;
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

function generateDocumentSelectPicker() {

    const dropdown = document.getElementById('select-dropdown');

    // Empty the list
    while (dropdown.firstChild) {
        dropdown.removeChild(dropdown.firstChild);
    }

    // Fill up the list again
    let createListItem = document.createElement('li');
    createListItem.setAttribute('role', 'option');
    createListItem.setAttribute('data-test-id', 'create-document-link');
    createListItem.classList.add('create-document-option');
    const labelImportNewDocument = gettext('Import new document');
    createListItem.innerHTML = `<a href="javascript:createDocument()">${labelImportNewDocument}</a>`;

    dropdown.appendChild(createListItem);

    const entries = Object.entries(documents);
    sortByKey(entries, function(e) {
        return e[1].name;
    });

    // keep only favorites
    entries.forEach(([key, doc]) => {

        if (doc.favorite !== true) {
            return;
        }

        let listItem = document.createElement('li');
        listItem.setAttribute('role', 'option');

        let input = document.createElement('input');
        input.setAttribute('type', 'radio');
        input.setAttribute('id', 'doc-' + doc.id);
        input.setAttribute('name', 'document');

        let label = document.createElement('label');
        label.setAttribute('for', 'doc-' + doc.id);
        label.innerHTML = `${escapeHtml(doc.name)}`;

        listItem.appendChild(input);
        listItem.appendChild(label);

        dropdown.appendChild(listItem);
    });
    console.log("Documents list in dropdown updated");
}

function submitDocumentUpdate(document, callbackSuccess, callbackFail) {

    const { id } = document;

    let request;

    if (id) {
        console.log(`Posting update for document ${id}`);
        request = postJSON(`/api/project/${project_id}/document/${id}`, document);
    }

    showSpinner();
    request.then(function (response) {
        callbackSuccess(response);
    }).catch(function (error) {
        callbackFail(error);
    }).finally(hideSpinner);
}

function addDocument(document) {
    // Save old collections for document updates
    const oldCollections = documents['' + document.id]?.collections || [];
    
    documents['' + document.id] = document;
    
    // Update collections
    const newCollections = document.collections || [];
    
    // Remove from old collections
    for (let collectionId of oldCollections) {
        const collection = findCollection(parseInt(collectionId));
        if (collection && collection.document_ids) {
            const index = collection.document_ids.indexOf(document.id);
            if (index !== -1) {
                collection.document_ids.splice(index, 1);
            }
        }
    }
    
    // Add to new collections
    for (let collectionId of newCollections) {
        const collection = findCollection(parseInt(collectionId));
        if (collection) {
            if (!collection.document_ids) {
                collection.document_ids = [];
            }
            if (!collection.document_ids.includes(document.id)) {
                collection.document_ids.push(document.id);
            }
        }
    }
    
    updateDocumentsList();
    initDocumentsTreeview();
    
    // Expand parent collection and highlight new document
    if (document.collections && document.collections.length > 0) {
        const parentCollectionId = document.collections[0];
        expandDocumentNodeParent(parentCollectionId);
    }
    highlightDocument(document.id);
}

function flattenCollections(collectionsTree) {
    const flat = {};
    
    function addToFlat(nodes) {
        for (let node of nodes) {
            flat[node.id] = node;
            if (node.children && node.children.length > 0) {
                addToFlat(node.children);
            }
        }
    }
    
    addToFlat(collectionsTree);
    return flat;
}

function removeDocument(document_id) {
    // Remove from collections
    const document = documents['' + document_id];
    if (document && document.collections) {
        for (let collectionId of document.collections) {
            const collection = findCollection(parseInt(collectionId));
            if (collection && collection.document_ids) {
                const index = collection.document_ids.indexOf(parseInt(document_id));
                if (index !== -1) {
                    collection.document_ids.splice(index, 1);
                }
            }
        }
    }
    
    delete documents['' + document_id];
    updateDocumentsList();
    initDocumentsTreeview();
    
    // Expand parent collection to show the change
    if (document && document.collections && document.collections.length > 0) {
        const parentCollectionId = document.collections[0];
        expandDocumentNodeParent(parentCollectionId);
    }
    
    if (current_document === document_id) {
        window.history.pushState({}, "Project", base_path + '/project/' + project_id);
        loadDocument(null);
    }
}

function buildDocumentPath(documentId) {
    const document = documents['' + documentId];
    if (!document) return null;
    
    let path = document.name;
    
    if (document.collections && document.collections.length > 0) {
        const collectionId = document.collections[0];
        const collectionPath = buildCollectionPath(collectionId);
        if (collectionPath) {
            path = collectionPath + ' > ' + document.name;
        }
    }
    
    return path;
}

function buildCollectionPath(collectionId) {
    const collection = findCollection(collectionId);
    if (!collection) return null;
    
    let path = collection.name;
    let currentCollection = collection;
    
    while (currentCollection.parent) {
        const parentCollection = findCollection(currentCollection.parent);
        if (parentCollection) {
            path = parentCollection.name + ' > ' + path;
            currentCollection = parentCollection;
        } else {
            break;
        }
    }
    
    return path;
}

updateDocumentsList();