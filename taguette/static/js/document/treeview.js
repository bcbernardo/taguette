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
                text: gettext('Sans collection'),
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
            element.attr('title', node.text);
            
            if (node.document_id) {
                element.attr('data-document-id', node.document_id);
                element.attr('id', `document-link-${node.document_id}`);
                element.addClass('document-link');
                element.css('position', 'relative');
                
                if (node.document_id === current_document) {
                    element.addClass('document-link-current');
                }
            
                const doc = documents[node.document_id];
                if (doc) {
                    const favoriteIconClass = doc.favorite === true ? 'fas fa-star' : 'far fa-star';
                    const favoriteTitle = doc.favorite === true ? gettext("Remove from Favorites") : gettext("Add to Favorites");
                    
                    const editIcon = $(`
                        <a href="#" class="edit-icon" title="${gettext('Edit')}" style="position: absolute; right: 30px; top: 50%; transform: translateY(-50%);">
                            <i class="fas fa-edit" aria-hidden="true"></i>
                        </a>
                    `);
                    
                    const favoriteIcon = $(`
                        <a href="#" class="favorite-icon" title="${favoriteTitle}" style="position: absolute; right: 5px; top: 50%; transform: translateY(-50%);">
                            <i id="favorite-icon-${node.document_id}" class="${favoriteIconClass}" aria-hidden="true"></i>
                        </a>
                    `);
                    
                    editIcon.on('click', function(e) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        editDocument(node.document_id);
                        return false;
                    });
                    
                    favoriteIcon.on('click', function(e) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        toggleFavorite(node.document_id);
                        return false;
                    });
                    
                    element.append(editIcon);
                    element.append(favoriteIcon);
                }
                
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

function initDocumentsTreeview(filteredCollections = null) {
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
    
    // If filtering, expand all nodes to show search results
    if (filteredCollections) {
        treeview_documents.treeview('expandAll');
    } else {
        treeview_documents.treeview('collapseAll');
    }
    
    // Re-add drag and drop after treeview changes (like tags do)
    treeview_documents.on('nodeSelected nodeUnselected nodeCollapsed nodeExpanded', function (event, node) {
        // Clear selection when collapsing or expanding
        if (event.type === 'nodeCollapsed' || event.type === 'nodeExpanded') {
            deselectAllDocumentNodes();
            hideDragHint();
        }
        
        // Show/hide drag hint based on selection count
        if (event.type === 'nodeSelected' || event.type === 'nodeUnselected') {
            const selectedNodes = treeview_documents.treeview('getSelected');
            const selectedDocuments = selectedNodes.filter(node => 
                node.id && node.id.startsWith('document_')
            );
            
            if (event.type === 'nodeSelected' && node.id && node.id.startsWith('document_')) {
                // Show hint next to the last selected document
                showDragHint(selectedDocuments.length, node.nodeId);
            } else if (selectedDocuments.length <= 1) {
                // Hide hint if only one or no documents selected
                hideDragHint();
            }
        }
        
        // Add a delay to ensure the treeview recreation is finished
        setTimeout(function () {
            addDocumentDragDrop();
            
            // Update folder icon based on expanded state - ONLY for collections in documents treeview
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
    
    // Add drag and drop functionality
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
    const nodeElement = $(`li[data-nodeid="${nodeId}"]`);
    nodeElement.addClass('highlight-collection');
    setTimeout(() => {
        nodeElement.addClass('fade-out');
    }, 3000);
}

function highlightDocument(documentId) {
    const nodeId = getNodeIdFromTreeviewByDocumentId(treeview_documents, documentId);
    const nodeElement = $(`li[data-nodeid="${nodeId}"]`);
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
    
    console.log('getDocumentIdFromTreeviewNode - node not a document:', node);
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
        const message = `Vous pouvez glisser-déposer ${selectedCount} documents vers une collection`;
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