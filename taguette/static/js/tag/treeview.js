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

    if (filterTags == null) {
        filterTags = tags
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
        if (!selectedTags.includes(data.id)) {
            selectedTags.push({
                id: data.id,
                path: data.text,
                condition: selectCondition
            });
        }
        loadTagsHighlights();
    });

    treeview_tags.on('nodeUnselected nodeCollapsed nodeExpanded', function (event, node) {

        if (event.type === 'nodeUnselected') {
            selectedTags = selectedTags.filter(function (tag) {
                return tag.id !== node.id;
            });
            loadTagsHighlights();
        }

        // Add a delay to ensure the treeview recreation is finished
        setTimeout(function () {
            addTagEditButton();
            addTagDragDrop();
        }, 10);
    });

    addTagEditButton();
    addTagDragDrop();
}

function loadTagsHighlights() {

    let selectedTagPathsString = '';
    selectedTags.forEach((tag, index) => {
        let conditionSymbol = '';
        if (index > 0) {
            if (tag.condition === 'and') {
                conditionSymbol = '&';
            } else if (tag.condition === 'or') {
                conditionSymbol = '|';
            } else if (tag.condition === 'not') {
                conditionSymbol = '!';
            }
        }
        selectedTagPathsString += `${conditionSymbol}${tag.path}`;
    });

    const url = `${base_path}/project/${project_id}/highlights/${encodeURIComponent(selectedTagPathsString)}`;
    window.history.pushState({tag_path: selectedTagPathsString}, `Tag ${selectedTagPathsString}`, url);

    if (selectedTags.length > 0) {
        loadTag(selectedTagPathsString);
    } else {
        document_contents.innerHTML = '<p style="font-style: oblique; text-align: center;">' + gettext("No highlights with this tag yet.") + '</p>';
    }
    setTimeout(function () {
        addTagEditButton();
        addTagDragDrop();
        showTagSelection();
    }, 10);
}

function getNode(treeview, nodeId) {
    const $treeview = $(`#${treeview}`);
    return $treeview.treeview('getNode', nodeId);
}

function expandNode(treeview, nodeId) {
    const $treeview = $(`#${treeview}`);
    const node = $treeview.treeview('getNode', nodeId);

    if (!node.state.expanded) {
        $treeview.treeview('expandNode', [parseInt(nodeId, 10),
            {levels: DEFAULT_LEVEL_OPTION, silent: false}]);
    }
}

function collapseNode(treeview, nodeId) {
    const $treeview = $(`#${treeview}`);
    const node = $treeview.treeview('getNode', nodeId);

    if (node.state.expanded) {
        $treeview.treeview('collapseNode', [parseInt(nodeId, 10),
            {silent: false}]);
    }
}

function expandAllNodes(treeviewId) {
    const $treeview = $(`#${treeviewId}`);
    if ($treeview.length && !$treeview.data('expanded')) {
        $treeview.treeview('expandAll', {levels: DEFAULT_LEVEL_OPTION, silent: false});
        $treeview.data('expanded', true);
    }
}

function collapseAllNodes(treeviewId) {
    const $treeview = $(`#${treeviewId}`);
    if ($treeview.length && $treeview.data('expanded')) {
        $treeview.treeview('collapseAll', {silent: false});
        $treeview.data('expanded', false);
    }
}

function selectNodeAndChildren(treeview, nodeId) {
    const $treeview = $(`#${treeview}`);
    const node = $treeview.treeview('getNode', parseInt(nodeId));
    expandNode('treeview-tags', nodeId);
    selectSingleNodeAndChildren($treeview, node);
}

function unselectNodeAndChildren(treeview, nodeId) {
    const $treeview = $(`#${treeview}`);
    const node = $treeview.treeview('getNode', parseInt(nodeId));
    unselectSingleNodeAndChildren($treeview, node);
}

let selectCondition = 'or';
function selectWithCondition(treeview, nodeId, condition) {
    selectCondition = condition;
    selectNode(treeview, nodeId);
    selectCondition = 'or';
}

function selectNode(treeview, nodeId) {
    const $treeview = $(`#${treeview}`);
    const node = $treeview.treeview('getNode', parseInt(nodeId));
    if (node.state.selected) {
        return;
    }
    $treeview.treeview('selectNode', [node.nodeId, {silent: false}]);
}

