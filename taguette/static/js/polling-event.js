/*
 * Long polling
 */

let lastPoll = null;
let polling = true;
let windowLastActive = new Date();

if (document.hasFocus()) {
    windowLastActive = null; // Focused now
}

window.addEventListener('focus', function () {
    // We are active as long as we have the focus
    windowLastActive = null;
    maybeResumePolling();
});
window.addEventListener('mousemove', function () {
    if (windowLastActive !== null) {
        // If the mouse moved over the window, and we're not focused, refresh timer
        windowLastActive = new Date();
        maybeResumePolling();
    }
});
window.addEventListener('blur', function () {
    // We lost focus, start timer
    windowLastActive = new Date();
});

function maybeResumePolling() {
    if (!polling) {
        longPollForEvents();
    }
}

function longPollForEvents() {
    // If we've been inactive for 10min, pause polling for now
    if (windowLastActive !== null && (new Date() - windowLastActive > 600000)) {
        log("Browser window inactive, stop polling");
        polling = false;
        return;
    }

    polling = true;
    lastPoll = Date.now();
    getJSON(
        `/api/project/${project_id}/events`,
        {version: version, from: last_event}
    )
        .then(function (result) {
            if (result.reload) {
                log("Server sent signal to reload");
                window.location.reload();
                return;
            }
            for (let i = 0; i < result.events.length; ++i) {
                const event = result.events[i];
                if (event.type === 'project_meta') {
                    setProjectMetadata({
                        project_name: event.project_name,
                        description: event.description
                    });
                } else if (event.type === 'document_add') {
                    addDocument({
                        id: event.document_id,
                        name: event.document_name,
                        description: event.description,
                        favorite: event.favorite,
                        text_direction: event.text_direction,
                        collections: event.collections
                    });
                } else if (event.type === 'document_delete') {
                    deleteDocument(event.document_id);
                } else if (event.type === 'highlight_add') {
                    const highlightData = {
                        id: event.highlight_id,
                        start_offset: event.start_offset,
                        end_offset: event.end_offset,
                        snippet: event.snippet,
                        tags: event.tags
                    };
                    
                    if (getHighlightVersion() === 'v2' && typeof ntv_addHighlight === 'function') {
                        ntv_addHighlight(highlightData);
                    } else if (typeof addHighlight === 'function') {
                        addHighlight(highlightData);
                    }
                } else if (event.type === 'highlight_delete') {
                    if (getHighlightVersion() === 'v2' && typeof ntv_removeHighlight === 'function') {
                        ntv_removeHighlight(event.highlight_id);
                    } else if (typeof removeHighlight === 'function') {
                        removeHighlight(event.highlight_id);
                    }
                } else if (event.type === 'tag_add') {
                    addTag({
                        id: event.tag_id,
                        path: event.tag_path,
                        description: event.description,
                        color: event.tag_color,
                        parent: event.tag_parent
                    });
                } else if (event.type === 'tag_delete') {
                    removeTag(event.tag_id);
                } else if (event.type === 'tag_merge') {
                    mergeTags(event.src_tag_id, event.dest_tag_id);
                } else if (event.type === 'member_add') {
                    addMember(event.member, event.privileges);
                } else if (event.type === 'member_remove') {
                    removeMember(event.member);
                } else if (event.type === 'collection_add') {
                    addCollection({
                        id: event.collection_id,
                        name: event.collection_name,
                        description: event.description,
                        parent_id: event.parent_id,
                        document_ids: event.document_ids
                    });
                } else if (event.type === 'collection_delete') {
                    removeCollection(event.collection_id);
                } else if (event.type === 'collection_update') {
                    updateCollection({
                        id: event.collection_id,
                        name: event.collection_name,
                        description: event.description,
                        parent_id: event.parent_id,
                        document_ids: event.document_ids
                    });
                }

                if ('tag_count_changes' in event) {
                    updateTagCount(event.tag_count_changes)
                }
                last_event = event.id;
            }

            // Re-open connection
            setTimeout(longPollForEvents, 1);
        }, function (error) {
            log("Polling failed", 'error', {error})
            if (error instanceof ApiError && error.status === 403) {
                showAlert(gettext("It appears that you have been logged out."));
                window.location = '/';
            } else if (error instanceof ApiError && error.status === 404) {
                showAlert(gettext("You can no longer access this project."));
                window.location = '/';
            } else {
                setTimeout(longPollForEvents, Math.max(1, 5000 + lastPoll - Date.now()));
            }
        })
        .catch(function (error) {
            log("Polling function error", 'error', {error})
        });
}

longPollForEvents();