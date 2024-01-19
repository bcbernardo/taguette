const treeview_tags = $('#treeview-tags');
const treeview_tags_highlight = $('#treeview-tags-highlight');

const edit_tag_button = $('#edit-tag-btn');

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
            node.tags = [`${item.count}`];
        }

        return node;
    });
}

function initTagsTreeview(collapse = true) {

    const treeData = convertToTreeNode(tags, true);

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
        edit_tag_button.removeClass('d-none');
        window.history.pushState({tag_path: tag_path}, `Tag ${tag_path}`, url);
        loadTag(tag_path);
    });

    treeview_tags.on('nodeUnselected', function (event, node) {
        edit_tag_button.addClass('d-none');
    });

    addEditButton()
}

function addEditButton() {
    console.log("add edit")
    $(".node-treeview-tags").each(function (index, element) {
        const secondDiv = $(element).find("div:eq(1)");

        secondDiv.addClass('d-flex align-items-center');

        // Find the existing badge within the second div and replace its classes
        const existingBadge = secondDiv.find('.badge');
        existingBadge.removeClass().addClass('ml-3 badge rounded-pill badge-secondary');


        // Create the Edit button
        const editButton = $('<a>', {
            href: 'javascript:void(0);', // Update to prevent default action
            class: 'btn btn-primary btn-sm ms-2',
            text: 'Edit',
            click: function (event) {
                const allNodes = treeview_tags.treeview('getEnabled');
                const node = allNodes.find(item => item.nodeId === parseInt($(element).data("nodeid")))
                event.stopPropagation(); // Prevent event propagation
                editTag(node.id);
            }
        });

        secondDiv.append(editButton);
    });
}

function initTagsHighlightTreeview(collapse = true) {
    const treeData = convertToTreeNode(tags, false);

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