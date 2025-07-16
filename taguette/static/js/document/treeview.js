const treeview_documents = $('#treeview-documents');

// Convert documents and collections data to tree structure
function convertDocumentsToTreeNode() {
    const treeData = [];
    
    // Get all collections and sort by name
    const collectionsEntries = Object.entries(collections);
    collectionsEntries.sort((a, b) => a[1].name.localeCompare(b[1].name));
    
    // Add collections as parent nodes
    for (let [collectionId, collection] of collectionsEntries) {
        const collectionNode = {
            id: 'collection_' + collectionId,
            text: collection.name,
            icon: 'fas fa-folder',
            selectable: false,
            nodes: []
        };
        
        // Add documents in this collection
        if (collection.document_ids && collection.document_ids.length > 0) {
            for (let docId of collection.document_ids) {
                const document = documents[docId.toString()];
                if (document) {
                    collectionNode.nodes.push({
                        id: 'document_' + docId,
                        text: document.name,
                        icon: 'fas fa-file-alt',
                        selectable: false,
                        document_id: parseInt(docId)
                    });
                }
            }
        }
        
        // Sort documents in collection by name
        collectionNode.nodes.sort((a, b) => a.text.localeCompare(b.text));
        
        // Add count badge - even if 0 documents
        collectionNode.tags = [collectionNode.nodes.length.toString()];
        
        // Always add collection, even if empty
        treeData.push(collectionNode);
    }
    
    // Add uncategorized documents
    const uncategorizedDocs = [];
    for (let [docId, document] of Object.entries(documents)) {
        const docCollections = document.collections || [];
        if (docCollections.length === 0) {
            uncategorizedDocs.push({
                id: 'document_' + docId,
                text: document.name,
                icon: 'fas fa-file-alt',
                selectable: false,
                document_id: parseInt(docId)
            });
        }
    }
    
    // Add uncategorized node if there are documents without collections
    if (uncategorizedDocs.length > 0) {
        uncategorizedDocs.sort((a, b) => a.text.localeCompare(b.text));
        treeData.push({
            id: 'uncategorized',
            text: gettext('Sans collection'),
            icon: 'fas fa-folder-open',
            selectable: false,
            nodes: uncategorizedDocs,
            tags: [uncategorizedDocs.length.toString()]
        });
    }
    
    return treeData;
}

// Custom node row for documents treeview
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
            
            // If this is a document node, add click handler and favorite icon
            if (node.document_id) {
                element.attr('data-document-id', node.document_id);
                element.attr('id', `document-link-${node.document_id}`);
                element.addClass('document-link');
                
                // Set position relative for absolute positioning of icons
                element.css('position', 'relative');
                
                // Add current document highlighting
                if (node.document_id === current_document) {
                    element.addClass('document-link-current');
                }
            
                // Get document data for favorite status
                const doc = documents[node.document_id];
                if (doc) {
                    const favoriteIconClass = doc.favorite === true ? 'fas fa-star' : 'far fa-star';
                    const favoriteTitle = doc.favorite === true ? gettext("Remove from Favorites") : gettext("Add to Favorites");
                    
                    // Add edit icon and favorite icon next to the text
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
                    
                    // Add click handler for edit icon
                    editIcon.on('click', function(e) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        editDocument(node.document_id);
                        return false;
                    });
                    
                    // Add click handler for favorite icon
                    favoriteIcon.on('click', function(e) {
                        e.preventDefault();
                        e.stopImmediatePropagation(); // Prevent all other event handlers
                        toggleFavorite(node.document_id);
                        return false; // Extra prevention
                    });
                    
                    element.append(editIcon);
                    element.append(favoriteIcon);
                }
                
                // Use the existing linkDocument function
                linkDocument(element[0], node.document_id);
            }
            
            // Add icons and spacing for all nodes
            setTimeout(function() {
                // For collections (with or without children)
                if (node.id && node.id.startsWith('collection_')) {
                    // If no expand/collapse icon, add folder icon
                    if (element.find('.expand-icon, .collapse-icon').length === 0) {
                        element.prepend('<i class="node-icon fas fa-folder" style="margin-right: 8px;"></i> ');
                    }
                }
                // Add margin to ALL icons for better spacing
                element.find('.expand-icon, .collapse-icon').css('margin-right', '5px');
                element.find('.node-icon').css('margin-right', '8px');
                element.find('i[class*="fa-chevron"], i[class*="fa-folder"], i[class*="fa-file"]').css('margin-right', '8px');
            }, 10);
        }
    };
}

// Initialize the documents treeview
function initDocumentsTreeview() {
    const treeData = convertDocumentsToTreeNode();
    
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
    
    treeview_documents.treeview(options);
    treeview_documents.treeview('collapseAll');
}

// Update document highlighting in treeview
function updateDocumentTreeviewHighlight(current_document) {
    // Add highlighting to current document in treeview
    if (current_document) {
        const treeviewDocumentLink = document.getElementById('document-link-' + current_document);
        if (treeviewDocumentLink) {
            treeviewDocumentLink.classList.add('document-link-current');
        }
    }
}

// Find the parent collection nodeId for a document
function findDocumentParentCollection(documentId) {
    if (!treeview_documents.length) return null;
    
    const allNodes = treeview_documents.treeview('getEnabled');
    const document = documents[documentId];
    
    if (!document) return null;
    
    // Check if document is in a collection
    const docCollections = document.collections || [];
    
    if (docCollections.length > 0) {
        // Find the collection node
        const collectionId = docCollections[0]; // Take first collection
        const collectionNode = allNodes.find(node => node.id === `collection_${collectionId}`);
        return collectionNode ? collectionNode.nodeId : null;
    } else {
        // Document is uncategorized
        const uncategorizedNode = allNodes.find(node => node.id === 'uncategorized');
        return uncategorizedNode ? uncategorizedNode.nodeId : null;
    }
} 