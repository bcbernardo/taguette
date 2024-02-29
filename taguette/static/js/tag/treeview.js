const treeview_tags = $('#treeview-tags');
const treeview_tags_highlight = $('#treeview-tags-highlight');

const DEFAULT_LEVEL_OPTION = 5

let selectedTags = []

function convertToTreeNode(data, includeTags) {
    return data.map(item => {
        const node = {
            id: item.id,
            text: item.path,
            selectable: true,
            nodes: item.children.length > 0 ? convertToTreeNode(item.children, includeTags) : undefined
        };

        if (includeTags) {
            node.tags = [`${item.count_document}`, `${item.count}`];
        }

        return node;
    });
}

function initTagsTreeview(collapse = true, filterTags = null) {

    if(filterTags == null) {
        filterTags  = tags
    }

    const treeData = convertToTreeNode(filterTags, true);

    const options = {
        data: treeData,
        showBorder: true,
        levels: DEFAULT_LEVEL_OPTION,
        multiSelect: true,
        showTags: true
    };

    treeview_tags.treeview(options);

    if (collapse) {
        treeview_tags.treeview('collapseAll');
    }

    treeview_tags.on('nodeSelected', function (event, data) {
        // Check if tag_path is not already in selectedTags to avoid duplicates
        if (!selectedTags.includes(data.id)) {
            selectedTags.push(data.id);
        }
        loadTagsHighlights();
    });

    treeview_tags.on('nodeUnselected nodeCollapsed nodeExpanded', function (event, node) {

        if(event.type === 'nodeUnselected') {
            selectedTags = selectedTags.filter(function(tag) {
                return tag !== node.id;
            });
            loadTagsHighlights();
        }

        // Add a delay to ensure the treeview recreation is finished
        setTimeout(function() {
            addTagEditButton();
            addTagDragDrop();
        }, 10);
    });

    addTagEditButton();
    addTagDragDrop();
}

function loadTagsHighlights() {
    // Join all selectedTags to create a string that can be appended to the URL
    const selectedTagIdsString = selectedTags.map(encodeURIComponent).join(',');
    const url = `${base_path}/project/${project_id}/highlights/${selectedTagIdsString}`;
    event.preventDefault();
    window.history.pushState({tag_path: selectedTagIdsString}, `Tag ${selectedTagIdsString}`, url);
    if(selectedTags.length > 0) {
        loadTag(selectedTagIdsString);
    } else {
        document_contents.innerHTML = '<p style="font-style: oblique; text-align: center;">' + gettext("No highlights with this tag yet.") + '</p>';
    }
    setTimeout(function() {
        addTagEditButton();
        addTagDragDrop();
    }, 10);
}

function getTagIdFromTreeviewNode(treeview, node_id) {
    const allNodes = $(`#${treeview}`).treeview('getEnabled');
    const node = allNodes.find(item => item.nodeId === parseInt(node_id))
    return node.id;
}

function getNodeIdFromTreeviewByTagId(treeview, tagId) {
    const allNodes = $(`#${treeview}`).treeview('getEnabled');
    const node = allNodes.find((node) => node.id === parseInt(tagId));
    return node.nodeId;
}

function initTagsHighlightTreeview(collapse = true, filterTags = null) {

    if(filterTags == null) {
        filterTags  = tags
    }

    const treeData = convertToTreeNode(filterTags, true);

    const options = {
        data: treeData,
        showBorder: true,
        showCheckbox: true,
        multiSelect: true,
    };

    treeview_tags_highlight.treeview(options);

    if (collapse) {
        treeview_tags_highlight.treeview('collapseAll');
    }

    addTagUnderLineHighlightTreeview()

    treeview_tags_highlight.on('nodeSelected nodeUnselected nodeCollapsed nodeExpanded', function (event, data) {
        // Add a delay to ensure the treeview recreation is finished
        setTimeout(function() {
            addTagUnderLineHighlightTreeview();
        }, 10);
    });
}

function addTagUnderLineHighlightTreeview() {
    $(".node-treeview-tags-highlight").each(function (index, element) {

        const tag_id = getTagIdFromTreeviewNode('treeview-tags-highlight', $(element).data("nodeid"));

        addTagVerticalLine($(element), tag_id);
    })
}

