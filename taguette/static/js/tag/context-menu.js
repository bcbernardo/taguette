function addContextMenu() {
    $.contextMenu({
        selector: '.tag-context-menu',
        build: function ($trigger, e) {
            const nodeId = $trigger.attr('id');

            const tagId = getTagIdFromTreeviewNode('treeview-tags', nodeId);
            const hasChildren = findTag(tagId).children.length > 0;

            const node = $('#treeview-tags').treeview('getNode', nodeId);

            const isExpanded = node.state.expanded;
            const isSelected = node.state.selected;

            return {
                callback: function (key, options) {
                    contextMenuAction(key, options.$trigger.attr("id"));
                },
                items: {
                    "toggleSelect": {
                        name: isSelected ? gettext('unselectAll') : gettext('selectAll'),
                        icon: "fa fa-eye",
                        visible: hasChildren,
                        callback: function(key, options) {
                            contextMenuAction(isSelected ? 'unselectAll' : 'selectAll', nodeId);
                        }
                    },
                    "toggleExpand": {
                        name: isExpanded ? gettext('collapse') : gettext('expand'),
                        icon: "fa fa-eye",
                        visible: hasChildren,
                        callback: function(key, options) {
                            contextMenuAction(isExpanded ? 'collapse' : 'expand', nodeId);
                        }
                    },
                    "edit": {name: gettext('edit'), icon: "edit"},
                    "merge": {name: gettext('merge'), icon: "copy"},
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
    const id = getTagIdFromTreeviewNode('treeview-tags', nodeId);
    switch (action) {
        case 'selectAll':
            selectNodeAndChildren('treeview-tags', nodeId);
            break;
        case 'unselectAll':
            unselectNodeAndChildren('treeview-tags', nodeId);
            break;
        case 'edit':
            editTag(id);
            break;
        case 'expand':
            expandNode('treeview-tags', nodeId);
            break;
        case 'collapse':
            collapseNode('treeview-tags', nodeId);
            break;
        case 'merge':
            mergeTag(id);
            break;
        case 'delete':
            deleteTag(id);
            break;
        case 'quit':
            break;
        default:
            console.log('No action found for: ' + action);
    }
}