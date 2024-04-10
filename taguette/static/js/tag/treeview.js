const treeview_tags = $('#treeview-tags');
const treeview_tags_highlight = $('#treeview-tags-highlight');

const DEFAULT_LEVEL_OPTION = 5

let selectedTags = []

function getNode(treeview, nodeId) {
    const $treeview = $(`#${treeview}`);
    return $treeview.treeview('getNode', parseInt(nodeId));
}

function getAllNodes(treeview) {
    const $treeview = $(`#${treeview}`);
    return $treeview.treeview('getEnabled');
}

function getAllSelectedNodes(treeview) {
    const $treeview = $(`#${treeview}`);
    return $treeview.treeview('getSelected');
}

function treeviewHasChildren(treeview) {

    const data = getAllNodes(treeview);

    // loop to check if nodes has children
    for (let i = 0; i < data.length; i++) {
        if (data[i].nodes && data[i].nodes.length > 0) {
            return true;
        }
    }

    return false;
}

function selectNode(treeview, nodeId) {
    const node = getNode(treeview, nodeId);
    if (!node.state.selected) {
        const $treeview = $(`#${treeview}`);
        $treeview.treeview('selectNode', [node.nodeId, {silent: false}]);
    }
}

function unselectNode(treeview, nodeId) {
    const $treeview = $(`#${treeview}`);
    const node = getNode(treeview, nodeId);
    if (node.state.selected) {
        $treeview.treeview('unselectNode', [node.nodeId, {silent: false}]);
    }
}

function deselectAllNodes(treeview) {
    const $treeview = $(`#${treeview}`);
    const allNodes = getAllNodes(treeview);
    allNodes.forEach(node => {
        if (node.state.selected) {
            $treeview.treeview('unselectNode', [node.nodeId, {silent: false}]);
        }
    });
}

function toggleNodeSelection(treeview, nodeId, select = true) {
    const $treeview = $(`#${treeview}`);
    const node = getNode(treeview, nodeId);

    //check if change is needed
    if (node.state.selected !== select) {
        const action = select ? 'selectNode' : 'unselectNode';
        $treeview.treeview(action, [node.nodeId, {silent: false}]);
    }
}

function selectNodeAndChildren(treeview, nodeId) {
    const $treeview = $(`#${treeview}`);
    expandNode(treeview, nodeId);
    const node = getNode(treeview, nodeId);
    selectSingleNodeAndChildren($treeview, node);
}

