
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
        log('Error updating document favorite:', 'error', error);
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
}

function submitDocumentUpdate(document, callbackSuccess, callbackFail) {

    const { id } = document;

    let request;

    if (id) {
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


// ADD COLLECTION WITH SELECTED DOCUMENTS
let selectedDocuments = new Set();
let originalSelectedDocuments = new Set();

function resetCollectionUI() {
    selectedDocuments.clear();
    originalSelectedDocuments.clear();
    
    const searchInput = document.getElementById('collection-documents-search');
    if (searchInput) {
        searchInput.value = '';
    }
    
    updateSelectedDocumentsDisplay();
    
    const form = document.getElementById('collection-add-form');
    if (form) {
        form.reset();
    }
}

function populateDocumentsList(collectionId = null) {
    const docListDiv = document.getElementById('collection-add-documents-list');
    docListDiv.innerHTML = '';
    
    if (collectionId) {
        const collection = findCollection(parseInt(collectionId));
        if (collection && collection.document_ids) {
            selectedDocuments.clear();
            originalSelectedDocuments.clear();
            collection.document_ids.forEach(docId => {
                selectedDocuments.add(docId);
                originalSelectedDocuments.add(docId);
            });
        }
    } else {
        originalSelectedDocuments.clear();
    }
    
    // legend
    const legendDiv = document.createElement('div');
    legendDiv.className = 'mb-3 p-2 bg-light rounded';
    legendDiv.innerHTML = `
        <div class="d-flex align-items-center gap-3">
            <div class="d-flex align-items-center gap-1">
                <i class="fas fa-file-alt text-primary"></i>
                <small>${gettext('Document without collection (will be added)')}</small>
            </div>
            <div class="d-flex align-items-center gap-1">
                <i class="fas fa-folder text-warning"></i>
                <small>${gettext('Document with collection (will be moved)')}</small>
            </div>
        </div>
    `;
    docListDiv.appendChild(legendDiv);
    
    const docEntries = Object.entries(documents);
    docEntries.sort((a, b) => {
        const aCollections = a[1].collections || [];
        const bCollections = b[1].collections || [];
        
        // Sort: documents without collection first, then documents with collection
        if (aCollections.length === 0 && bCollections.length > 0) return -1;
        if (aCollections.length > 0 && bCollections.length === 0) return 1;
        
        // Within same category, sort by name
        return a[1].name.localeCompare(b[1].name);
    });
    
    let availableDocuments = 0;
    
    for (let i = 0; i < docEntries.length; ++i) {
        let doc = docEntries[i][1];
        const docCollections = doc.collections || [];
        
        // Skip selected documents
        if (selectedDocuments.has(doc.id)) {
            continue;
        }
        
        // Get current collection name for documents that have collections
        let currentCollectionName = '';
        if (docCollections.length > 0) {
            const currentCollection = findCollection(docCollections[0]);
            currentCollectionName = currentCollection ? currentCollection.name : '';
        }
        
        availableDocuments++;
        
        let docItem = document.createElement('div');
        docItem.className = 'document-item p-2 mb-1 rounded d-flex align-items-center justify-content-between';
        docItem.dataset.documentId = doc.id;
        
        // Create content div
        const contentDiv = document.createElement('div');
        contentDiv.className = 'd-flex align-items-center gap-2 flex-grow-1';
        
        // Add icon based on collection status
        const iconDiv = document.createElement('div');
        if (docCollections.length === 0) {
            iconDiv.innerHTML = '<i class="fas fa-file-alt text-primary"></i>';
        } else {
            iconDiv.innerHTML = '<i class="fas fa-folder text-warning"></i>';
        }
        
        // Add document name and collection info
        const textDiv = document.createElement('div');
        textDiv.innerHTML = `
            <div class="fw-bold">${doc.name}</div>
            ${currentCollectionName ? `<small class="text-muted">${gettext('Currently in')}: ${currentCollectionName}</small>` : ''}
        `;
        
        contentDiv.appendChild(iconDiv);
        contentDiv.appendChild(textDiv);
        docItem.appendChild(contentDiv);
        
        docItem.addEventListener('click', function() {
            const docId = Number(this.dataset.documentId);
            
            if (selectedDocuments.has(docId)) {
                selectedDocuments.delete(docId);
            } else {
                selectedDocuments.add(docId);
            }
            
            // Update both lists
            updateSelectedDocumentsDisplay();
            populateDocumentsList();
        });
        
        docListDiv.appendChild(docItem);
    }
    
    if (availableDocuments === 0) {
        const noDocsMessage = document.createElement('p');
        noDocsMessage.className = 'text-muted text-center';
        noDocsMessage.textContent = gettext('No documents available');
        docListDiv.appendChild(noDocsMessage);
    }
    
    setupCollectionSearch();
    
    updateSelectedDocumentsDisplay();
}

function setupCollectionSearch() {
    const searchInput = document.getElementById('collection-documents-search');
    if (searchInput) {
        searchInput.removeEventListener('input', handleCollectionSearch);
        searchInput.addEventListener('input', handleCollectionSearch);
    }
}

function handleCollectionSearch() {
    const searchTerm = this.value.toLowerCase();
    const docListDiv = document.getElementById('collection-add-documents-list');
    const docItems = docListDiv.querySelectorAll('.document-item');
    
    docItems.forEach(item => {
        const docId = item.dataset.documentId;
        const doc = documents[docId];
        if (doc) {
            const docName = doc.name.toLowerCase();
            const shouldShow = docName.includes(searchTerm);
            
            if (shouldShow) {
                item.style.setProperty('display', 'block', 'important');
            } else {
                item.style.setProperty('display', 'none', 'important');
            }
        }
    });
}

function updateSelectedDocumentsDisplay() {
    const selectedContainer = document.getElementById('collection-selected-documents');
    const selectedList = document.getElementById('collection-selected-documents-list');
    const resetButton = document.getElementById('collection-reset-selection');
    
    if (selectedDocuments.size === 0) {
        selectedContainer.style.display = 'none';
        if (resetButton) {
            resetButton.style.display = 'none';
        }
        return;
    }
    
    selectedContainer.style.display = 'block';
    if (resetButton) {
        resetButton.style.display = 'inline-block';
    }
    selectedList.innerHTML = '';
    
    selectedDocuments.forEach(docId => {
        const doc = documents[docId];
        const docCollections = doc.collections || [];
        
        let currentCollectionName = '';
        if (docCollections.length > 0) {
            const currentCollection = findCollection(docCollections[0]);
            currentCollectionName = currentCollection ? currentCollection.name : '';
        }
        
        const badge = document.createElement('span');
        badge.className = 'selected-document-badge';
        badge.innerHTML = `
            <div class="d-flex align-items-center gap-1">
                <i class="fas ${docCollections.length === 0 ? 'fa-file-alt text-primary' : 'fa-folder text-warning'}"></i>
                <span>${doc.name}</span>
                <span class="remove-btn" data-document-id="${docId}">×</span>
            </div>
            ${currentCollectionName ? `<small class="text-muted d-block">${gettext('Currently in')}: ${currentCollectionName}</small>` : ''}
        `;
        
        badge.querySelector('.remove-btn').addEventListener('click', function() {
            const docId = Number(this.dataset.documentId);
            selectedDocuments.delete(docId);
            updateSelectedDocumentsDisplay();
            populateDocumentsList();
        });
        
        selectedList.appendChild(badge);
    });
}

function resetDocumentSelection() {
    const collectionId = document.getElementById('collection-add-id')?.value;
    
    if (collectionId && originalSelectedDocuments.size > 0) {
        selectedDocuments.clear();
        originalSelectedDocuments.forEach(docId => {
            selectedDocuments.add(docId);
        });
    } else {
        selectedDocuments.clear();
    }
    
    updateSelectedDocumentsDisplay();
    populateDocumentsList(collectionId || null);
}

// ADD DOCUMENT WITH DISPATCH INTERFACE

function displaySelectedDocuments(files) {
    const container = document.getElementById('document-files-list-container');
    const listDiv = document.getElementById('document-files-list');
    const bulkActionsContainer = document.getElementById('bulk-actions-container');
    
    if (!files || files.length === 0) {
        container.style.display = 'none';
        bulkActionsContainer.style.display = 'none';
        return;
    }
    
    container.style.display = 'block';
    bulkActionsContainer.style.display = 'block';
    listDiv.innerHTML = '';
    
    Array.from(files).forEach((file, index) => {
        const fileItem = document.createElement('div');
        fileItem.className = 'document-file-item d-flex align-items-center justify-content-between p-2 mb-2 border rounded';
        fileItem.dataset.fileIndex = index;
        
        const fileName = document.createElement('div');
        fileName.className = 'd-flex align-items-center flex-grow-1';
        fileName.innerHTML = `
            <i class="fas fa-file-alt me-2 text-muted"></i>
            <span class="file-name">${file.name}</span>
            <small class="text-muted ms-2">(${formatFileSize(file.size)})</small>
        `;
        
        const collectionSelector = document.createElement('div');
        collectionSelector.className = 'collection-selector d-flex align-items-end flex-shrink-0';
        collectionSelector.innerHTML = `
            <select class="form-select form-select-sm me-2" data-file-index="${index}" style="width: 300px;">
                <option value="">${gettext('No collection (root)')}</option>
            </select>
            <button type="button" class="btn btn-outline-primary btn-sm create-new-for-file" data-file-index="${index}" title="${gettext('Create new collection for this file')}" style="width: 32px;">
                <i class="fas fa-plus"></i>
            </button>
        `;
        
        fileItem.appendChild(fileName);
        fileItem.appendChild(collectionSelector);
        listDiv.appendChild(fileItem);
        
        const select = collectionSelector.querySelector('select');
        select.addEventListener('change', function() {
            if (this.dataset.createNew === 'true') {
                resetSelectorStyle(this);
            }
        });
        
        const createNewBtn = collectionSelector.querySelector('.create-new-for-file');
        createNewBtn.addEventListener('click', function() {
            const fileIndex = this.dataset.fileIndex;
            const fileName = file.name;
            showCollectionNameInput(fileIndex, fileName);
        });
    });
    
    populateCollectionOptions();
    populateAssignAllSelect();
    
    setupBulkActions();
}

function populateAssignAllSelect() {
    const assignAllSelect = document.getElementById('assign-all-collection-select');
    if (!assignAllSelect) return;
    
    while (assignAllSelect.children.length > 1) {
        assignAllSelect.removeChild(assignAllSelect.children[1]);
    }
    
    if (typeof collections !== 'undefined' && collections.length > 0) {
        function addCollectionOptions(collectionsList, level = 0) {
            collectionsList.forEach(collection => {
                const option = document.createElement('option');
                option.value = collection.id;
                
                let displayText = '';
                if (level > 0) {
                    displayText = '└─ '.repeat(level) + collection.name;
                } else {
                    displayText = '📁 ' + collection.name;
                }
                
                option.textContent = displayText;
                option.style.paddingLeft = (level * 15) + 'px';
                assignAllSelect.appendChild(option);
                
                if (collection.children && collection.children.length > 0) {
                    addCollectionOptions(collection.children, level + 1);
                }
            });
        }
        
        addCollectionOptions(collections);
    }
}

function populateCollectionOptions() {
    const selectors = document.querySelectorAll('#document-files-list select');
    
    selectors.forEach(select => {
        while (select.children.length > 1) {
            select.removeChild(select.children[1]);
        }
        
        if (typeof collections !== 'undefined' && collections.length > 0) {
            function addCollectionOptions(collectionsList, level = 0) {
                collectionsList.forEach(collection => {
                    const option = document.createElement('option');
                    option.value = collection.id;
                    
                    let displayText = '';
                    if (level > 0) {
                        displayText = '└─ '.repeat(level) + collection.name;
                    } else {
                        displayText = '📁 ' + collection.name;
                    }
                    
                    option.textContent = displayText;
                    option.style.paddingLeft = (level * 15) + 'px';
                    select.appendChild(option);
                    
                    if (collection.children && collection.children.length > 0) {
                        addCollectionOptions(collection.children, level + 1);
                    }
                });
            }
            
            addCollectionOptions(collections);
        }
    });
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function setupBulkActions() {
    const assignAllSelect = document.getElementById('assign-all-collection-select');
    if (assignAllSelect) {
        assignAllSelect.addEventListener('change', function() {
            const selectedValue = this.value;
            const collectionSelectors = document.querySelectorAll('#document-files-list select');
            
            collectionSelectors.forEach(select => {
                select.value = selectedValue;
            });
        });
    }
    
    const resetButton = document.getElementById('reset-all-collections');
    if (resetButton) {
        resetButton.addEventListener('click', function() {
            assignAllSelect.value = '';
            
            const collectionSelectors = document.querySelectorAll('#document-files-list select');
            collectionSelectors.forEach(select => {
                select.value = '';
                resetSelectorStyle(select);
            });
        });
    }
    
    document.getElementById('create-new-collection-for-all').addEventListener('click', function() {
        showGlobalCollectionNameInput();
    });
}

function resetSelectorStyle(select) {
    select.style.backgroundColor = '';
    select.style.fontStyle = '';
    delete select.dataset.createNew;
    delete select.dataset.newCollectionName;
    
    const parentDiv = select.closest('.collection-selector');
    const indicator = parentDiv.querySelector('.new-collection-indicator');
    if (indicator) {
        indicator.remove();
    }
    const inputContainer = parentDiv.querySelector('.collection-name-input-container');
    if (inputContainer) {
        inputContainer.remove();
    }
}

function showCollectionNameInput(fileIndex, fileName) {
    const fileItem = document.querySelector(`[data-file-index="${fileIndex}"]`);
    if (!fileItem) return;
    
    const existingInput = fileItem.querySelector('.collection-name-input-container');
    if (existingInput) {
        existingInput.remove();
    }
    
    const inputContainer = document.createElement('div');
    inputContainer.className = 'collection-name-input-container mt-2 p-3 border rounded bg-light';
    inputContainer.innerHTML = `
        <div class="d-flex align-items-center gap-2 mb-2">
            <i class="fas fa-plus-circle text-primary"></i>
            <label class="form-label mb-0 fw-bold text-primary">${gettext('New collection name:')}</label>
        </div>
        <div class="d-flex gap-2">
            <input type="text" class="form-control collection-name-input" 
                   placeholder="Collection for ${fileName}" value="Collection for ${fileName}">
            <button type="button" class="btn btn-success confirm-collection-name" title="${gettext('Confirm')}">
                <i class="fas fa-check me-1"></i>${gettext('Create')}
            </button>
            <button type="button" class="btn btn-outline-secondary cancel-collection-name" title="${gettext('Cancel')}">
                <i class="fas fa-times me-1"></i>${gettext('Cancel')}
            </button>
        </div>
    `;
    
    fileItem.insertAdjacentElement('afterend', inputContainer);
    
    const input = inputContainer.querySelector('.collection-name-input');
    input.focus();
    input.select();
    
    const confirmBtn = inputContainer.querySelector('.confirm-collection-name');
    const cancelBtn = inputContainer.querySelector('.cancel-collection-name');
    
    const confirmAction = () => {
        const collectionName = input.value.trim();
        if (collectionName) {
            applyNewCollectionToFile(fileIndex, collectionName);
        }
        inputContainer.remove();
    };
    
    const cancelAction = () => {
        inputContainer.remove();
    };
    
    confirmBtn.addEventListener('click', confirmAction);
    cancelBtn.addEventListener('click', cancelAction);
    
    // Enter pour confirmer, Escape pour annuler
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            confirmAction();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelAction();
        }
    });
}

