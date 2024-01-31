const SPLICE_DEFAULT_INDEX = 1;
const DEFAULT_COUNT = 0;
const findTag = (id) => {
    const recursiveSearch = (tag) => {
        if (tag.id === parseInt(id) || tag.path === id) {
            return tag;
        }

        if (tag.children) {
            for (const child of tag.children) {
                const found = recursiveSearch(child);
                if (found) {
                    return found;
                }
            }
        }

        return null;
    };

    for (const tag of tags) {
        const found = recursiveSearch(tag);
        if (found) {
            return found;
        }
    }

    return null;
};

const findTagAndDelete = (id) => {

    const tag = findTag(parseInt(id));

    if (tag.parent) {
        const parent = findTag(tag.parent);
        const indexToDelete = tag.children.findIndex(item => item.id === tag.id);
        parent.children.splice(indexToDelete, SPLICE_DEFAULT_INDEX);
    } else {
        const indexToDelete = tags.findIndex(item => item.id === tag.id);
        tags.splice(indexToDelete, SPLICE_DEFAULT_INDEX);
    }
};

/*
  addTag
 */
function addTag(tag) {
    // Check if the tag with the same id already exists
    let existingTag = findTag(tag.id);

    if (existingTag) {
        if (tag.parent) {
            // Tag has a parent

            if (!existingTag.parent) {
                // Existing tag had no parent
                const parentTag = findTag(tag.parent);
                findTagAndDelete(tag.id);

                // Update existing tag and move it to the new parent
                Object.assign(existingTag, tag);
                parentTag.children = parentTag.children || [];
                parentTag.children.push(existingTag);
            } else {
                // Existing tag already had a parent

                if (tag.parent === existingTag.parent) {
                    // Same parent, update existing tag
                    Object.assign(existingTag, tag);
                } else {
                    // Different parent, move the tag to the new parent
                    const parentTag = findTag(tag.parent);
                    const existingParent = findTag(existingTag.parent);

                    Object.assign(existingTag, tag);
                    parentTag.children = parentTag.children || [];
                    parentTag.children.push(existingTag);

                    // Remove from the previous parent
                    const indexToDelete = existingParent.children.findIndex(item => item.id === existingTag.id);
                    existingParent.children.splice(indexToDelete, SPLICE_DEFAULT_INDEX);
                }
            }
        } else {
            // Existing tag has parent, but the new tag has no parent
            if (existingTag.parent) {
                const parentTag = findTag(existingTag.parent);
                const indexToDelete = parentTag.children.findIndex(item => item.id === existingTag.id);
                parentTag.children.splice(indexToDelete, SPLICE_DEFAULT_INDEX);
                tags.push(existingTag);
            }

            // Update existing tag
            Object.assign(existingTag, tag);

        }
    } else {
        // Tag with the same id does not exist

        if (tag.parent) {
            // Find parent and add the new tag
            const parentTag = findTag(tag.parent);
            parentTag.children = parentTag.children || [];
            parentTag.children.push(Object.assign({count: DEFAULT_COUNT, children: []}, tag));
        } else {
            // Add new tag with default values
            tags.push(Object.assign({count: DEFAULT_COUNT, children: []}, tag));
        }
    }

    selected_tag_id = 0;
    updateTagsList();
}

function removeTag(id) {

    // Remove from list of tags
    findTagAndDelete(id)

    updateTagsList();
}

/*
 mergeTags
 */
function mergeTags(tag_src, tag_dest) {

    // update tag count value
    const tagToRemove = findTag(tag_src);
    const tagToUpdate = findTag(tag_dest);
    tagToUpdate.count = parseInt(tagToUpdate.count) + parseInt(tagToRemove.count);

    // Remove tag_src of list of tags
    findTagAndDelete(tag_src);

    updateTagsList();

    selectTag(treeview_tags, tag_dest)
}

function selectTag(treeview, tag_id) {
    const allNodes = treeview.treeview('getEnabled');
    const node = allNodes.find(item => item.id === tag_id)
    const nodeId = node.nodeId;
    treeview.treeview('selectNode', nodeId);
}

function selectAllTag() {
    const allNodes = treeview_tags.treeview('getEnabled');
    for(const node of allNodes) {
        const nodeId = node.nodeId;
        const nodeSelector = $('li[data-nodeid="' + nodeId + '"]');
        nodeSelector.addClass("node-selected")
        nodeSelector.css({ color: "#3498DB", backgroundColor: "#e7f2ff" });
    }
}

/*
 updateTagCount
 */
function updateTagCount(tagsId) {

    for (const key in tagsId) {
        const tagId = parseInt(key);
        const value = parseInt(tagsId[key]);
        const tagToUpdate = findTag(tagId);

        if (tagToUpdate) {
            tagToUpdate.count = parseInt(tagToUpdate.count) + value;
        }
    }

    initTagsTreeview(false);
}

/*
 updateTagsList
 */
function updateTagsList() {

    const isReverse = sortTags[1] === 'desc';
    console.log(sortTags)
    sortTagsByKey(tags, sortTags[0], isReverse);

    // update all treeview and select tags
    initTagsTreeview(false);

    initTagsHighlightTreeview(false);
    initTagHierarchySelect();
    initMergeTagHierarchySelect();
    hideSearchErrorMessage();
}

function sortTagsByKey(array, key, reverse) {
    const orderByX = reverse ? -1 : 1;

    array.sort((a, b) => {
        const keyA = typeof key === 'function' ? key(a) : a[key];
        const keyB = typeof key === 'function' ? key(b) : b[key];

        if (keyA < keyB) {
            return -1 * orderByX;
        } else if (keyA > keyB) {
            return 1 * orderByX;
        } else {
            return 0;
        }
    });

    // sort each level of "children"
    array.forEach(item => {
        if (item.children && item.children.length > 0) {
            sortTagsByKey(item.children, key, reverse);
        }
    });
}

function handleSearch(filterText) {

    return tags.filter(item => {

        if (item.path.toLowerCase().includes(filterText)) {
            return true;
        }

        // Check in children too
        if (item.children && item.children.length > 0) {
            const filteredChildren = item.children.filter(child => child.path.toLowerCase().includes(filterText));
            if (filteredChildren.length > 0) {
                return true;
            }
        }

        return false;
    });
}