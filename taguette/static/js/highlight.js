// this file contains all ui business logic about setHighlight

/*
 * Highlights
 */

// Add or replace a highlight
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
    try {
        highlightSelection([highlight.start_offset, highlight.end_offset], id, editHighlight, tag_names);
        log(`Highlight set ${highlight}`);
    } catch (error) {
        log(`Error setting highlight ${highlight.id} [${highlight.start_offset} ${highlight.end_offset}]`, 'error', {error})
    }
}

// Remove a highlight
function removeHighlight(id) {
    id = '' + id;
    if (!highlights[id]) {
        return;
    }

    delete highlights[id];
    log(`Highlight removed: ${id}`);

    // Loop over highlight-<id> elements
    $(`.highlight-${id}`).each(function() {
        // Move children up and delete this element
        while (this.firstChild) {
            $(this.firstChild).insertBefore(this);
        }
        $(this).remove();
    });
}

// Highlight a described selection
function highlightSelection(saved, id, clickedCallback, title) {
    log(`Highlighting ${saved}`);
    if (saved === null) {
        return;
    }
    let start = locatePos(saved[0]);
    start = splitAtPos(start, false);
    let end = locatePos(saved[1]);
    end = splitAtPos(end, true);

    const colors = title.split(',').map((path) => findTag(path.trim()).color);
    const gradientString = `linear-gradient(90deg, ${colors.join(', ')})`;

    let node = start;
    while (node !== end) {
        let next = nextElement(node);
        if (node.nodeType === 3 // TEXT_NODE
            && node.textContent
            && !node.textContent.match(onlyWhitespace)) {
            let span = document.createElement('a');
            span.className = 'highlight highlight-' + id;
            span.setAttribute('data-highlight-id', '' + id);
            span.setAttribute('title', title);
            if(colors.length > 1) {
                span.setAttribute('style', `cursor: pointer; border-bottom: 5px solid transparent; border-image: ${gradientString}; border-image-slice: 1;`);
            } else {
                span.setAttribute('style', `cursor: pointer; border-bottom: 5px solid ${colors[0]};`);
            }
            span.addEventListener('click', clickedCallback);
            node.parentNode.insertBefore(span, node);
            span.appendChild(node);
        }
        node = next;
    }
}

// Save highlight drag drop
function saveHighlightDragDrop(tag_id) {

    const selection = current_selection;

    const hl_tags = [tag_id];

    const highlight = {
        selection,
        tags: hl_tags
    }

    //call submit
    submitHighLightCreation(highlight);

}

function submitHighLightCreation(highlight) {

    let request;
    const { id, selection, tags} = highlight;

    if (highlight.id) {
        log(`Posting update for highlight ${id}`);
        request = postJSON(
             `/api/project/${project_id}/document/${current_document}/highlight/${id}`,
            {
                start_offset: selection[0],
                end_offset: selection[1],
                tags: tags
            }
        );
    } else {
        log("Posting new highlight");
        request = postJSON(
            `/api/project/${project_id}/document/${current_document}/highlight/new`,
            {
                start_offset: selection[0],
                end_offset: selection[1],
                tags: tags
            }
        );
    }
    showSpinner();
    request.then(function () {
        log("Highlight posted");
        $(highlight_add_modal).modal('hide');
        highlightModalReset();
    })
        .catch(function (error) {
            log("Failed to create highlight", 'error', {error})
            showAlert(`${gettext("Couldn't create highlight!")} \n\n`,'error');
        })
        .then(hideSpinner);
}
