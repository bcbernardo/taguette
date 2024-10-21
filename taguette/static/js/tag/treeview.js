const treeview_tags = $('#treeview-tags');
const treeview_tags_highlight = $('#treeview-tags-highlight');

const DEFAULT_LEVEL_OPTION = 5;
const CUSTOM_LEVEL_OPTION = 3;

let selectedTags = [];
let highlightSelectedTags = [];

let isExplorationMode = false;
let isProgrammaticSelection = false;

function getNode(treeview, nodeId) {
    return treeview.treeview('getNode', parseInt(nodeId));
}

function getAllNodes(treeview) {
    return treeview.treeview('getEnabled');
}

function getAllSelectedNodes(treeview) {
    return treeview.treeview('getSelected');
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
    if (node && node.state && !node.state.selected) {
        isProgrammaticSelection = true;
        treeview.treeview('selectNode', [node.nodeId, {silent: false}]);
        isProgrammaticSelection = false;
    } else {
        log(`Node with nodeId ${nodeId} not found or already selected.`);
    }
}

function unselectNode(treeview, nodeId) {
    const node = getNode(treeview, nodeId);
    if (node.state.selected) {
        treeview.treeview('unselectNode', [node.nodeId, {silent: false}]);
    }
}

function deselectAllNodes(treeview) {
    const allNodes = getAllNodes(treeview);
    allNodes.forEach(node => {
        if (node.state.selected) {
            treeview.treeview('unselectNode', [node.nodeId, {silent: false}]);
        }
    });
}

function toggleNodeSelection(treeview, nodeId, select = true) {
    const node = getNode(treeview, nodeId);
    //check if change is needed
    if (node.state.selected !== select) {
        const action = select ? 'selectNode' : 'unselectNode';
        treeview.treeview(action, [node.nodeId, {silent: false}]);
    }
}

function selectNodeAndChildren(treeview, nodeId) {
    isExplorationMode = true;
    isProgrammaticSelection = true;
    initTagsTreeview();
    setTimeout(() => {
        expandNode(treeview, nodeId);
        const node = getNode(treeview, nodeId);
        selectSingleNodeAndChildren(treeview, node);
    }, 10);

}

function unselectNodeAndChildren(treeview, nodeId) {
    setTimeout(() => {
        const node = getNode(treeview, nodeId);
        unselectSingleNodeAndChildren(treeview, node);
    }, 10);
}

function checkNodeHasSelectedChildren(node) {
    if (node.nodes && node.nodes.length > 0) {
        return node.nodes.some(function (childNode) {
            if (childNode.state.selected) {
                return true;
            }
            return checkNodeHasSelectedChildren(childNode);
        });
    }
    return false;
}

function checkNodeHasUnselectedChildren(node) {
    if (node.nodes && node.nodes.length > 0) {
        return node.nodes.some(function (childNode) {
            if (!childNode.state.selected) {
                return true;
            }
            return checkNodeHasUnselectedChildren(childNode);
        });
    }
    return false;
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


function expandNodeParent(tagParent) {
    const rootParentId = findRootParent(tagParent);
    const nodeId = getNodeIdFromTreeviewByTagId(treeview_tags, rootParentId);
    expandNode(treeview_tags, nodeId);
}

function expandNode(treeview, nodeId) {
    const node = getNode(treeview, nodeId);
    if (!node.state.expanded) {
        treeview.treeview('expandNode', [parseInt(nodeId, 10),
            {levels: DEFAULT_LEVEL_OPTION, silent: false}]);
        treeview.data('expanded', true);
    }
}

function collapseNode(treeview, nodeId) {
    const node = getNode(treeview, nodeId);
    if (node.state.expanded) {
        treeview.treeview('collapseNode', [parseInt(nodeId, 10),
            {silent: false}]);
    }
}

function toggleNodeExpansion(treeview, nodeId, expand = true) {
    const node = getNode(treeview, nodeId);
    // check action is expand or collapse
    const actionNeeded = expand ? !node.state.expanded : node.state.expanded;
    if (actionNeeded) {
        const action = expand ? 'expandNode' : 'collapseNode';
        treeview.treeview(action, [node.nodeId, {levels: DEFAULT_LEVEL_OPTION, silent: false}]);
    }
}

function expandAllNodes(treeview) {
    if (treeviewHasChildren(treeview) && !treeview.data('expanded')) {
        treeview.treeview('expandAll', {levels: DEFAULT_LEVEL_OPTION, silent: false});
        treeview.data('expanded', true);
    }
}

function collapseAllNodes(treeview) {
    if (treeview.length && treeview.data('expanded')) {
        treeview.treeview('collapseAll', {silent: false});
        treeview.data('expanded', false);
    }
}


// custom treeview function
function convertToTreeNode(data, includeTags) {

    function getNodeCount(item) {
        if (item.children.length > 0 && item.count === 0 && item.count_document === 0) {
            return { totalCount: '-', totalDocumentCount: '-' };
        } else {
            return { totalCount: item.count, totalDocumentCount: item.count_document };
        }
    }

    return data.map(item => {
        const node = {
            id: item.id,
            text: item.path,
            selectable: true,
            nodes: item.children.length > 0 ? convertToTreeNode(item.children, includeTags) : undefined
        };

        if (includeTags) {
            let counts = getNodeCount(item);
            node.tags = [`${counts.totalDocumentCount}`, `${counts.totalCount}`];
        }

        return node;
    });
}
function initTagsTreeview(filterTags = null) {

    if (filterTags == null) {
        filterTags = tags
    }

    const treeData = convertToTreeNode(filterTags, true);

    const customNodeOptions = customNodeRow(true);

    const options = {
        data: treeData,
        ...customNodeOptions,
        customizeBadges: function(container, node, tree) {
            container.addClass('d-flex align-items-center');
            if (node.tags && node.tags.length > 0) {
                container.append($('<span>', {
                    class: 'badge badge-primary ms-1',
                    title: 'Documents',
                    text: node.tags[0]
                }));
                if (node.tags.length > 1) {
                    container.append($('<span>', {
                        class: 'badge badge-secondary ms-1 ms-2',
                        title: 'Highlights',
                        text: node.tags[1]
                    }));
                }
            }
        },
        showBorder: true,
        levels: DEFAULT_LEVEL_OPTION,
        showTags: true
    };

    if (isExplorationMode) {
        options.multiSelect = true;
    }

    treeview_tags.treeview(options);
    treeview_tags.treeview('collapseAll');
    treeview_tags.data('expanded', false);

    treeview_tags.on('nodeSelected', function (event, node) {
        if (isExplorationMode && !isProgrammaticSelection){
            const collapse = node.parentId;
            emptyTagSelection(true, !collapse);
            setTimeout(() => {
                selectNode(treeview_tags, node.nodeId);
            }, 10);
        }
        addTagsHighlightSelection(node);
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
            addTagDragDrop();
        }, 10);
    });

    addTagDragDrop();
    emptyTagSelection();
}

