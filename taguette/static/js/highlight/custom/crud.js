// CRUD operations for highlights (add, remove, update)

function addHighlight(highlight) {
    const id = '' + highlight.id;
    highlights[id] = highlight;

    document_lines.forEach(line => {
        if (highlight.end_offset > line.startOffset && highlight.start_offset < line.endOffset) {
            const divContainer = document.querySelector(`[data-line--id="line-${line.startOffset}-${line.endOffset}"]`);
            if (!divContainer) {
                return;
            }
            const useDefs = isFirefox();
            if (useDefs) {
                addHighlightWithDefs(line, highlight, divContainer);
            } else {
                addHighlightWithoutDefs(line, highlight, divContainer);
            }
        }
    });
}

function addHighlightWithDefs(line, highlight, divContainer) {
    const highlightsGroup = document.querySelector(`g[id="highlights-${line.startOffset}-${line.endOffset}"]`);
    if (!highlightsGroup) return;

    const existingLine = highlightsGroup.querySelector(`line[data-highlight-id="${highlight.id}"]`);
    if (existingLine) {
        removeHighlightWithDefs(line, highlight, divContainer);
    }

    const existingHighlightsCount = highlightsGroup.querySelectorAll('line').length;

    const textGroup = divContainer.querySelector(`g[data-line--id="line-group-${line.startOffset}-${line.endOffset}"]`);
    const range = createRanges(textGroup.querySelector('text'), highlight, line);

    range.items.forEach((rect, index) => {
        rect.y = calculateYPositionWithDefs(existingHighlightsCount);
        const lineElement = createSvgUnderline(textGroup, rect, highlight, true);
        highlightsGroup.appendChild(lineElement);
    });

    adjustLineHeight(divContainer, textGroup, existingHighlightsCount + 1);
}

function addHighlightWithoutDefs(line, highlight, divContainer) {
    const textGroup = divContainer.querySelector(`g[data-line--id="line-group-${line.startOffset}-${line.endOffset}"]`);
    if (!textGroup) return;

    const existingLine = textGroup.querySelector(`line[data-highlight-id="${highlight.id}"]`);
    if (existingLine) {
        removeHighlightWithoutDefs(line, highlight, divContainer);
    }

    const existingHighlightsCount = textGroup.querySelectorAll('line').length;

    const range = createRanges(textGroup.querySelector('text'), highlight, line);

    range.items.forEach((rect, index) => {
        rect.y = calculateYPosition(existingHighlightsCount);
        const lineElement = createSvgUnderline(textGroup, rect, highlight);
        textGroup.appendChild(lineElement);
    });

    adjustLineHeight(divContainer, textGroup, existingHighlightsCount + 1);
}

function removeHighlight(id, line = null) {
    id = '' + id;
    if (!highlights[id]) {
        return;
    }
    const highlight = highlights[id];

    const linesToCheck = line ? [line] : document_lines;

    linesToCheck.forEach(line => {
        if (highlight.end_offset > line.startOffset && highlight.start_offset < line.endOffset) {
            const divContainer = document.querySelector(`[data-line--id="line-${line.startOffset}-${line.endOffset}"]`);
            if (!divContainer) {
                return;
            }
            const useDefs = isFirefox();
            if (useDefs) {
                removeHighlightWithDefs(line, highlight, divContainer);
            } else {
                removeHighlightWithoutDefs(line, highlight, divContainer);
            }
        }
    });
}

function removeHighlightWithoutDefs(line, highlight, divContainer) {
    const textGroup = divContainer.querySelector(`g[data-line--id="line-group-${line.startOffset}-${line.endOffset}"]`);
    if (!textGroup) return;

    const highlightsToRemove = textGroup.querySelectorAll(`[data-highlight-id="${highlight.id}"]`);
    highlightsToRemove.forEach(hl => hl.remove());

    const gradientElement = document.querySelector(`#gradient-${highlight.id}`);
    if (gradientElement) gradientElement.remove();

    const remainingHighlights = textGroup.querySelectorAll('line[data-highlight-id]');
    updateHighlightPositions(textGroup, divContainer, remainingHighlights);
}

function removeHighlightWithDefs(line, highlight, divContainer) {
    const highlightsGroup = document.querySelector(`g[id="highlights-${line.startOffset}-${line.endOffset}"]`);
    if (!highlightsGroup) return;

    const highlightsToRemove = highlightsGroup.querySelectorAll(`[data-highlight-id="${highlight.id}"]`);
    highlightsToRemove.forEach(hl => hl.remove());

    const gradientElement = document.querySelector(`#gradient-${highlight.id}`);
    if (gradientElement) gradientElement.remove();

    const remainingHighlights = highlightsGroup.querySelectorAll('line[data-highlight-id]');
    updateHighlightPositions(highlightsGroup, divContainer, remainingHighlights, true);
}

function updateHighlightPositions(group, divContainer, highlights, useDefs = false) {
    highlights.forEach((hl, index) => {
        const newY = useDefs ? calculateYPositionWithDefs(index) : calculateYPosition(index);
        const isGradient = hl.getAttribute('stroke').startsWith('url(#gradient-');
        const newY2 = isGradient ? newY + 0.1 : newY;

        hl.setAttribute('y1', '' + newY);
        hl.setAttribute('y2', '' + newY2);
    });

    const lineCount = highlights.length;
    adjustLineHeight(divContainer, group, lineCount);
}

function saveHighlightDragDrop(tagId) {
    if (getHighlightVersion() === 'v2' && typeof ntv_saveHighlightDragDrop === 'function') {
        return ntv_saveHighlightDragDrop(tagId);
    }
    const selection = current_selection;
    const hl_tags = [tagId];

    const highlight = {
        selection,
        tags: hl_tags
    };

    const callbackSuccess = () => {
    };
    const callbackFail = (error) => {
        log("Failed to create highlight", 'error', {error})
        showAlert(`${gettext("Couldn't create highlight!")} \n\n`,'error');
    };

    submitHighLightCreation(highlight, callbackSuccess, callbackFail);
}

function submitHighLightCreation(highlight, callbackSuccess, callbackFail) {
    let request;
    const { id, selection, tags} = highlight;
    let requestData = {
        start_offset: selection[0],
        end_offset: selection[1],
        tags: tags,
    };

    if (highlight.id) {
        request = postJSON(
            `/api/project/${project_id}/document/${current_document}/highlight/${id}`,
            requestData
        );
    } else {
        request = postJSON(
            `/api/project/${project_id}/document/${current_document}/highlight/new`,
            requestData
        );
    }
    showSpinner();
    request.then(function (reply) {
        callbackSuccess(reply);
    }).catch(function (error) {
        callbackFail(error);
    }).finally(hideSpinner);
}

