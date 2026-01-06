const treeview_documents = $('#treeview-documents');

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

function convertCollectionsToTreeNode(data) {
    return data.map(collection => {
        const collectionNode = {
            id: 'collection_' + collection.id,
            text: collection.name,
            icon: 'fas fa-folder',
            selectable: false,
            nodes: []
        };

        if (collection.document_ids && collection.document_ids.length > 0 && typeof documents !== 'undefined') {
            for (let docId of collection.document_ids) {
                const document = documents[docId.toString()];
                if (document) {
                    collectionNode.nodes.push({
                        id: 'document_' + docId,
                        text: document.name,
                        icon: 'fas fa-file-alt',
                        selectable: true,
                        document_id: parseInt(docId)
                    });
                }
            }
        }

        if (collection.children && collection.children.length > 0) {
            const childCollections = convertCollectionsToTreeNode(collection.children);
            collectionNode.nodes.push(...childCollections);
        }

        const documentNodes = collectionNode.nodes.filter(node => node.document_id !== undefined);
        const subCollections = collectionNode.nodes.filter(node => node.document_id === undefined);
        
        documentNodes.sort((a, b) => a.text.localeCompare(b.text));
        subCollections.sort((a, b) => a.text.localeCompare(b.text));
        
        collectionNode.nodes = [...documentNodes, ...subCollections];

        // fake node to force chevron display (for icon alignment)
        if (collectionNode.nodes.length === 0) {
            collectionNode.nodes.push({
                id: 'dummy_' + collection.id,
                text: '',
                icon: '',
                selectable: false,
                hideCheckbox: true,
                isDummy: true,
                state: {
                    disabled: true
                }
            });
        }

        const documentCount = collection.document_ids ? collection.document_ids.length : 0;
        collectionNode.tags = [documentCount.toString()];

        return collectionNode;
    });
}

function convertDocumentsToTreeNode(filteredCollections = null) {
    const treeData = [];
    
    const collectionsToUse = filteredCollections || collections;
    
    if (collectionsToUse && collectionsToUse.length > 0) {
        const collectionNodes = convertCollectionsToTreeNode(collectionsToUse);
        treeData.push(...collectionNodes);
    }
    
    // Only show uncategorized documents if no filtered collections or if searching
    const shouldShowUncategorized = !filteredCollections || filteredCollections.length === 0;
    
    if (shouldShowUncategorized) {
        const uncategorizedDocs = [];
        for (let [docId, document] of Object.entries(documents)) {
            const docCollections = document.collections || [];
            if (docCollections.length === 0) {
                // If filtering, only include documents that match the search
                if (filteredCollections) {
                    const searchText = window.document.getElementById("input-search-titles")?.value.toLowerCase() || '';
                    if (searchText && !document.name.toLowerCase().includes(searchText)) {
                        continue;
                    }
                }
                
                uncategorizedDocs.push({
                    id: 'document_' + docId,
                    text: document.name,
                    icon: 'fas fa-file-alt',
                    selectable: true,
                    document_id: parseInt(docId)
                });
            }
        }
        
        if (uncategorizedDocs.length > 0) {
            uncategorizedDocs.sort((a, b) => a.text.localeCompare(b.text));
            treeData.push({
                id: 'uncategorized',
                text: gettext('Without collection'),
                icon: 'fas fa-folder',
                selectable: false,
                nodes: uncategorizedDocs,
                tags: [uncategorizedDocs.length.toString()]
            });
        }
    }
    
    return treeData;
}

function customDocumentNodeRow() {
    return {
        customContent: true,
        nodeContentSelector: 'a',
        nodeContentAttributes: {
            href: '#',
            class: 'document-link-a',
            style: 'text-decoration: none;'
        },
        customizeNode: function(element, node, tree) {
            element.attr('id', `treeview-node-${node.id}`);

            if (node.document_id) {
                element.attr('data-document-id', node.document_id);
                element.attr('id', `document-link-${node.document_id}`);
                element.addClass('document-link');
                element.css('position', 'relative');

                const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                const cmdKey = isMac ? 'Cmd' : 'Ctrl';
                const tooltipText = gettext('Click to open • %(key)s+Click to select • Right-click for options', {key: cmdKey});
                const tooltip = `${node.text}\n\n${tooltipText}`;
                element.attr('title', tooltip);
                
                if (node.document_id === current_document) {
                    element.addClass('document-link-current');
                }
                element.addClass('document-context-menu');

                linkDocument(element[0], node.document_id);
            }
            
            setTimeout(function() {
                if (node.id && (node.id.startsWith('collection_') || node.id === 'uncategorized')) {
                   element.addClass('collection-context-menu');
                   
                   if (element.find('.expand-icon, .collapse-icon, i[class*="fa-folder"]').length === 0) {
                       element.prepend('<i class="fas fa-folder" style="margin-right: 10px;"></i>');
                   }
                }
                element.find('.expand-icon, .collapse-icon').css('margin-right', '10px');
                element.find('i[class*="fa-chevron"], i[class*="fa-folder"], i[class*="fa-file"]').css('margin-right', '10px');
            }, 10);
        }
    };
}

