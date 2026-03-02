function editHighlight() {
    const selection = describeSelection();
    if (selection) {
        createHighlight(selection);
        return;
    }

    highlightModalReset();
    const id = this.dataset.highlightId;
    const highlight = highlights['' + id];

    if (!highlight) {
        log('Highlight not found: ' + id, 'error');
        return;
    }

    document.getElementById('highlight-add-id').value = id;
    document.getElementById('highlight-add-start').value = highlight.start_offset;
    document.getElementById('highlight-add-end').value = highlight.end_offset;

    const hl_tags = highlight.tags;
    const allNodes = treeview_tags_highlight.treeview('getEnabled');

    for (const tagId of hl_tags) {
        highlightSelectedTags.push(tagId);
        const node = allNodes.find(n => n.id === tagId);
        if (node) treeview_tags_highlight.treeview('selectNode', node.nodeId);
    }

    showHighlightTagSelection();
    $(highlight_add_modal).modal('show').drags({handle: '.modal-header'});
}

function addHighlight(highlight) {
    const id = '' + highlight.id;
    highlights[id] = highlight;
    renderHighlights(Object.values(highlights));
}

function removeHighlight(highlightId) {
    const id = '' + highlightId;
    if (!highlights[id]) return;
    delete highlights[id];
    renderHighlights(Object.values(highlights));
}

function saveHighlightDragDrop(tagId) {
    const selection = globalThis.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    const container = document.getElementById('highlight-content');
    if (!container?.contains(range.commonAncestorContainer)) return;

    const snippet = range.toString().trim();
    if (!snippet) return;

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(container);
    beforeRange.setEnd(range.startContainer, range.startOffset);

    const afterRange = document.createRange();
    afterRange.selectNodeContents(container);
    afterRange.setStart(range.endContainer, range.endOffset);

    const startOffset = lengthUTF8(beforeRange.toString());
    const endOffset = startOffset + lengthUTF8(snippet);

    submitHighLightCreation(
        { selection: [startOffset, endOffset], tags: [tagId] },
        reply => addHighlight(reply),
        error => {
            log("Failed to create highlight", 'error', error);
            showAlert(`${gettext("Couldn't create highlight!")}`, 'error');
        }
    );
}

function submitHighLightCreation(highlight, callbackSuccess, callbackFail) {
    const { id, selection, tags } = highlight;
    const requestData = {
        start_offset: selection[0],
        end_offset: selection[1],
        tags: tags,
    };

    const url = id
        ? `/api/project/${project_id}/document/${current_document}/highlight/${id}`
        : `/api/project/${project_id}/document/${current_document}/highlight/new`;

    showSpinner();
    postJSON(url, requestData).then(callbackSuccess).catch(callbackFail).finally(hideSpinner);
}
