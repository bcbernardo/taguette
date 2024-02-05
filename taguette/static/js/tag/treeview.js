const treeview_tags = $('#treeview-tags');
const treeview_tags_highlight = $('#treeview-tags-highlight');

const DEFAULT_LEVEL_OPTION = 5

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
        showTags: true
    };

    treeview_tags.treeview(options);

    if (collapse) {
        treeview_tags.treeview('collapseAll');
    }

    treeview_tags.on('nodeSelected', function (event, data) {
        const tag_path = data.text
        selected_tag_id = data.id
        const url = `${base_path}/project/${project_id}/highlights/${encodeURIComponent(tag_path)}`;
        event.preventDefault();
        window.history.pushState({tag_path: tag_path}, `Tag ${tag_path}`, url);
        loadTag(tag_path);
    });

    treeview_tags.on('nodeUnselected nodeCollapsed nodeExpanded', function (event, node) {
        loadTag();
    });

    addTagEditButton();
    addTagDragDrop();
}

function getTagIdFromTreeviewNode(treeview, node_id) {
    const allNodes = $(`#${treeview}`).treeview('getEnabled');
    const node = allNodes.find(item => item.nodeId === parseInt(node_id))
    return node.id;
}

function addTagEditButton() {
    $(".node-treeview-tags").each(function (index, element) {
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
                    const tag_id = getTagIdFromTreeviewNode('treeview-tags', $(element).data("nodeid"));
                    event.stopPropagation(); // Prevent event propagation
                    editTag(tag_id);
                }
            });

            secondDiv.append(editButton);
        }
    });
}

function addTagDragDrop() {

    $(".node-treeview-tags").each(function (index, element) {

        $(element).on('dragover', function (event) {
            event.preventDefault();
        });

        $(element).on('drop', function (event) {
            event.preventDefault();

            const tag_id = getTagIdFromTreeviewNode('treeview-tags', $(element).data("nodeid"));

            saveHighlightDragDrop(tag_id)
        });
    });
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
}