function initDocumentsTreeview(filteredCollections = null, callback = null) {
    const expandedIds = saveExpandedState();

    const treeData = convertDocumentsToTreeNode(filteredCollections);
    const customNodeOptions = customDocumentNodeRow();
    
    const options = {
        data: treeData,
        ...customNodeOptions,
        showIcon: true,
        showBorder: true,
        showTags: true,
        levels: 1,
        collapseIcon: 'fas fa-chevron-down',
        expandIcon: 'fas fa-chevron-right',
        customizeBadges: function(container, node) {
            container.addClass('document-badges');
            if (node.tags && node.tags.length > 0) {
                container.append($('<span>', {
                    class: 'badge badge-secondary badge-fixed-width',
                    title: gettext('Documents count'),
                    text: node.tags[0]
                }));
            }
        }
    };
    
    options.multiSelect = true;

    treeview_documents.treeview(options);

    if (callback) {
        setTimeout(() => {
            if (expandedIds.length > 0) {
                restoreExpandedState(expandedIds, callback);
            } else {
                callback();
            }
        }, 50);
    } else if (expandedIds.length > 0) {
        restoreExpandedState(expandedIds, null);
    }

    if (filteredCollections) {
        treeview_documents.treeview('expandAll');
    } else if (expandedIds.length === 0) {
        treeview_documents.treeview('collapseAll');
    }
    
    treeview_documents.on('nodeExpanded', function(event, node) {
        if (node.nodes && node.nodes.length === 1 && node.nodes[0].isDummy) {
            event.preventDefault();
            event.stopImmediatePropagation();
            treeview_documents.treeview('collapseNode', [node.nodeId, {silent: true}]);
            return false;
        }
    });
    
    treeview_documents.on('nodeSelected nodeUnselected nodeCollapsed nodeExpanded', function (event, node) {
        if (event.type === 'nodeCollapsed' || event.type === 'nodeExpanded') {
            deselectAllDocumentNodes();
            hideDragHint();
        }

        if (event.type === 'nodeSelected' || event.type === 'nodeUnselected') {
            const selectedNodes = treeview_documents.treeview('getSelected');
            const selectedDocuments = selectedNodes.filter(node =>
                node.id && node.id.startsWith('document_')
            );

            if (event.type === 'nodeSelected' && node.id && node.id.startsWith('document_')) {
                showDragHint(selectedDocuments.length, node.nodeId);
            } else if (selectedDocuments.length <= 1) {
                hideDragHint();
            }
        }

        setTimeout(function () {
            addDocumentDragDrop();

            if (node.id && (node.id.startsWith('collection_') || node.id === 'uncategorized')) {
                const nodeElement = $('#treeview-documents').find(`li[data-nodeid="${node.nodeId}"]`);
                const folderIcon = nodeElement.find('.node-icon');
                if (folderIcon.length > 0) {
                    const newIconClass = node.state.expanded ? 'fas fa-folder-open' : 'fas fa-folder';
                    folderIcon.removeClass('fas fa-folder fas fa-folder-open').addClass(newIconClass);
                }
            }
        }, 10);
    });
    
    setTimeout(function() {
        addDocumentDragDrop();
    }, 10);
}

function updateDocumentTreeviewHighlight(current_document) {
    if (current_document) {
        const treeviewDocumentLink = document.getElementById('document-link-' + current_document);
        if (treeviewDocumentLink) {
            treeviewDocumentLink.classList.add('document-link-current');
        }
    }
}

function findDocumentParentCollection(documentId) {
    if (!treeview_documents.length) return null;
    
    const allNodes = treeview_documents.treeview('getEnabled');
    const document = documents[documentId];
    
    if (!document) return null;
    
    const docCollections = document.collections || [];
    
    if (docCollections.length > 0) {
        const collectionId = docCollections[0];
        const collectionNode = allNodes.find(node => node.id === `collection_${collectionId}`);
        return collectionNode ? collectionNode.nodeId : null;
    } else {
        const uncategorizedNode = allNodes.find(node => node.id === 'uncategorized');
        return uncategorizedNode ? uncategorizedNode.nodeId : null;
    }
} 

