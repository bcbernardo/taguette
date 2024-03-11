function addContextMenu() {
    $.contextMenu({
        selector: '.tag-context-menu',
        build: function ($trigger, e) {
            const nodeId = $trigger.attr('id');

            const tagId = getTagIdFromTreeviewNode('treeview-tags', nodeId);
            const tag = findTag(tagId);
            const hasChildren = tag.children.length > 0;
            const hasParent = tag.parent > 0;

            const node = getNode('treeview-tags', nodeId);

            const isExpanded = node.state.expanded;
            const isSelected = node.state.selected;

            const selectedNodes = $('#treeview-tags').treeview('getSelected');

            return {
                callback: function (key, options) {
                    contextMenuAction(key, options.$trigger.attr("id"));
                },
                items: {
                    "toggleSelectAll": {
                        name: isSelected ? gettext('unselectAll') : gettext('selectAll'),
                        icon: "",
                        visible: hasChildren,
                        callback: function (key, options) {
                            contextMenuAction(isSelected ? 'unselectAll' : 'selectAll', nodeId);
                        }
                    },
                    "toggleSelect": {
                        name: gettext(isSelected ? 'Unselect' : 'Select'),
                        icon: "",
                        visible: selectedNodes.length > 0,
                        items: isSelected ? null : {
                            "andSelect": {
                                name: gettext('AND'),
                                icon: "",
                                callback: function (key, options) {
                                    contextMenuAction('selectAnd', nodeId);
                                }
                            },
                            "orSelect": {
                                name: gettext('OR'),
                                icon: "",
                                callback: function (key, options) {
                                    contextMenuAction('selectOr', nodeId);
                                }
                            },
                            "notSelect": {
                                name: gettext('NOT'),
                                icon: "",
                                callback: function (key, options) {
                                    contextMenuAction('selectNot', nodeId);
                                }
                            }
                        },
                        callback: isSelected ? function (key, options) {
                            contextMenuAction('unselect', nodeId);
                        } : null,
                    },
                    "toggleExpand": {
                        name: isExpanded ? gettext('collapse') : gettext('expand'),
                        icon: function () {
                            return '';
                        },
                        visible: hasChildren,
                        callback: function (key, options) {
                            contextMenuAction(isExpanded ? 'collapse' : 'expand', nodeId);
                        }
                    },
                    "edit": {name: gettext('edit'), icon: "edit"},
                    "merge": {name: gettext('merge'), icon: "copy"},
                    "deleteParent": {
                        name: gettext('deleteParent'),
                        visible: hasParent,
                        icon: "delete"
                    },
                    "delete": {name: gettext('delete'), icon: "delete"},
                    "quit": {
                        name: gettext('quit'),
                        icon: function () {
                            return 'context-menu-icon context-menu-icon-quit';
                        }
                    }
                }
            };
        }
    });
}

function contextMenuAction(action, nodeId) {
    const tagId = getTagIdFromTreeviewNode('treeview-tags', nodeId);
    switch (action) {
        case 'selectAll':
            selectNodeAndChildren('treeview-tags', nodeId);
            break;
        case 'unselectAll':
            unselectNodeAndChildren('treeview-tags', nodeId);
            break;
        case 'selectAnd':
            selectWithCondition('treeview-tags', nodeId, 'and');
            break;
        case 'selectOr':
            selectWithCondition('treeview-tags', nodeId, 'or');
            break;
        case 'selectNot':
            selectWithCondition('treeview-tags', nodeId, 'not');
            break;
        case 'unselect':
            unselectNode('treeview-tags', nodeId);
            break;
        case 'edit':
            editTag(tagId);
            break;
        case 'expand':
            expandNode('treeview-tags', nodeId);
            break;
        case 'collapse':
            collapseNode('treeview-tags', nodeId);
            break;
        case 'merge':
            mergeTag(tagId);
            break;
        case 'delete':
            deleteTag(tagId);
            break;
        case 'deleteParent':
            removeTagParent(tagId);
            break;
        case 'quit':
            break;
        default:
            console.log('No action found for: ' + action);
    }
}