function addTagEditButton() {
    $(".node-treeview-tags").each(function (index, element) {

        const tag_id = getTagIdFromTreeviewNode('treeview-tags', $(element).data("nodeid"));

        addTagVerticalLine($(element), tag_id);

        const secondDiv = $(element).find("div:eq(1)");

        // Check if the "Edit" button already exists
        if (secondDiv.find('.edit-button').length === 0) {

            secondDiv.addClass('d-flex align-items-center');

            // Find and update the first badge with class 'badge-primary'
            const firstBadge = secondDiv.find('.badge:first');
            firstBadge.removeClass().addClass('ms-1 badge badge-primary rounded-pill');

            // Find and update the second badge with class 'badge-secondary'
            const secondBadge = secondDiv.find('.badge:eq(1)');
            secondBadge.removeClass().addClass('ms-1 badge badge-secondary rounded-pill ms-2');

            // Create the Edit button
            const editButton = $('<a>', {
                href: 'javascript:void(0);',
                class: 'btn btn-primary btn-sm ms-2 edit-button',
                text: 'Edit',
                click: function (event) {
                    event.stopPropagation(); // Prevent event propagation
                    editTag(tag_id);
                }
            });

            secondDiv.append(editButton);
        }
    });
}

function addTagVerticalLine(selector, tag_id) {
    // Find the first div within .node-treeview-tags
    const firstDiv = selector.find('div:first');

    if (firstDiv.find('a').length === 0) {
        // Get the text content
        const tagText = firstDiv.contents().filter(function() {
            return this.nodeType === 3; // Filter out text nodes
        }).text().trim();

        // Create an anchor element
        const tagTextAnchor = $('<a>', {
            href: '#',
            class: 'tag-text',
            style: 'text-decoration: none; position: relative; padding-left: 10px;',
            text: tagText
        });

        // Prepend a span to act as the vertical line
        $('<span>', {
            class: `vertical-line-${tag_id}`,
            css: {
                display: 'inline-block',
                position: 'absolute',
                left: '0',
                top: '0',
                bottom: '0',
                width: '5px',
                backgroundColor: findTag(tag_id).color,
            }
        }).prependTo(tagTextAnchor);

        // Wrap the text in the anchor element
        firstDiv.contents().filter(function() {
            return this.nodeType === 3;
        }).replaceWith(tagTextAnchor);
    }
    else {
        const existingLine = firstDiv.find(`.vertical-line-${tag_id}`);
        if (existingLine.length > 0) {
            existingLine.css('backgroundColor', findTag(tag_id).color);
        } else {
            $('<span>', {
                class: `vertical-line-${tag_id}`,
                css: {
                    display: 'inline-block',
                    position: 'absolute',
                    left: '0',
                    top: '0',
                    bottom: '0',
                    width: '5px',
                    backgroundColor: findTag(tag_id).color,
                }
            }).prependTo(firstDiv.find('.tag-text'));
        }
    }
}

function addTagDragDrop() {

    $('.node-treeview-tags').on('dragstart', function (event) {
        const nodeId = $(this).data('nodeid');
        // event.dataTransfer.effectAllowed = 'move'
        event.originalEvent.dataTransfer.setData('text', nodeId);
    });

    $(".node-treeview-tags").each(function (index, element) {

        $(element).on('dragover', function (event) {
            event.preventDefault();
        });

        $(element).on('drop', function (event) {
            event.preventDefault();

            const tag_id = getTagIdFromTreeviewNode('treeview-tags', $(element).data("nodeid"));
            const draggedElementNodeId = event.originalEvent.dataTransfer.getData('text');

            if(!isNaN(parseInt(draggedElementNodeId))) {
                const tag_child_id = getTagIdFromTreeviewNode('treeview-tags', draggedElementNodeId);
                if(tag_id === tag_child_id) return;
                updateTagParent(tag_child_id, tag_id)
            } else {
                saveHighlightDragDrop(tag_id);
            }
        });
    });
}
