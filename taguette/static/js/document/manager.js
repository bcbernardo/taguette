
let current_document = null;
let current_tag = null;
let last_added_tag = null;
// const documents_list = document.getElementById('documents-list');

function linkDocument(elem, doc_id, highlight_id=null) {
    let url = `${base_path}/project/${project_id}/document/${doc_id}`;
    if(highlight_id !== null && !isNaN(highlight_id)) {
        url += `/highlight/${highlight_id}`;
    }
    elem.setAttribute('href', url);
    elem.addEventListener('click', function (e) {
        e.preventDefault();
        window.history.pushState({document_id: doc_id, highlight_id: highlight_id}, "Document " + doc_id, url);
        loadDocument(doc_id, highlight_id);
        if(highlight_id !== null && !isNaN(highlight_id)) {
            const tags_return = $('#tag-selection-return'),
                tags_return_link = $('a', tags_return);
            tags_return_link.show();
        }
    });
}

function updateDocumentsList() {
    const dropdown = document.getElementById('select-dropdown');

    // Vider la liste déroulante
    while (dropdown.firstChild) {
        dropdown.removeChild(dropdown.firstChild);
    }

    // Ajouter l'option de création de document au début de la liste déroulante
    let createListItem = document.createElement('li');
    createListItem.setAttribute('role', 'option');
    createListItem.setAttribute('data-test-id', 'create-document-link');
    createListItem.classList.add('create-document-option');
    createListItem.innerHTML = `<a href="javascript:createDocument()">Create New Document</a>`;
    dropdown.appendChild(createListItem);

    // Générer de nouveaux éléments pour la liste déroulante
    const entries = Object.entries(documents);
    sortByKey(entries, function(e) {
        return e[1].name;
    });

    entries.forEach(([key, doc]) => {
        let listItem = document.createElement('li');
        listItem.setAttribute('role', 'option');

        let input = document.createElement('input');
        input.setAttribute('type', 'radio');
        input.setAttribute('id', 'doc-' + doc.id);
        input.setAttribute('name', 'document');

        //Todo : update
        if (doc.id === current_document) {
            console.log('do action')
        }

        let label = document.createElement('label');
        label.setAttribute('for', 'doc-' + doc.id);
        label.innerHTML = `${escapeHtml(doc.name)}`;

        listItem.appendChild(input);
        listItem.appendChild(label);

        dropdown.appendChild(listItem);
    });

    console.log("Documents list in dropdown updated");

    if(typeof addEventListenerToOption === "function") {
        addEventListenerToOption()
    }
}

updateDocumentsList();