
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
        window.history.pushState({document_id: doc_id, highlight_id: highlight_id}, "Document " + doc_id, url);
        loadDocument(doc_id, highlight_id, search_text);
        if(highlight_id !== null && !isNaN(highlight_id)) {
            const tags_return = $('#tag-selection-return'),
                tags_return_link = $('a', tags_return);
            tags_return_link.show();
        }
    });
}

function updateDocumentsList() {

    generateDocumentSelectPicker();
    generateDocumentList();

    if(typeof addEventListenerToOption === "function") {
        addEventListenerToOption()
    }
}

function toggleFavorite(documentId) {
    const favoriteIcon = document.querySelector(`#favorite-icon-${documentId}`);
    const updatedDocument = {
        id: parseInt(documentId),
        favorite: favoriteIcon.classList.contains('far')
    };
    submitDocumentUpdate(updatedDocument, ()=>{}, ()=>{})
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
            <a class="document-link-a">${escapeHtml(doc.name)}</a>
            <a href="javascript:toggleFavorite(${doc.id});" class="favorite-icon" title="${favoriteTitle}">
                <i id="favorite-icon-${doc.id}" class="${favoriteIconClass}" aria-hidden="true"></i> 
            </a>
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
    const labelImportNewDocument =gettext('Import new document')
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

updateDocumentsList();


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