function findDocumentRootParent(collectionId) {
    const collection = findCollection(collectionId);
    if (collection && collection.parent) {
        return findDocumentRootParent(collection.parent);
    }
    return collectionId;
}

function expandDocumentNodeParent(collectionParent) {
    const rootParentId = findDocumentRootParent(collectionParent);
    const nodeId = getNodeIdFromTreeviewByCollectionId(treeview_documents, rootParentId);
    expandDocumentNode(treeview_documents, nodeId);
}

function expandDocumentNode(treeview, nodeId) {
    const node = getNode(treeview, nodeId);
    if (!node.state.expanded) {
        treeview.treeview('expandNode', [parseInt(nodeId, 10),
            {levels: 5, silent: false}]);
    }
}

function highlightCollection(collectionId) {
    const nodeId = getNodeIdFromTreeviewByCollectionId(treeview_documents, collectionId);
    const nodeElement = treeview_documents.find(`li[data-nodeid="${nodeId}"]`);

    if (nodeElement.length > 0) {
        nodeElement[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    nodeElement.addClass('highlight-collection');
    setTimeout(() => {
        nodeElement.addClass('fade-out');
    }, 3000);
}

function highlightDocument(documentId) {
    const nodeId = getNodeIdFromTreeviewByDocumentId(treeview_documents, documentId);
    const nodeElement = treeview_documents.find(`li[data-nodeid="${nodeId}"]`);

    if (nodeElement.length > 0) {
        nodeElement[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    nodeElement.addClass('highlight-document');
    setTimeout(() => {
        nodeElement.addClass('fade-out');
    }, 3000);
}

function getNodeIdFromTreeviewByCollectionId(treeview, collectionId) {
    const allNodes = treeview.treeview('getEnabled');
    const node = allNodes.find(node => node.id === `collection_${collectionId}`);
    return node ? node.nodeId : null;
}

function getNodeIdFromTreeviewByDocumentId(treeview, documentId) {
    const allNodes = treeview.treeview('getEnabled');
    const node = allNodes.find(node => node.id === `document_${documentId}`);
    return node ? node.nodeId : null;
}

function getDocumentIdFromTreeviewNode(treeview, nodeId) {
    const allNodes = treeview.treeview('getEnabled');
    const node = allNodes.find(item => item.nodeId === parseInt(nodeId));
    
    if (node && node.id && node.id.startsWith('document_')) {
        return parseInt(node.id.replace('document_', ''));
    }
    
    log('getDocumentIdFromTreeviewNode - node not a document:', 'warn', node);
    return null;
}

function deselectAllDocumentNodes() {
    const allNodes = treeview_documents.treeview('getEnabled');
    allNodes.forEach(node => {
        if (node.state.selected) {
            treeview_documents.treeview('unselectNode', [node.nodeId, {silent: false}]);
        }
    });
}

function showDragHint(selectedCount, lastSelectedNodeId) {

    $('#drag-hint').remove();
    
    if (selectedCount > 1) {
        const message = gettext("You can drag and drop %s documents to a collection").replace('%s', selectedCount);
        const popup = $('<div id="drag-hint" class="drag-hint-popup">' +
          '<i class="fas fa-grip-vertical"></i> ' + message +
          '</div>');
        
        $('#treeview-documents').before(popup);
        
        setTimeout(() => {
            $('#drag-hint').fadeOut(300, function() {
                $(this).remove();
            });
        }, 3000);
    }
}

function hideDragHint() {
    $('#drag-hint').fadeOut(200, function() {
        $(this).remove();
    });
} 

function addDocumentDragDrop() {
    
    $('.node-treeview-documents').on('dragstart', function (event) {
        const nodeId = $(this).data('nodeid');
        const documentId = getDocumentIdFromTreeviewNode(treeview_documents, nodeId);
        
        // Only allow dragging documents, not collections
        if (!documentId) {
            event.preventDefault();
            return false;
        }
        
        // Get all selected documents
        const selectedNodes = treeview_documents.treeview('getSelected');
        const selectedDocumentIds = selectedNodes
            .map(node => getDocumentIdFromTreeviewNode(treeview_documents, node.nodeId))
            .filter(id => id !== null);
        
        // If no documents are selected, use only the dragged document
        const documentsToMove = selectedDocumentIds.length > 0 ? selectedDocumentIds : [documentId];
        
        // Store document IDs in dataTransfer
        event.originalEvent.dataTransfer.setData('text', JSON.stringify(documentsToMove));
    });

    $(".node-treeview-documents").each(function (index, element) {

        $(element).off('drop');
        $(element).off('dragover');

        $(element).on('dragover', function (event) {
            event.preventDefault();
        });

        $(element).on('drop', function (event) {
            event.preventDefault();

            const collectionId = getCollectionIdFromTreeviewNode(treeview_documents, $(element).data("nodeid"));
            const draggedData = event.originalEvent.dataTransfer.getData('text');

            // Hide drag hint after drop
            hideDragHint();

            try {
                // Try to parse as JSON (multiple documents)
                const selectedDocumentIds = JSON.parse(draggedData);
                if (Array.isArray(selectedDocumentIds)) {
                    // Move all selected documents with sequential delay
                    selectedDocumentIds.forEach((documentId, index) => {
                        // Check if document is already in this collection
                        const document = documents[documentId.toString()];
                        const currentCollections = document ? document.collections || [] : [];
                        const isAlreadyInCollection = currentCollections.includes(collectionId);
                        
                        if (!isAlreadyInCollection) {
                            setTimeout(() => {
                                moveDocumentToCollection(documentId, collectionId);
                            }, index * 200); // 200ms delay between each document
                        }
                    });
                }
            } catch (e) {
                // Fallback to single document (old format)
                const documentId = parseInt(draggedData);
                if (!isNaN(documentId)) {
                    // Check if document is already in this collection
                    const document = documents[documentId.toString()];
                    const currentCollections = document ? document.collections || [] : [];
                    const isAlreadyInCollection = currentCollections.includes(collectionId);
                    
                    if (!isAlreadyInCollection) {
                        moveDocumentToCollection(documentId, collectionId);
                    }
                }
            }
        });
    });
}

function getCollectionIdFromTreeviewNode(treeview, nodeId) {
    const allNodes = treeview.treeview('getEnabled');
    const node = allNodes.find(item => item.nodeId === parseInt(nodeId));
    
    if (node && node.id && node.id.startsWith('collection_')) {
        return parseInt(node.id.replace('collection_', ''));
    }
    
    return null;
}

function isUncategorizedNode(nodeId) {
    const allNodes = treeview_documents.treeview('getEnabled');
    const node = allNodes.find(item => item.nodeId === parseInt(nodeId));
    return node && node.id === 'uncategorized';
}

function moveDocumentToCollection(documentId, targetCollectionId) {
    const document = documents[documentId.toString()];
    if (!document) {
        return;
    }
    if (targetCollectionId === undefined || targetCollectionId === null) {
        log('Target collection ID not provided');
        return;
    }

    const updatedDocument = {
        id: documentId,
        collections: targetCollectionId !== null ? [targetCollectionId] : []
    };

    submitDocumentUpdate(updatedDocument,
        (response) => {
            log('Document moved successfully:', 'success', {response});
        },
        (error) => {
            log('Error moving document:', 'error', {error});
        }
    );
}

$(document).ready(function() {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const cmdKey = isMac ? 'Cmd' : 'Ctrl';

    const sections = [
        {
            title: gettext('Right-click on a collection:'),
            items: [
                gettext('Add sub-collection'),
                gettext('Edit collection'),
                gettext('Remove parent'),
                gettext('Delete collection')
            ]
        },
        {
            title: gettext('Right-click on a document:'),
            items: [
                gettext('Edit document'),
                gettext('Toggle bookmark'),
                gettext('Delete document')
            ]
        },
        {
            title: gettext('Select multiple documents:'),
            items: [
                gettext('Hold %(key)s and click documents', { key: cmdKey }),
                gettext('Drag selected documents to a collection')
            ]
        }
    ];

    initHelpPopover('treeview-help-icon', sections);
});


function saveExpandedState() {
    if (!treeview_documents.length) return [];
    if (!treeview_documents.data('treeview')) return [];

    try {
        const expandedNodes = treeview_documents.treeview('getExpanded');
        return expandedNodes.map(node => node.id).filter(id => id);
    } catch (e) {
        return [];
    }
}

function restoreExpandedState(expandedIds, callback) {
    if (!expandedIds || expandedIds.length === 0) {
        if (callback) setTimeout(callback, 50);
        return;
    }

    setTimeout(() => {
        const allNodes = treeview_documents.treeview('getEnabled');
        expandedIds.forEach(id => {
            const node = allNodes.find(n => n.id === id);
            if (node && !node.state.expanded) {
                treeview_documents.treeview('expandNode', [node.nodeId, {silent: true}]);
            }
        });
        addDocumentDragDrop();

        if (callback) {
            setTimeout(() => {
                callback();
            }, 150);
        }
    }, 50);
}