function unselectNodeAndChildren(treeview, nodeId) {
    const $treeview = $(`#${treeview}`);
    const node = getNode(treeview, nodeId);
    unselectSingleNodeAndChildren($treeview, node);
}
function selectSingleNodeAndChildren(treeview, node) {

    if (!node.state.selected) {
        treeview.treeview('selectNode', [node.nodeId, {silent: false}]);
        if (node.nodes && node.nodes.length > 0) {
            node.nodes.forEach(function (childNode) {
                selectSingleNodeAndChildren(treeview, childNode);
            });
        }
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

function expandNode(treeview, nodeId) {

    const node = getNode(treeview, nodeId);

    if (!node.state.expanded) {
        const $treeview = $(`#${treeview}`);
        $treeview.treeview('expandNode', [parseInt(nodeId, 10),
            {levels: DEFAULT_LEVEL_OPTION, silent: false}]);
        $treeview.data('expanded', true);
    }
}

function collapseNode(treeview, nodeId) {

    const node = getNode(treeview, nodeId);

    if (node.state.expanded) {
        const $treeview = $(`#${treeview}`);
        $treeview.treeview('collapseNode', [parseInt(nodeId, 10),
            {silent: false}]);
    }
}

function toggleNodeExpansion(treeview, nodeId, expand = true) {
    const $treeview = $(`#${treeview}`);
    const node = getNode(treeview, nodeId);

    // check action is expand or collapse
    const actionNeeded = expand ? !node.state.expanded : node.state.expanded;

    if (actionNeeded) {
        const action = expand ? 'expandNode' : 'collapseNode';
        $treeview.treeview(action, [node.nodeId, {levels: DEFAULT_LEVEL_OPTION, silent: false}]);
    }
}

function expandAllNodes(treeview) {
    const $treeview = $(`#${treeview}`);
    if (treeviewHasChildren(treeview) && !$treeview.data('expanded')) {
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


// custom treeview function

function convertToTreeNode(data, includeTags) {

    // sum each tag count + document count
    function sumCounts(item) {
        let totalCount = item.count || 0;
        let totalDocumentCount = item.count_document || 0;
        if (item.children) {
            item.children.forEach(child => {
                let childCounts = sumCounts(child);
                totalCount += childCounts.totalCount;
                totalDocumentCount += childCounts.totalDocumentCount;
            });
        }
        return { totalCount, totalDocumentCount };
    }

    return data.map(item => {
        const node = {
            id: item.id,
            text: item.path,
            selectable: true,
            nodes: item.children.length > 0 ? convertToTreeNode(item.children, includeTags) : undefined
        };

        if (includeTags) {
            let counts = sumCounts(item);
            node.tags = [`${counts.totalDocumentCount}`, `${counts.totalCount}`];
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
    treeview_tags.data('expanded', true);

    if (collapse) {
        treeview_tags.treeview('collapseAll');
        treeview_tags.data('expanded', false);
    }

    treeview_tags.on('nodeSelected', function (event, data) {
        addTagsHighlightSelection(data);
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
            customizeNodeRow();
            addTagDragDrop();
        }, 10);
    });

    customizeNodeRow();
    addTagDragDrop();
    emptyTagSelection();
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

function addTagsHighlightSelection(data)
{
    if (!selectedTags.some(tag => tag.id === data.id)) {
        selectedTags.push({
            id: data.id,
            path: data.text,
            condition: selectCondition
        });
    }
}
function loadTagsHighlights() {

    let selectedTagPathsString = '';

    selectedTags.forEach((tag, index) => {
        let conditionSymbol = '';
        if (index > 0) {
            conditionSymbol = getConditionalSymbol(tag.condition);
        }
        selectedTagPathsString += `${conditionSymbol}${tag.path}`;
    });

    const url = `${base_path}/project/${project_id}/highlights/${encodeURIComponent(selectedTagPathsString)}`;
    window.history.pushState({tag_path: selectedTagPathsString}, `Tag ${selectedTagPathsString}`, url);

    const tags_return = $('#tag-selection-return'),
        tags_return_link = $('a', tags_return);
    tags_return_link.unbind('click').hide();
    if (selectedTags.length > 0) {
        loadTag(selectedTagPathsString);
        tags_return_link.attr('href', url);
        tags_return_link.bind('click', function(e){
            e.preventDefault();
            console.log(window.history.state.tag_path);
            if(window.history.state.tag_path === "") {
                loadTag('');
                selectAllTag();
            } else {
                console.log('ici2');
                window.history.back();
            }
            tags_return_link.hide();
        });
    } else {
        document_contents.innerHTML = '<p style="font-style: oblique; text-align: center;">' + gettext("No highlights with this tag yet.") + '</p>';
    }
    setTimeout(function () {
        customizeNodeRow();
        addTagDragDrop();
        showTagSelection();
    }, 10);
}

let selectCondition = 'or';
function selectWithCondition(treeview, nodeId, condition) {
    selectCondition = condition;
    selectNode(treeview, nodeId);
    selectCondition = 'or';
}

function getConditionalSymbol(condition) {
    if (condition === 'and') {
        return '∩';
    } else if (condition === 'or') {
        return '∪';
    } else if (condition === 'not') {
        return  '¬';
    }
    return '';
}

function getTagIdFromTreeviewNode(treeview, nodeId) {
    const allNodes = getAllNodes(treeview);
    const node = allNodes.find(item => item.nodeId === parseInt(nodeId))
    return node.id;
}

function getNodeIdFromTreeviewByTagId(treeview, tagId) {
    const allNodes = getAllNodes(treeview);
    const node = allNodes.find((node) => node.id === parseInt(tagId));
    return node.nodeId;
}

function addTagUnderLineHighlightTreeview() {
    $(".node-treeview-tags-highlight").each(function (index, element) {

        const tagId = getTagIdFromTreeviewNode(
            'treeview-tags-highlight',
            $(element).data("nodeid"));

        const hasChildren = findTag(tagId).children.length > 0;

        if (!hasChildren) {
            const $icon = $(element).find('.icon');
            $icon.css('display', 'none');
        }

        addTagVerticalLine($(element), tagId);
    })
}

function customizeNodeRow() {
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

        secondDiv.addClass('d-flex align-items-center');
        secondDiv.find('.badge:first').removeClass().addClass('ms-1 badge badge-primary').attr('title', gettext("Documents"));
        secondDiv.find('.badge:eq(1)').removeClass().addClass('ms-1 badge badge-secondary ms-2').attr('title', gettext("Highlights"));

    });
}

function addTagVerticalLine(selector, tagId) {
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
            class: `vertical-line-${tagId}`,
            css: {
                display: 'inline-block',
                position: 'absolute',
                left: '0',
                top: '0',
                bottom: '0',
                width: '3px',
                backgroundColor: findTag(tagId).color,
            }
        }).prependTo(tagTextAnchor);

        // Wrap the text in the anchor element
        firstDiv.contents().filter(function () {
            return this.nodeType === 3;
        }).replaceWith(tagTextAnchor);
    } else {
        const existingLine = firstDiv.find(`.vertical-line-${tagId}`);
        if (existingLine.length > 0) {
            existingLine.css('backgroundColor', findTag(tagId).color);
        } else {
            $('<span>', {
                class: `vertical-line-${tagId}`,
                css: {
                    display: 'inline-block',
                    position: 'absolute',
                    left: '0',
                    top: '0',
                    bottom: '0',
                    width: '4px',
                    backgroundColor: findTag(tagId).color,
                }
            }).prependTo(firstDiv.find('.tag-text'));
        }
    }
}

function addTagDragDrop() {

    $('.node-treeview-tags').on('dragstart', function (event) {
        const nodeId = $(this).data('nodeid');
        event.originalEvent.dataTransfer.setData('text', nodeId);
    });

    $(".node-treeview-tags").each(function (index, element) {

        $(element).on('dragover', function (event) {
            event.preventDefault();
        });

        $(element).on('drop', function (event) {
            event.preventDefault();

            const tagId = getTagIdFromTreeviewNode('treeview-tags', $(element).data("nodeid"));
            const draggedElementNodeId = event.originalEvent.dataTransfer.getData('text');

            if (!isNaN(parseInt(draggedElementNodeId))) {
                const tagChildId = getTagIdFromTreeviewNode('treeview-tags', draggedElementNodeId);
                if (tagId === tagChildId) return;
                updateTagParent(tagChildId, tagId);
            } else {
                saveHighlightDragDrop(tagId);
            }
        });
    });
}
