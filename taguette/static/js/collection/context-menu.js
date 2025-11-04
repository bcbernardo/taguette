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
    const items = {
        "addChildCollection": {
            name: gettext('Add sub-collection'),
            icon: 'fas fa-plus-circle',
            callback: (key, options) => collectionContextMenuAction('addChildCollection', collection.id)
        },
        "edit": {
            name: gettext('Edit collection'),
            icon: "fas fa-edit",
            callback: (key, options) => collectionContextMenuAction('edit', collection.id)
        }
    };
    
    if (collection.parent) {
        items["removeParent"] = {
            name: gettext('Remove parent'),
            icon: "fas fa-level-up-alt",
            callback: (key, options) => collectionContextMenuAction('removeParent', collection.id)
        };
    }
    
    items["separator1"] = "---------";
    items["delete"] = {
        name: gettext('Delete collection'),
        icon: "fas fa-trash",
        callback: (key, options) => collectionContextMenuAction('delete', collection.id)
    };
    
    return items;
}

function collectionContextMenuAction(action, param) {
    const actionFunction = collectionActions[action];

    if (actionFunction) {
        actionFunction(param);
    } else {
       log('No action found for:', action);
    }
}

const collectionActions = {
    addChildCollection: collectionId => createChildCollection(collectionId),
    edit: collectionId => editCollection(collectionId),
    removeParent: collectionId => removeCollectionParent(collectionId),
    delete: collectionId => deleteCollection(collectionId)
};

function extractCollectionId(nodeId) {
    if (!nodeId) return null;
    
    const match = nodeId.match(/collection_(\d+)/);
    return match ? parseInt(match[1]) : null;
}

function findCollection(collectionId) {

    function searchInTree(collections) {
        if (!collections || !Array.isArray(collections)) {
            return null;
        }
        
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
    
    const result = searchInTree(collections);
    return result;
}


let selectedCollectionId = null;


function handleCollectionKeyboardShortcuts(e) {

    if ($('.collection-context-menu').length === 0) return;
    
    // if (e.key.toLowerCase() === 'm') {
    //     e.preventDefault();
    //     if (selectedCollectionId) {
    //         const element = $(`.collection-context-menu[id*="collection_${selectedCollectionId}"]`);
    //         if (element.length > 0) {
    //             element.contextMenu();
    //         }
    //     }
    //     return;
    // }
    
    if (selectedCollectionId) {
        switch(e.key.toLowerCase()) {
            case 'e':
                e.preventDefault();
                editCollection(selectedCollectionId);
                break;
            case 'd':
                e.preventDefault();
                deleteCollection(selectedCollectionId);
                break;
            case 'c':
                e.preventDefault();
                createChildCollection(selectedCollectionId);
                break;
            case 'u':
                e.preventDefault();
                const collection = findCollection(selectedCollectionId);
                if (collection && collection.parent) {
                    removeCollectionParent(selectedCollectionId);
                }
                break;
        }
    }
}

function updateSelectedCollection(collectionId) {
    selectedCollectionId = collectionId;
    
    $('.collection-context-menu').removeClass('collection-selected');
    
    if (collectionId) {
        const element = $(`.collection-context-menu[id*="collection_${collectionId}"]`);
        if (element.length > 0) {
            element.addClass('collection-selected');
        }
    }
}

function addCollectionSelectionHandlers() {
    $(document).on('mouseenter', '.collection-context-menu', function() {
        const nodeId = $(this).attr('id');
        const collectionId = extractCollectionId(nodeId);
        if (collectionId) {
            updateSelectedCollection(collectionId);
        }
    });
    
    $(document).on('click', function(e) {
        if (!$(e.target).closest('.collection-context-menu').length) {
            updateSelectedCollection(null);
        }
    });
}

$(document).ready(function() {
    addCollectionContextMenu();
    addCollectionSelectionHandlers();
    $(document).on('keydown', handleCollectionKeyboardShortcuts);
});

