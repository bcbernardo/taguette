function addDocumentContextMenu() {
    $.contextMenu({
        selector: '.document-context-menu',
        build: function ($trigger) {
            const nodeId = $trigger.attr('id');
            const documentId = extractDocumentId(nodeId);

            if (!documentId) return false;

            const document = documents[documentId.toString()];
            if (!document) return false;

            let items = generateDocumentContextMenuItems(document);

            return {
                callback: (key, options) => documentContextMenuAction(key, options.$trigger.attr("id")),
                items
            };
        }
    });
}

function generateDocumentContextMenuItems(document) {
    const isFavorite = document.favorite === true;
    const favoriteLabel = isFavorite ? gettext('Remove from Bookmarks') : gettext('Add to Bookmarks');
    const favoriteIcon = isFavorite ? 'fas fa-star' : 'far fa-star';

    const items = {
        "edit": {
            name: gettext('Edit document'),
            icon: "fas fa-edit",
            callback: (key, options) => documentContextMenuAction('edit', document.id)
        },
        "favorite": {
            name: favoriteLabel,
            icon: favoriteIcon,
            callback: (key, options) => documentContextMenuAction('favorite', document.id)
        },
        "separator1": "---------",
        "delete": {
            name: gettext('Delete document'),
            icon: "fas fa-trash",
            callback: (key, options) => documentContextMenuAction('delete', document.id)
        }
    };

    return items;
}

function documentContextMenuAction(action, param) {
    const actionFunction = documentActions[action];

    if (actionFunction) {
        actionFunction(param);
    } else {
       log('No action found for:', action);
    }
}

function toggleDocumentFavorite(documentId) {
    const document = documents[documentId.toString()];
    if (!document) return;

    const updatedDocument = {
        id: parseInt(documentId),
        favorite: !document.favorite
    };

    submitDocumentUpdate(updatedDocument, function(response) {
        updateDocumentsList();
        initDocumentsTreeview();
    }, function(error) {
        log('Error updating document favorite:', 'error', error);
    });
}

const documentActions = {
    edit: documentId => editDocument(documentId),
    favorite: documentId => toggleDocumentFavorite(documentId),
    delete: documentId => deleteDocument(documentId)
};

function extractDocumentId(nodeId) {
    if (!nodeId) return null;

    const match = nodeId.match(/document-link-(\d+)/);
    return match ? parseInt(match[1]) : null;
}

$(document).ready(function() {
    addDocumentContextMenu();
});