function applyNewCollectionToFile(fileIndex, collectionName) {
    const targetSelect = document.querySelector(`#document-files-list select[data-file-index="${fileIndex}"]`);
    if (targetSelect) {
        resetSelectorStyle(targetSelect);
        
        targetSelect.dataset.newCollectionName = collectionName;
        targetSelect.dataset.createNew = 'true';
        targetSelect.value = '';
        
        targetSelect.style.backgroundColor = '#e3f2fd';
        targetSelect.style.fontStyle = 'italic';
        
        const parentDiv = targetSelect.closest('.collection-selector');
        let indicator = parentDiv.querySelector('.new-collection-indicator');
        if (!indicator) {
            indicator = document.createElement('small');
            indicator.className = 'new-collection-indicator text-primary mt-1';
            indicator.style.display = 'block';
            indicator.style.position = 'absolute';
            indicator.style.fontSize = '0.75rem';
            indicator.style.marginTop = '2px';
            parentDiv.style.position = 'relative';
            parentDiv.appendChild(indicator);
        }
        indicator.textContent = `→ ${collectionName}`;
    }
}

function showGlobalCollectionNameInput() {
    const bulkActionsContainer = document.getElementById('bulk-actions-container');
    if (!bulkActionsContainer) return;
    
    const existingInput = bulkActionsContainer.querySelector('.global-collection-input-container');
    if (existingInput) {
        existingInput.remove();
    }
    
    const inputContainer = document.createElement('div');
    inputContainer.className = 'global-collection-input-container mt-3 p-3 border rounded bg-primary bg-opacity-10';
    inputContainer.innerHTML = `
        <div class="d-flex align-items-center gap-2 mb-2">
            <i class="fas fa-layer-group text-primary"></i>
            <label class="form-label mb-0 fw-bold text-primary">${gettext('Create new collection for all files:')}</label>
        </div>
        <div class="d-flex gap-2">
            <input type="text" class="form-control form-control-sm global-collection-name-input" 
                   placeholder="${gettext('Collection name')}" value="New Collection">
            <button type="button" class="btn btn-success btn-sm confirm-global-collection" title="${gettext('Apply to all')}">
                <i class="fas fa-check"></i> ${gettext('Apply')}
            </button>
            <button type="button" class="btn btn-secondary btn-sm cancel-global-collection" title="${gettext('Cancel')}">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `;
    
    bulkActionsContainer.appendChild(inputContainer);
    
    const input = inputContainer.querySelector('.global-collection-name-input');
    input.focus();
    input.select();
    
    const confirmBtn = inputContainer.querySelector('.confirm-global-collection');
    const cancelBtn = inputContainer.querySelector('.cancel-global-collection');
    
    const confirmAction = () => {
        const collectionName = input.value.trim();
        if (collectionName) {
            applyNewCollectionToAllFiles(collectionName);
        }
        inputContainer.remove();
    };
    
    const cancelAction = () => {
        inputContainer.remove();
    };
    
    confirmBtn.addEventListener('click', confirmAction);
    cancelBtn.addEventListener('click', cancelAction);
    

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            confirmAction();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelAction();
        }
    });
}

