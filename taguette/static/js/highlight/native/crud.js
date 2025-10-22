// Native CRUD operations for highlights

function ntv_editHighlight() {
    const selection = describeSelection();
    if (selection) {
        createHighlight(selection);
        return;
    }
    
    highlightModalReset();
    const id = this.getAttribute('data-highlight-id');
    const highlight = ntv_highlights['' + id];
    
    if (!highlight) {
        log('[ntv] Highlight not found:', 'error', { id });
        return;
    }
    
    document.getElementById('highlight-add-id').value = id;
    document.getElementById('highlight-add-start').value = highlight.start_offset;
    document.getElementById('highlight-add-end').value = highlight.end_offset;
    
    const hl_tags = highlight.tags;
    const allNodes = treeview_tags_highlight.treeview('getEnabled');
    
    for (let i = 0; i < hl_tags.length; ++i) {
        highlightSelectedTags.push(hl_tags[i]);
        const node = allNodes.find((node) => node.id === hl_tags[i]);
        if (node) {
            treeview_tags_highlight.treeview('selectNode', node.nodeId);
        }
    }
    
    showHighlightTagSelection();
    $(highlight_add_modal).modal('show').drags({handle: '.modal-header'});
}

function ntv_addHighlight(highlight) {
    const id = '' + highlight.id;
    ntv_highlights[id] = highlight;
    ntv_renderAllHighlights(Object.values(ntv_highlights));
}

function ntv_removeHighlight(highlightId) {
    const id = '' + highlightId;
    if (!ntv_highlights[id]) return;
    
    delete ntv_highlights[id];
    ntv_renderAllHighlights(Object.values(ntv_highlights));
}

// Save highlight via drag & drop
function ntv_saveHighlightDragDrop(tagId) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) {
        log("[ntv] No valid selection", 'error');
        return;
    }
    
    const range = selection.getRangeAt(0);
    const container = document.getElementById('ntv-document-content');
    
    if (!container || !container.contains(range.commonAncestorContainer)) {
        log("[ntv] Selection outside document", 'error');
        return;
    }
    
    const snippet = range.toString().trim();
    if (!snippet) {
        log("[ntv] Empty snippet", 'error');
        return;
    }
    
    // Extract context (100 chars before/after) for disambiguation
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(container);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const contextBefore = beforeRange.toString().slice(-100);
    
    const afterRange = document.createRange();
    afterRange.selectNodeContents(container);
    afterRange.setStart(range.endContainer, range.endOffset);
    const contextAfter = afterRange.toString().slice(0, 100);
    
    // Calculate UTF-8 byte offsets (for backend compatibility)
    const fullTextBefore = beforeRange.toString();
    let startOffset = 0;
    for (let i = 0; i < fullTextBefore.length; i++) {
        startOffset += ntv_lengthUTF8(fullTextBefore[i]);
    }
    
    let endOffset = startOffset;
    for (let i = 0; i < snippet.length; i++) {
        endOffset += ntv_lengthUTF8(snippet[i]);
    }
    
    const highlight = {
        snippet: snippet,
        context_before: contextBefore,
        context_after: contextAfter,
        start_offset: startOffset,
        end_offset: endOffset,
        tags: [tagId]
    };
    
    const callbackSuccess = (reply) => {
        ntv_addHighlight(reply);
    };
    
    const callbackFail = (error) => {
        log("[ntv] Failed to create highlight", 'error', error);
        showAlert(`${gettext("Couldn't create highlight!")}`, 'error');
    };
    
    ntv_submitHighLightCreation(highlight, callbackSuccess, callbackFail);
}

// Submit highlight creation/update to API
function ntv_submitHighLightCreation(highlight, callbackSuccess, callbackFail) {
    const { id, snippet, context_before, context_after, start_offset, end_offset, tags } = highlight;
    
    let requestData = {
        snippet, 
        context_before, 
        context_after, 
        start_offset, 
        end_offset, 
        tags
    };
    
    let request;
    if (id) {
        request = postJSON(
            `/api/project/${project_id}/document/${ntv_current_document}/highlight/${id}`,
            requestData
        );
    } else {
        request = postJSON(
            `/api/project/${project_id}/document/${ntv_current_document}/highlight/new`,
            requestData
        );
    }
    
    showSpinner();
    request.then(callbackSuccess).catch(callbackFail).finally(hideSpinner);
}
