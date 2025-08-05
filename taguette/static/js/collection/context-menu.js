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

function extractCollectionId(nodeId) {
    if (!nodeId) return null;
    
    const match = nodeId.match(/collection_(\d+)/);
    return match ? parseInt(match[1]) : null;
}

function findCollection(collectionId) {
    console.log(`findCollection called for ID: ${collectionId}`);
    console.log('Current collections structure:', collections);
    
    function searchInTree(collections) {
        if (!collections || !Array.isArray(collections)) {
            console.warn('Invalid collections array provided to searchInTree');
            return null;
        }
        
        for (let collection of collections) {
            if (collection.id === collectionId) {
                console.log(`Found collection: ${collection.name} (ID: ${collection.id})`);
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
    if (!result) {
        console.warn(`Collection with ID ${collectionId} NOT FOUND in structure`);
        console.log('Available collection IDs:', collections ? flattenCollections(collections) : 'collections is null/undefined');
    }
    return result;
}

// Variables globales pour la gestion des raccourcis
let selectedCollectionId = null;

// Fonction pour gérer les raccourcis clavier
function handleCollectionKeyboardShortcuts(e) {
    // Seulement si on est sur une page avec des collections
    if ($('.collection-context-menu').length === 0) return;
    
    // M : Ouvrir le menu contextuel de la collection sélectionnée
    if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (selectedCollectionId) {
            // Trouver l'élément et déclencher le menu contextuel
            const element = $(`.collection-context-menu[id*="collection_${selectedCollectionId}"]`);
            if (element.length > 0) {
                element.contextMenu();
            }
        }
        return;
    }
    
    // Raccourcis pour les actions (seulement si une collection est sélectionnée)
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
        }
    }
}

// Fonction pour mettre à jour la collection sélectionnée
function updateSelectedCollection(collectionId) {
    selectedCollectionId = collectionId;
    
    // Retirer la classe de sélection de tous les éléments
    $('.collection-context-menu').removeClass('collection-selected');
    
    // Ajouter la classe de sélection à l'élément actuel
    if (collectionId) {
        const element = $(`.collection-context-menu[id*="collection_${collectionId}"]`);
        if (element.length > 0) {
            element.addClass('collection-selected');
        }
    }
}

// Ajouter les event listeners pour la sélection des collections
function addCollectionSelectionHandlers() {
    // Sélection au survol
    $(document).on('mouseenter', '.collection-context-menu', function() {
        const nodeId = $(this).attr('id');
        const collectionId = extractCollectionId(nodeId);
        if (collectionId) {
            updateSelectedCollection(collectionId);
        }
    });
    
    // Désélection quand on clique ailleurs
    $(document).on('click', function(e) {
        if (!$(e.target).closest('.collection-context-menu').length) {
            updateSelectedCollection(null);
        }
    });
}

$(document).ready(function() {
    addCollectionContextMenu();
    addCollectionSelectionHandlers();
    
    // Ajouter les raccourcis clavier
    $(document).on('keydown', handleCollectionKeyboardShortcuts);
});

