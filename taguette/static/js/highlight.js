// this file contains all ui business logic about setHighlight

/*
 * Highlights
 */

function setHighlight(highlight) {
    const id = '' + highlight.id;
    if (highlights[id]) {
        removeHighlight(id);
    }
    highlights[id] = highlight;
    let tag_names = highlight.tags.map(function (id) {
        return findTag(id).path;
    });
    sortByKey(tag_names, function (path) {
        return path;
    });
    tag_names = tag_names.join(", ");

    // Recherche de chevauchements
    const overlaps = findOverlaps(highlight);

    try {
        applyHighlightDirectly(highlight, overlaps, tag_names);
        log(`Highlight set ${highlight}`);
    } catch (error) {
        log(`Error setting highlight ${highlight.id} [${highlight.start_offset} ${highlight.end_offset}]`, 'error', {error});
    }
}

function applyHighlightDirectly(highlight, overlaps, tag_names) {
    const isOverlap = overlaps.length > 0;
    let isContinuing = false;

    overlaps.forEach(overlap => {
        if (overlap.start_offset <= highlight.end_offset && overlap.end_offset >= highlight.start_offset) {
            isContinuing = true;
        }
    });

    // const combinedTitles = overlaps.map(overlap => overlap.tags.map(id => findTag(id).path).join(", ")).concat(tag_names).join(", ");

    highlightSelection([highlight.start_offset, highlight.end_offset], highlight.id, editHighlight, tag_names, isOverlap, isContinuing, overlaps.length);
}

function highlightSelection(saved, id, clickedCallback, title, isOverlap = false, isContinuing = false, overlapCount = 0) {
    log(`Highlighting ${saved}`);

    if (saved === null) {
        return;
    }

    let start = locatePos(saved[0]);
    start = splitAtPos(start, false);
    let end = locatePos(saved[1]);
    end = splitAtPos(end, true);

    const colors = title.split(',').map((path) => {
        const tag = findTag(path.trim());
        return tag ? tag.color : '#000000';
    });

    let node = start;
    let overlapOffset = overlapCount * 12;
    let parentP = null;

    let snippet = ""; // Variable pour accumuler le texte du snippet

    while (node !== end) {
        let next = nextElement(node);
        if (node.nodeType === 3 && node.textContent && !node.textContent.match(onlyWhitespace)) {

            // Ajouter le texte au snippet
            snippet += node.textContent;

            let span = document.createElement('a');
            span.className = 'highlight highlight-' + id;
            span.setAttribute('data-highlight-id', '' + id);
            span.style.position = 'relative';
            span.style.pointerEvents = 'none';

            const beforeElement = document.createElement('span');

            beforeElement.className = 'highlight highlight-' + id;
            beforeElement.setAttribute('data-highlight-id', '' + id);
            beforeElement.setAttribute('title', title);
            beforeElement.style.cursor = 'pointer';
            beforeElement.style.position = 'absolute';
            beforeElement.style.content = '""';
            beforeElement.style.width = '100%';
            beforeElement.style.height = '4px';
            beforeElement.style.backgroundColor = colors[0];
            beforeElement.style.pointerEvents = 'auto';

            if (!isOverlap) {
                beforeElement.style.bottom = `-3px`;
            } else if (isContinuing) {
                beforeElement.style.bottom = `-${overlapOffset}px`;
            }

            beforeElement.addEventListener('click', clickedCallback);
            span.appendChild(beforeElement);

            node.parentNode.insertBefore(span, node);
            span.appendChild(node);

            if (!parentP) {
                parentP = span.closest('p');
            }
        }
        node = next;
    }

    if (parentP) {
        const additionalMargin = overlapCount * 4;
        const currentMarginBottom = parseFloat(getComputedStyle(parentP).marginBottom) || 0;
        parentP.style.marginBottom = `${currentMarginBottom + additionalMargin}px`;
    }

    return snippet; // Retourne le snippet extrait
}

function findOverlaps(newHighlight) {
    return Object.values(highlights).filter(h =>
        h.id !== newHighlight.id &&
        ((h.start_offset < newHighlight.end_offset && h.end_offset > newHighlight.start_offset) ||
            (newHighlight.start_offset < h.end_offset && newHighlight.end_offset > h.start_offset))
    );
}

// Save highlight drag drop
function saveHighlightDragDrop(tag_id) {

    const selection = current_selection;

    const hl_tags = [tag_id];

    const highlight = {
        selection,
        tags: hl_tags
    }

    const callbackSuccess = () => {
        log("Highlight posted");
    };
    const callbackFail = (error) => {
        log("Failed to create highlight", 'error', {error})
        showAlert(`${gettext("Couldn't create highlight!")} \n\n`,'error');
    };

    //call submit
    submitHighLightCreation(highlight, callbackSuccess, callbackFail);

}

function getHighlightSelectionContent(currentHighlight) {

    let start = locatePos(currentHighlight[0]);
    start = splitAtPos(start, false);
    let end = locatePos(currentHighlight[1]);
    end = splitAtPos(end, true);

    let node = start;

    let snippet = "";

    while (node !== end) {
        let next = nextElement(node);
        if (node.nodeType === 3 && node.textContent && !node.textContent.match(onlyWhitespace)) {
            snippet += `<p>${node.textContent}</p>`;
        }
        node = next;
    }

    return snippet; // Retourne le snippet extrait
}
function submitHighLightCreation(highlight, callbackSuccess, callbackFail) {

    let request;
    const { id, selection, tags} = highlight;
    const snippet = getHighlightSelectionContent(selection);
    let requestData = {
        start_offset: selection[0],
        end_offset: selection[1],
        tags: tags,
        snippet: snippet
    };

    if (highlight.id) {
        log(`Posting update for highlight ${id}`);
        request = postJSON(
            `/api/project/${project_id}/document/${current_document}/highlight/${id}`,
            requestData
        );
    } else {
        log("Posting new highlight");
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

function removeHighlight(id) {
    id = '' + id;
    if (!highlights[id]) {
        return;
    }

    delete highlights[id];
    log(`Highlight removed: ${id}`);

    let affectedParents = new Set();

    // Loop over highlight-<id> elements
    $(`.highlight-${id}`).each(function() {
        const parentP = $(this).closest('p')[0];
        if (parentP) {
            affectedParents.add(parentP);
        }

        // Move children up and delete this element
        while (this.firstChild) {
            $(this.firstChild).insertBefore(this);
        }
        $(this).remove();
    });

    affectedParents.forEach(parentP => {
        const remainingHighlights = $(parentP).find('.highlight').length;

        if (remainingHighlights > 0) {
            const additionalMargin = remainingHighlights * 4;
            parentP.style.marginBottom = `${additionalMargin}px`;
        } else {
            parentP.style.marginBottom = '';
        }
    });
}


