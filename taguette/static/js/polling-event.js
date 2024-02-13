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
                        text_direction: event.text_direction
                    });
                } else if (event.type === 'document_delete') {
                    removeDocument(event.document_id);
                } else if (event.type === 'highlight_add') {
                    setHighlight({
                        id: event.highlight_id,
                        start_offset: event.start_offset,
                        end_offset: event.end_offset,
                        tags: event.tags
                    });
                } else if (event.type === 'highlight_delete') {
                    removeHighlight(event.highlight_id);
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