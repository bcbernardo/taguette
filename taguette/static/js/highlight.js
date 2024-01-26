// this file contains all ui business logic about setHighlight

/*
 * Highlights
 */

// Add or replace a highlight
function setHighlight(highlight) {
    var id = '' + highlight.id;
    if (highlights[id]) {
        removeHighlight(id);
    }
    highlights[id] = highlight;
    var tag_names = highlight.tags.map(function (id) {
        return findTag(id).path;
    });
    sortByKey(tag_names, function (path) {
        return path;
    });
    tag_names = tag_names.join(", ");
    try {
        highlightSelection([highlight.start_offset, highlight.end_offset], id, editHighlight, tag_names);
        console.log("Highlight set:", highlight);
    } catch (error) {
        console.error(
            "Error setting highlight ", highlight.id, " ", [highlight.start_offset, highlight.end_offset],
            ":", error,
        );
    }
}

// Remove a highlight
function removeHighlight(id) {
    id = '' + id;
    if (!highlights[id]) {
        return;
    }

    delete highlights[id];
    console.log("Highlight removed:", id);

    // Loop over highlight-<id> elements
    var elements = document.getElementsByClassName('highlight-' + id);
    for (var i = 0; i < elements.length; ++i) {
        // Move children up and delete this element
        var node = elements[i];
        while (node.firstChild) {
            node.parentNode.insertBefore(node.firstChild, node);
        }
        node.parentNode.removeChild(node);
    }
}

// Highlight a described selection
function highlightSelection(saved, id, clickedCallback, title) {
    console.log("Highlighting", saved);
    if (saved === null) {
        return;
    }
    var start = locatePos(saved[0]);
    start = splitAtPos(start, false);
    var end = locatePos(saved[1]);
    end = splitAtPos(end, true);

    var node = start;
    while (node !== end) {
        var next = nextElement(node);
        if (node.nodeType === 3 // TEXT_NODE
            && node.textContent
            && !node.textContent.match(onlyWhitespace)) {
            var span = document.createElement('a');
            span.className = 'highlight highlight-' + id;
            span.setAttribute('data-highlight-id', '' + id);
            span.setAttribute('title', title);
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
        console.log("Posting update for highlight " + id);
        request = postJSON(
            '/api/project/' + project_id + '/document/' + current_document + '/highlight/' + id,
            {
                start_offset: selection[0],
                end_offset: selection[1],
                tags: tags
            }
        );
    } else {
        console.log("Posting new highlight");
        request = postJSON(
            '/api/project/' + project_id + '/document/' + current_document + '/highlight/new',
            {
                start_offset: selection[0],
                end_offset: selection[1],
                tags: tags
            }
        );
    }
    showSpinner();
    request.then(function () {
        console.log("Highlight posted");
        $(highlight_add_modal).modal('hide');
        highlightModalReset();
    })
        .catch(function (error) {
            console.error("Failed to create highlight:", error);
            alert(gettext("Couldn't create highlight!") + "\n\n" + error);
        })
        .then(hideSpinner);
}
