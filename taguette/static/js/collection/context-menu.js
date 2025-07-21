// Collection context menu implementation
function addCollectionContextMenu() {
    $.contextMenu({
        selector: '.collection-context-menu',
        build: function ($trigger) {
            const nodeId = $trigger.attr('id');
            const collectionId = extractCollectionId(nodeId);
            
            if (!collectionId) return false;
            
            const collection = findCollection(collectionId);
            if (!collection) return false;

            let items = generateCollectionContextMenuItems(collection);

            return {
                callback: (key, options) => collectionContextMenuAction(key, options.$trigger.attr("id")),
                items
            };
        }
    });
}

function generateCollectionContextMenuItems(collection) {
    const hasChildren = collection.children && collection.children.length > 0;
    const hasDocuments = collection.document_ids && collection.document_ids.length > 0;
    
    return {
        "addChildCollection": {
            name: gettext('Add sub-collection'),
            icon: 'fas fa-plus-circle',
            callback: (key, options) => collectionContextMenuAction('addChildCollection', collection.id)
        },
        "edit": {
            name: gettext('Edit collection'),
            icon: "fas fa-edit",
            callback: (key, options) => collectionContextMenuAction('edit', collection.id)
        },
        "separator1": "---------",
        "delete": {
            name: gettext('Delete collection'),
            icon: "fas fa-trash",
            callback: (key, options) => collectionContextMenuAction('delete', collection.id)
        }
    };
}

function collectionContextMenuAction(action, param) {
    const actionFunction = collectionActions[action];

    if (actionFunction) {
        actionFunction(param);
    } else {
        console.log('No action found for:', action);
    }
}

const collectionActions = {
    addChildCollection: collectionId => createChildCollection(collectionId),
    edit: collectionId => editCollection(collectionId),
    delete: collectionId => deleteCollection(collectionId)
};

// Helper function to extract collection ID from node ID
function extractCollectionId(nodeId) {
    if (!nodeId) return null;
    
    // Extract from treeview-node-collection_123 format
    const match = nodeId.match(/collection_(\d+)/);
    return match ? parseInt(match[1]) : null;
}

// Helper function to find collection in the collections tree
function findCollection(collectionId) {
    function searchInTree(collections) {
        for (let collection of collections) {
            if (collection.id === collectionId) {
                return collection;
            }
            if (collection.children && collection.children.length > 0) {
                const found = searchInTree(collection.children);
                if (found) return found;
            }
        }
        return null;
    }
    
    return searchInTree(collections);
}

// Initialize context menu when document is ready
$(document).ready(function() {
    addCollectionContextMenu();
}); 