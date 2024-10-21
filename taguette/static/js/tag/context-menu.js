
function addContextMenu() {
    $.contextMenu({
        selector: '.tag-context-menu',
        build: function ($trigger) {
            const nodeId = $trigger.attr('id');
            const node = getNode(treeview_tags, nodeId);

            let items = generateContextMenuItems(node);

            return {
                callback: (key, options) => contextMenuAction(key, options.$trigger.attr("id")),
                items
            };
        }
    });
}

function generateContextMenuItems(node) {

    const tagId = getTagIdFromTreeviewNode(treeview_tags, node.nodeId);
    const tag = findTag(tagId);

    const hasChildren = tag.children.length > 0;
    const hasParent = tag.parent > 0;
    const isExpanded = node.state.expanded;
    const isSelected = node.state.selected;

    const selectedNodes = getAllSelectedNodes(treeview_tags).length > 0;
    const hasSelectedChildren = checkNodeHasSelectedChildren(node);
    const hasUnselectedChildren = checkNodeHasUnselectedChildren(node);

    return {
        "toggleSelectAll": {
            name: gettext('selectAll'),
            icon: 'fas fa-eye',
            visible: hasUnselectedChildren && hasChildren,
            callback: (key, options) => contextMenuAction('selectAll', node.nodeId)
        },
        "toggleDeSelectAll": {
            name: gettext('unselectAll'),
            icon: 'fas fa-eye-slash',
            visible: hasChildren && hasSelectedChildren,
            callback: (key, options) => contextMenuAction('unselectAll', node.nodeId)
        },
        "toggleSelect": {
            name: gettext('Select With Condition'),
            icon: 'fas fa-check',
            visible: !isSelected && selectedNodes,
            items: {
                "andSelect": {
                    name: gettext('AND'),
                    icon: '',
                    callback: (key, options) => contextMenuAction('selectAnd', node.nodeId)
                },
                "orSelect": {
                    name: gettext('OR'),
                    icon: 'fas fa-union',
                    callback: (key, options) => contextMenuAction('selectOr', node.nodeId)
                },
                "notSelect": {
                    name: gettext('NOT'),
                    icon: 'fas fa-remove',
                    callback: (key, options) => contextMenuAction('selectNot', node.nodeId)
                }
            }
        },
        "toggleExpand": {
            name: isExpanded ? gettext('collapse') : gettext('expand'),
            icon: isExpanded ? 'fas fa-chevron-up' : 'fas fa-chevron-down',
            visible: hasChildren,
            callback: (key, options) => contextMenuAction(isExpanded ? 'collapse' : 'expand', node.nodeId)
        },
        "addChild": {
            name: gettext('Add child'),
            icon: "add",
            callback: (key, options) => contextMenuAction('addChild', tagId)
        },
        "edit": {
            name: gettext('edit'),
            icon: "edit",
            callback: (key, options) => contextMenuAction('edit', tagId)
        },
        "merge": {
            name: gettext('merge'),
            icon: "copy",
            callback: (key, options) => contextMenuAction('merge', tagId)
        },
        "deleteParent": {
            name: gettext('deleteParent'),
            icon: "delete",
            visible: hasParent,
            callback: (key, options) => contextMenuAction('deleteParent', tagId)
        },
        "delete": {
            name: gettext('delete'),
            icon: "delete",
            callback: (key, options) => contextMenuAction('delete', tagId)
        }
    };
}

function contextMenuAction(action, param) {
    const actionFunction = actions[action];

    if (actionFunction) {
        actionFunction(param);
    } else {
        console.log('No action found for:', action);
    }
}

const actions = {
    selectAll: nodeId => selectNodeAndChildren(treeview_tags, nodeId),
    unselectAll: nodeId => unselectNodeAndChildren(treeview_tags, nodeId),
    selectAnd: nodeId => selectWithCondition(treeview_tags, nodeId, 'and'),
    selectOr: nodeId => selectWithCondition(treeview_tags, nodeId, 'or'),
    selectNot: nodeId => selectWithCondition(treeview_tags, nodeId, 'not'),
    expand: nodeId => expandNode(treeview_tags, nodeId),
    collapse: nodeId => collapseNode(treeview_tags, nodeId),
    unselect: nodeId => unselectNode(treeview_tags, nodeId),
    edit: tagId => editTag(tagId),
    addChild: tagId => createTag(false, current_selection, tagId),
    merge: tagId => mergeTag(tagId),
    delete: tagId => deleteTag(tagId),
    deleteParent: tagId => removeTagParent(tagId)
};