function applyNewCollectionToAllFiles(collectionName) {
    const selectors = document.querySelectorAll('#document-files-list select:not(.text-direction-selector)');
    selectors.forEach(select => {
        resetSelectorStyle(select);
        
        select.dataset.newCollectionName = collectionName;
        select.dataset.createNew = 'true';
        select.value = '';
        
        select.style.backgroundColor = '#e3f2fd';
        select.style.fontStyle = 'italic';
        
        const parentDiv = select.closest('.collection-selector');
        let indicator = parentDiv.querySelector('.new-collection-indicator');
        if (!indicator) {
            indicator = document.createElement('small');
            indicator.className = 'new-collection-indicator text-primary mt-1';
            indicator.style.display = 'block';
            indicator.style.position = 'absolute';
            indicator.style.fontSize = '0.75rem';
            indicator.style.marginTop = '2px';
            parentDiv.style.position = 'relative';
            parentDiv.appendChild(indicator);
        }
        indicator.textContent = `→ ${collectionName}`;
    });
}

function cleanupDocumentDispatchInterface() {
    const container = document.getElementById('document-files-list-container');
    const bulkActionsContainer = document.getElementById('bulk-actions-container');
    
    if (container) {
        container.style.display = 'none';
    }
    if (bulkActionsContainer) {
        bulkActionsContainer.style.display = 'none';
    }
    
    const listDiv = document.getElementById('document-files-list');
    if (listDiv) {
        listDiv.innerHTML = '';
    }
    
    const globalInput = document.querySelector('.global-collection-input-container');
    if (globalInput) {
        globalInput.remove();
    }
    
}

document.addEventListener('DOMContentLoaded', function() {
    const fileInput = document.getElementById('document-add-file');
    if (fileInput) {
        fileInput.addEventListener('change', function(e) {
            displaySelectedDocuments(e.target.files);
        });
    }
    
    const modal = document.getElementById('document-add-modal');
    if (modal) {
        $(modal).on('hidden.bs.modal', function() {
            cleanupDocumentDispatchInterface();
        });
    }
});

updateDocumentsList();