function unselectNode(treeview, nodeId) {
    const $treeview = $(`#${treeview}`);
    const node = $treeview.treeview('getNode', parseInt(nodeId));
    if (node.state.selected) {
        $treeview.treeview('unselectNode', [node.nodeId, {silent: false}]);
    }
}

function unselectSingleNodeAndChildren(treeview, node) {

    if (node.state.selected) {

        treeview.treeview('unselectNode', [node.nodeId, {silent: false}]);

        if (node.nodes && node.nodes.length > 0) {
            node.nodes.forEach(function (childNode) {
                unselectSingleNodeAndChildren(treeview, childNode);
            });
        }
    }
}

function selectSingleNodeAndChildren(treeview, node) {

    if (node.state.selected) {
        return;
    }

    treeview.treeview('selectNode', [node.nodeId, {silent: false}]);

    if (node.nodes && node.nodes.length > 0) {
        node.nodes.forEach(function (childNode) {
            selectSingleNodeAndChildren(treeview, childNode);
        });
    }
}

function getTagIdFromTreeviewNode(treeview, nodeId) {
    const allNodes = $(`#${treeview}`).treeview('getEnabled');
    const node = allNodes.find(item => item.nodeId === parseInt(nodeId))
    return node.id;
}

function getNodeIdFromTreeviewByTagId(treeview, tagId) {
    const allNodes = $(`#${treeview}`).treeview('getEnabled');
    const node = allNodes.find((node) => node.id === parseInt(tagId));
    return node.nodeId;
}

function initTagsHighlightTreeview(collapse = true, filterTags = null) {

    if (filterTags == null) {
        filterTags = tags
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
        setTimeout(function () {
            addTagUnderLineHighlightTreeview();
        }, 10);
    });
}

function addTagUnderLineHighlightTreeview() {
    $(".node-treeview-tags-highlight").each(function (index, element) {

        const tagId = getTagIdFromTreeviewNode('treeview-tags-highlight', $(element).data("nodeid"));
        const hasChildren = findTag(tagId).children.length > 0;

        if (!hasChildren) {
            const $icon = $(element).find('.icon');
            $icon.css('display', 'none');
        }

        addTagVerticalLine($(element), tagId);
    })
}

function addTagEditButton() {
    $(".node-treeview-tags").each(function (index, element) {

        const tagId = getTagIdFromTreeviewNode('treeview-tags', $(element).data("nodeid"));

        const hasChildren = findTag(tagId).children.length > 0;

        if (!hasChildren) {
            const $icon = $(element).find('.icon');
            $icon.css('display', 'none');
        }

        $(this).attr('id', `${$(element).data("nodeid")}`)
        $(this).addClass('tag-context-menu');

        addTagVerticalLine($(element), tagId);

        const secondDiv = $(element).find("div:eq(1)");

        // Check if the "Edit" button already exists
        if (secondDiv.find('.edit-button').length === 0) {

            secondDiv.addClass('d-flex align-items-center');
            secondDiv.find('.badge:first').removeClass().addClass('ms-1 badge badge-primary');
            secondDiv.find('.badge:eq(1)').removeClass().addClass('ms-1 badge badge-secondary ms-2');
        }
    });
}

function addTagVerticalLine(selector, tag_id) {
    // Find the first div within .node-treeview-tags
    const firstDiv = selector.find('div:first');

    if (firstDiv.find('a').length === 0) {
        // Get the text content
        const tagText = firstDiv.contents().filter(function () {
            return this.nodeType === 3; // Filter out text nodes
        }).text().trim();

        // Create an anchor element
        const tagTextAnchor = $('<a>', {
            href: '#',
            class: 'tag-text',
            style: 'text-decoration: none;',
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
                width: '3px',
                backgroundColor: findTag(tag_id).color,
            }
        }).prependTo(tagTextAnchor);

        // Wrap the text in the anchor element
        firstDiv.contents().filter(function () {
            return this.nodeType === 3;
        }).replaceWith(tagTextAnchor);
    } else {
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
                    width: '4px',
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

            if (!isNaN(parseInt(draggedElementNodeId))) {
                const tag_child_id = getTagIdFromTreeviewNode('treeview-tags', draggedElementNodeId);
                if (tag_id === tag_child_id) return;
                updateTagParent(tag_child_id, tag_id)
            } else {
                saveHighlightDragDrop(tag_id);
            }
        });
    });
}
