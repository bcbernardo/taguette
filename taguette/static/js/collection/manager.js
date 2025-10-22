// Collection management: add, update, remove

function addCollection(collectionData) {
    // Check if collection already exists to prevent duplicates
    const existingCollection = findCollection(parseInt(collectionData.id));
    if (existingCollection) {
        // Update existing collection instead of creating duplicate
        existingCollection.name = collectionData.name;
        existingCollection.description = collectionData.description;
        existingCollection.document_ids = collectionData.document_ids;
        initDocumentsTreeview();
        return;
    }
    
    const newCollection = {
        id: collectionData.id,
        name: collectionData.name,
        description: collectionData.description,
        parent: collectionData.parent_id,
        document_ids: collectionData.document_ids,
        children: []
    };
    
    if (!collections) {
        collections = [];
    }
    
    // Check if collection has parent
    if (collectionData.parent_id) {
        const parentCollection = findCollection(parseInt(collectionData.parent_id));
        if (parentCollection) {
            if (!parentCollection.children) {
                parentCollection.children = [];
            }
            parentCollection.children.push(newCollection);
        } else {
            // Parent not found, add to root level
            collections.push(newCollection);
        }
    } else {
        // Root level collection
        collections.push(newCollection);
    }
    
    // Update document collections
    if (collectionData.document_ids && collectionData.document_ids.length > 0) {
        for (let docId of collectionData.document_ids) {
            const document = documents[docId.toString()];
            if (document) {
                // Remove document from all existing collections first
                if (document.collections && document.collections.length > 0) {
                    for (let existingCollectionId of document.collections) {
                        const existingCollection = findCollection(existingCollectionId);
                        if (existingCollection && existingCollection.document_ids) {
                            const docIndex = existingCollection.document_ids.indexOf(parseInt(docId));
                            if (docIndex !== -1) {
                                existingCollection.document_ids.splice(docIndex, 1);
                            }
                        }
                    }
                }
                
                // Add document to new collection
                if (!document.collections) {
                    document.collections = [];
                }
                if (!document.collections.includes(collectionData.id)) {
                    document.collections.push(collectionData.id);
                }
            }
        }
    }
    
    initDocumentsTreeview();
    
    // Expand parent and highlight new collection
    if (collectionData.parent_id) {
        expandDocumentNodeParent(parseInt(collectionData.parent_id));
    } else if (collectionData.document_ids && collectionData.document_ids.length > 0) {
        const nodeId = getNodeIdFromTreeviewByCollectionId(treeview_documents, collectionData.id);
        expandDocumentNode(treeview_documents, nodeId);
    }
    highlightCollection(collectionData.id);
}

function updateCollection(collectionData) {
    // Find existing collection in hierarchy
    let existingCollection = findCollection(parseInt(collectionData.id));
    if (!existingCollection) {
        addCollection(collectionData);
        return;
    }
    
    const oldDocumentIds = existingCollection.document_ids || [];
    const oldParentId = existingCollection.parent ? parseInt(existingCollection.parent) : null;
    
    // Update basic properties
    existingCollection.name = collectionData.name;
    existingCollection.description = collectionData.description;
    existingCollection.document_ids = collectionData.document_ids;
    
    // Handle parent change if necessary
    const newParentId = collectionData.parent_id ? parseInt(collectionData.parent_id) : null;
    const currentParentId = existingCollection.parent ? parseInt(existingCollection.parent) : null;
    if (currentParentId !== newParentId) {
        existingCollection.parent = newParentId;
        
        // Remove from old parent
        if (oldParentId) {
            const oldParent = findCollection(oldParentId);
            if (oldParent && oldParent.children) {
                const index = oldParent.children.findIndex(c => c.id === parseInt(collectionData.id));
                if (index !== -1) {
                    oldParent.children.splice(index, 1);
                }
            }
        } else {
            // Remove from root list
            const index = collections.findIndex(c => c.id === parseInt(collectionData.id));
            if (index !== -1) {
                collections.splice(index, 1);
            }
        }
        
        // Add to new parent
        if (collectionData.parent_id) {
            const newParent = findCollection(parseInt(collectionData.parent_id));
            if (newParent) {
                if (!newParent.children) {
                    newParent.children = [];
                }
                newParent.children.push(existingCollection);
            } else {
                // New parent not found, add to root level
                const isAlreadyInRoot = collections.some(col => col.id === existingCollection.id);
                if (!isAlreadyInRoot) {
                    collections.push(existingCollection);
                }
            }
        } else {
            // Add to root level
            const isAlreadyInRoot = collections.some(col => col.id === existingCollection.id);
            if (!isAlreadyInRoot) {
                collections.push(existingCollection);
            }
        }
    }
    
    // Update document collections
    // Remove from old documents
    for (let docId of oldDocumentIds) {
        const document = documents[docId.toString()];
        if (document && document.collections) {
            const index = document.collections.indexOf(parseInt(collectionData.id));
            if (index !== -1) {
                document.collections.splice(index, 1);
            }
        }
    }
    
    // Add to new documents
    if (collectionData.document_ids && collectionData.document_ids.length > 0) {
        for (let docId of collectionData.document_ids) {
            const document = documents[docId.toString()];
            if (document) {
                if (!document.collections) {
                    document.collections = [];
                }
                if (!document.collections.includes(parseInt(collectionData.id))) {
                    document.collections.push(parseInt(collectionData.id));
                }
            }
        }
    }
    
    initDocumentsTreeview();
    
    // Expand parent and highlight updated collection
    if (collectionData.parent_id) {
        expandDocumentNodeParent(parseInt(collectionData.parent_id));
    } else if (oldParentId) {
        // If moved to root, expand the old parent to show the change
        expandDocumentNodeParent(oldParentId);
    } else if (!collectionData.parent_id && collectionData.document_ids.length > 0) {
        const nodeId = getNodeIdFromTreeviewByCollectionId(treeview_documents, collectionData.id);
        expandDocumentNode(treeview_documents, nodeId);
    }
        
    highlightCollection(collectionData.id);
}

function removeCollection(collectionId) {
    // Find collection in hierarchysss
    const collectionToRemove = findCollection(parseInt(collectionId));
    if (!collectionToRemove) {
        return;
    }
    
    // Remove from parent or root list
    if (collectionToRemove.parent) {
        const parent = findCollection(parseInt(collectionToRemove.parent));
        if (parent && parent.children) {
            const index = parent.children.findIndex(c => c.id === parseInt(collectionId));
            if (index !== -1) {
                parent.children.splice(index, 1);
            }
        }
    } else {
        // Remove from root list
        const index = collections.findIndex(c => c.id === parseInt(collectionId));
        if (index !== -1) {
            collections.splice(index, 1);
        }
    }
    
    // Remove from documents that belong to it
    if (collectionToRemove.document_ids && collectionToRemove.document_ids.length > 0) {
        for (let docId of collectionToRemove.document_ids) {
            const document = documents[docId.toString()];
            if (document && document.collections) {
                const index = document.collections.indexOf(parseInt(collectionId));
                if (index !== -1) {
                    document.collections.splice(index, 1);
                }
            }
        }
    }
    
    initDocumentsTreeview();
    
    // Expand parent to show the change
    if (collectionToRemove.parent) {
        expandDocumentNodeParent(parseInt(collectionToRemove.parent));
        highlightCollection(parseInt(collectionToRemove.parent));
    }
}