function initTagsHighlightTreeview(filterTags = null) {

    if (filterTags == null) {
        filterTags = tags
    }

    const treeData = convertToTreeNode(filterTags, true);

    const customNodeOptions = customNodeRow();

    const options = {
        data: treeData,
        ...customNodeOptions,
        showBorder: true,
        levels: CUSTOM_LEVEL_OPTION,
        multiSelect: true,
    };

    treeview_tags_highlight.treeview(options);

    treeview_tags_highlight.on('nodeSelected', function (event, node) {
        if (!highlightSelectedTags.some(item => item === node.id)) {
            highlightSelectedTags.push(node.id);
            showHighlightTagSelection();
        }
    });

    treeview_tags_highlight.on('nodeUnselected', function (event, node) {
        savedSelections = savedSelections.filter(id => id !== node.id);
        highlightSelectedTags = highlightSelectedTags.filter(function (item) {
            return item !== node.id;
        });
        showHighlightTagSelection();
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
            if(window.history.state.tag_path === "") {
                loadTag('');
                selectAllTag();
            } else {
                window.history.back();
            }
            tags_return_link.hide();
        });
    } else {
        // reload the last document
       loadDocument(current_document)
    }
    setTimeout(function () {
        addTagDragDrop();
        showTagSelection();
    }, 10);
}

let selectCondition = 'or';

function selectWithCondition(treeview, nodeId, condition) {
    selectCondition = condition;

    if(isExplorationMode) {
        selectNode(treeview, nodeId);
    } else {
        isExplorationMode = true;
        const selectedNodes = getAllSelectedNodes(treeview);
        const node = getNode(treeview, nodeId);
        initTagsTreeview();
        if (node.parentId) {
            const tag = findTag(node.id);
            expandNodeParent(tag.parent);
        }
        selectedNodes.forEach(node => {
            selectNode(treeview, node.nodeId);
        });
        selectNode(treeview, nodeId);
    }

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
    if (node) {
        return node.id;
    } else {
        log(`Node with nodeId ${nodeId} not found in treeview.`);
        return null;
    }
}

function getNodeIdFromTreeviewByTagId(treeview, tagId) {
    const allNodes = getAllNodes(treeview);
    const node = allNodes.find((node) => node.id === parseInt(tagId));
    if (node) {
        return node.nodeId;
    } else {
        log(`Node with tagId ${tagId} not found in treeview.`);
        return null;
    }
}

function addTagDragDrop() {

    $('.node-treeview-tags').on('dragstart', function (event) {
        const nodeId = $(this).data('nodeid');
        event.originalEvent.dataTransfer.setData('text', nodeId);
    });

    $(".node-treeview-tags").each(function (index, element) {

        $(element).off('drop');
        $(element).off('dragover');

        $(element).on('dragover', function (event) {
            event.preventDefault();
        });

        $(element).on('drop', function (event) {
            event.preventDefault();

            const tagId = getTagIdFromTreeviewNode(treeview_tags, $(element).data("nodeid"));
            const draggedElementNodeId = event.originalEvent.dataTransfer.getData('text');

            if (!isNaN(parseInt(draggedElementNodeId))) {
                const tagChildId = getTagIdFromTreeviewNode(treeview_tags, draggedElementNodeId);
                if (tagId === tagChildId) return;
                updateTagParent(tagChildId, tagId);
            } else {
                saveHighlightDragDrop(tagId);
            }
        });
    });
}

function customNodeRow(isTagContextMenu = false) {

    return {
        customContent: true,
        nodeContentSelector: 'a',
        nodeContentAttributes: {
            href: '#',
            class: 'tag-text',
            style: 'text-decoration: none;'
        },
        customizeNode: function(element, node, tree) {
            element.attr('id', `${node.nodeId}`);
            if (isTagContextMenu) {
                element.addClass('tag-context-menu');
            }
        },
        addVerticalLine: function(element, node, tree) {
            const color = findTag(node.id).color;
            $('<span>', {
                class: `vertical-line-${node.id}`,
                css: {
                    display: 'inline-block',
                    position: 'absolute',
                    left: '0',
                    top: '0',
                    bottom: '0',
                    width: '3px',
                    backgroundColor: color,
                }
            }).prependTo(element);
        }
    }
}
