const SPLICE_DEFAULT_INDEX = 1;
const DEFAULT_COUNT = 0;

// Find a tag by its ID or path in the tag tree
const findTag = (id) => {
    // Recursive function to search for a tag
    const recursiveSearch = (tag) => {
        // Check if current tag matches the search criteria
        if (tag.id === parseInt(id) || tag.path === id) {
            return tag;
        }

        // Search in children if present
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

    // Iterate through all top-level tags
    for (const tag of tags) {
        const found = recursiveSearch(tag);
        if (found) {
            return found;
        }
    }

    return null;
}

// Find the root parent of tag
function findRootParent(tagId) {
    const tag = findTag(tagId);
    if (tag && tag.parent) {
        return findRootParent(tag.parent);
    }
    return tagId;
}

function highlightTag(tagId) {
    const nodeId = getNodeIdFromTreeviewByTagId(treeview_tags, tagId);
    const nodeElement = $(`li[data-nodeid="${nodeId}"]`);
    nodeElement.addClass('highlight-tag');
    setTimeout(() => {
        nodeElement.addClass('fade-out');
    }, 3000);
}


const findTagAndDelete = (id) => {

    const tag = findTag(parseInt(id));

    if (tag.parent) {
        const parent = findTag(tag.parent);
        const indexToDelete = parent.children.findIndex(item => item.id === tag.id);
        parent.children.splice(indexToDelete, SPLICE_DEFAULT_INDEX);
    } else {
        const indexToDelete = tags.findIndex(item => item.id === tag.id);
        tags.splice(indexToDelete, SPLICE_DEFAULT_INDEX);
    }
}

// Main function to add or update a tag
function addTag(tag) {
    // Check if the tag with the same id already exists
    let existingTag = findTag(tag.id);
    const existingTagColor =  existingTag?.color ?? '';

    if (existingTag) {
        updateExistingTag(existingTag, tag);
    } else {
        addNewTag(tag);
    }

    checkColorChangeAndUpdate(existingTagColor, tag.color);
    updateTagsList();
    if(!tag.parent) {
        if(!createTagFromHighlight) {
            highlightTag(tag.id);
        }
        return;
    }
    expandNodeParent(tag.parent);
    if(!createTagFromHighlight) {
        highlightTag(tag.id);
    }

}

// Function to add a new tag to the tag tree
function addNewTag(tag) {
    const newTag = {
        ...tag,
        count: DEFAULT_COUNT,
        count_document: DEFAULT_COUNT,
        children: []
    };

    if (tag.parent) {
        const parentTag = findTag(tag.parent);
        if (!parentTag) {
            return;
        }
        parentTag.children = parentTag.children || [];
        parentTag.children.push(newTag);
    } else {
        tags.push(newTag);
    }
}

// Function to update an existing tag
function updateExistingTag(existingTag, newTag) {
    if (newTag.parent) {
        handleExistingTagWithParent(existingTag, newTag);
    } else {
        handleExistingTagWithoutParent(existingTag, newTag);
    }
}

// Handle updating an existing a tag that has a parent
function handleExistingTagWithParent(existingTag, newTag) {
    const newParent = findTag(newTag.parent);
    if (!newParent) {
        return;
    }

    if (!existingTag.parent) {
        // If the existing tag had no parent, move it to the new parent
        findTagAndDelete(newTag.id);
        moveTagToNewParent(existingTag, newParent);
    } else if (newTag.parent !== existingTag.parent) {
        // If the tag is moving to a different parent
        const oldParent = findTag(existingTag.parent);
        removeTagFromParent(existingTag, oldParent);
        moveTagToNewParent(existingTag, newParent);
    }

    // Update the existing tag with new properties
    Object.assign(existingTag, newTag);
}

// Handle updating an existing tag that has no parent
function handleExistingTagWithoutParent(existingTag, newTag) {
    if (existingTag.parent) {
        // If the existing tag had a parent, remove it from the parent and add to top level
        const oldParent = findTag(existingTag.parent);
        removeTagFromParent(existingTag, oldParent);
        tags.push(existingTag);
    }
    // Update the existing tag with new properties
    Object.assign(existingTag, newTag);
}

// Move a tag to a new parent
function moveTagToNewParent(tag, newParent) {
    newParent.children = newParent.children || [];
    newParent.children.push(tag);
}

// Remove a tag from its parent
function removeTagFromParent(tag, parent) {
    if (!parent || !parent.children) return;
    const index = parent.children.findIndex(child => child.id === tag.id);
    if (index !== -1) {
        parent.children.splice(index, 1);
    }
}

function checkColorChangeAndUpdate(oldColor, newColor) {
    if (oldColor !== '' && oldColor !== newColor) {
        updateAndLoadDocument();
    }
}

function updateAndLoadDocument() {
    const url = window.location.href;
    const documentPattern = /\/document\/(\d+)/;
    const match = url.match(documentPattern);

    if (match) {
        const doc_id = match[1];
        window.history.pushState({document_id: doc_id}, "Document " + doc_id, url);
        loadDocument(doc_id);
    }
}

function removeTag(id) {
    // Remove from list of tags
    const tagToDelete = findTag(id);
    findTagAndDelete(id);

    updateTagsList();
    if(!tagToDelete.parent) {
        return;
    }
    expandNodeParent(tagToDelete.parent);
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
    if(!tagToUpdate.parent) {
        return;
    }
    expandNodeParent(tagToUpdate.parent);
}

function selectAllTag() {
    expandAllNodes(treeview_tags);
    const allNodes = treeview_tags.treeview('getEnabled');
    for(const node of allNodes) {
        const nodeId = node.nodeId;
        const nodeSelector = $('li[data-nodeid="' + nodeId + '"]');
        nodeSelector.addClass("highlight-tag")
    }
}

/*
 updateTagCount
 */
function updateTagCount(tagsId) {

    let updateTagList = [];
    for (const key in tagsId) {
        const tagId = parseInt(key);
        const tagData = tagsId[key];
        const tagToUpdate = findTag(tagId);
        updateTagList.push(tagToUpdate);

        if (tagToUpdate) {
            tagToUpdate.count = tagData.highlights_count;
            tagToUpdate.count_document = tagData.documents_count;
        }
    }

    initTagsTreeview();

    for (const tag of updateTagList) {
        if(!tag.parent) {
            highlightTag(tag.id);
            continue;
        }
        const parentRoot = findRootParent(tag.id);
        expandNodeParent(parentRoot);
        highlightTag(tag.id);
    }
}

/*
 updateTagsList
 */
function updateTagsList() {

    const isReverse = sortTags[1] === 'desc';
    sortTagsByKey(tags, sortTags[0], isReverse);
    let selectedHighLightTags = [];

    if(createTagFromHighlight) {
        selectedHighLightTags = getAllSelectedNodes(treeview_tags_highlight).map(node => node.id)
    }

    // update all treeview and select tags
    initTagsTreeview();
    initTagsHighlightTreeview();
    initTagHierarchySelect();
    initMergeTagHierarchySelect();
    hideSearchErrorMessage();

    //check if create from highlight modal
    if(createTagFromHighlight) {
        selectedHighLightTags.forEach(id => {
            const nodeId = getNodeIdFromTreeviewByTagId(treeview_tags_highlight, id)
            selectNode(treeview_tags_highlight, nodeId);
        });
        const nodeId = getNodeIdFromTreeviewByTagId(treeview_tags_highlight, last_added_tag)
        selectNode(treeview_tags_highlight, nodeId);
    }
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
    function searchInChildren(item) {
        const filteredChildren = [];

        item.children.forEach(child => {
            const childMatches = child.path.toLowerCase().includes(filterText);
            const matchingChildren = searchInChildren(child);

            if (childMatches || matchingChildren.length > 0) {
                filteredChildren.push({
                    ...child,
                    children: matchingChildren
                });
            }
        });

        return filteredChildren;
    }

    return tags
        .map(item => {
            const matches = item.path.toLowerCase().includes(filterText);
            const filteredChildren = searchInChildren(item);

            if (matches || filteredChildren.length > 0) {
                return {
                    ...item,
                    children: filteredChildren
                };
            }

            return null;
        })
        .filter(item => item !== null);
}

function submitTagCreation(tag, callbackSuccess, callbackFail) {

    const { id } = tag;
    let newTag = { ...tag };
    delete newTag.id;

    let request;
    if (id) {
        console.log(`Posting update for tag ${id}`);
        request = postJSON(`/api/project/${project_id}/tag/${id}`, newTag);
    } else {
        console.log("Posting new tag");
        request = postJSON(`/api/project/${project_id}/tag/new`, newTag);
    }

    showSpinner();
    request.then(function (reply) {
        callbackSuccess(reply);
    }).catch(function (error) {
        callbackFail(error);
    }).finally(hideSpinner);
}

function submitTagDelete(tag_id, callbackSuccess, callbackFail) {

    const request = deleteURL(`/api/project/${project_id}/tag/${tag_id}`)

    request.then(function (result) {
        callbackSuccess(result);
    }).catch(function (error) {
        callbackFail(error);
    }).finally(hideSpinner);
}

function submitTagMerge(tag_src, tag_dest, callbackSuccess, callbackFail) {

    const request =  postJSON(`/api/project/${project_id}/tag/merge`,
                                {src: tag_src, dest: tag_dest})

    showSpinner();
    request.then(function (result) {
        callbackSuccess(result);
    }).catch(function (error) {
        callbackFail(error);
    }).finally(hideSpinner);
}

// update tag parent
function updateTagParent(child_tag_1, new_parent_tag_id) {
    const tag = findTag(child_tag_1);
    if(tag.parent === new_parent_tag_id) return;
    const new_tag = {
        id: tag.id,
        path: tag.path,
        description: tag.description,
        color: tag.color,
        parent_id: new_parent_tag_id
    };
    submitTagCreation(new_tag, () => {}, () => {});
}

// update tag parent
function removeTagParent(tagId) {
    const tag = findTag(tagId);
    tag.parent_id = null;
    submitTagCreation(tag,
        () => {},
        () => {}
    );
}

function generateTagBadgeHtml(tag, index, condition) {
    const abbreviation = abbreviateTag(tag.path);
    let conditionTextHtml = "";
    if (index > 0) {
        conditionTextHtml = getConditionText(condition);
    }
    return `${conditionTextHtml}<span title="${tag.path}" class="tag-badge" style="background-color: ${tag.color};">
        ${abbreviation}
        <button onclick="removeTagBadge(${tag.id})" class="tag-badge-button">x</button>
    </span>`;
}

function generateTagBadgeForHighlight(tag) {
    const abbreviation = abbreviateTag(tag.path);
    return `<span class="tag-badge me-2 my-2" title="${tag.path}" style="background-color: ${tag.color};">
        ${abbreviation}
        <button onclick="removeHighLightSelectedTagBadge(${tag.id})" class="tag-badge-button">x</button>
    </span>`;
}

function getConditionText(condition) {
    switch (condition) {
        case 'and':
            return `<span style="margin: 5px;">et</span>`;
        case 'or':
            return `<span style="margin: 5px;">ou</span>`;
        case 'not':
            return `<span style="margin: 5px;">sans</span>`;
    }
}

function showTagSelection() {
    const tagsCriteria = $('#tag-selection-criteria-area');

    let content = '';
    if (selectedTags.length > 1) {
        content += `<div class="d-flex justify-content-between">`;
        content += `<span style='font-size: 0.9rem'>${gettext("Your selection")} :</span>`;
        content += `<span id="clear-selection" onclick="emptyTagSelection(true)" style="cursor:pointer;">` +
            `<i class="fa fa-times" aria-hidden="true" title="${gettext("Clear selection")}"></i></span>`;
        content += `</div>`;

        tagsCriteria.show();
        selectedTags.forEach((item, index) => {
            const tag = findTag(item.id);
            content += generateTagBadgeHtml(tag, index, item.condition);
        });
    } else {
        tagsCriteria.hide();
    }
    tagsCriteria.html(content);
}

function showHighlightTagSelection() {

    const HighlightSelectedTagsArea = $('#highlight-selected-tag-area');

    let content = '';

    if (highlightSelectedTags.length > 0) {
        content += `<div class="d-flex justify-content-between">`;
        content += `<span style='font-size: 0.9rem'>${gettext("Your selection")} :</span>`;
        content += `</div>`;

        HighlightSelectedTagsArea.show();
        highlightSelectedTags.forEach((item, index) => {
            const tag = findTag(item);
            content += generateTagBadgeForHighlight(tag, index, item.condition);
        });
    } else {
        HighlightSelectedTagsArea.hide();
    }
    HighlightSelectedTagsArea.html(content);

}

function emptyTagSelection(unSelectNode = false, collapse = true) {
    selectedTags = [];
    showTagSelection();
    hideTagReturnLink();
    if (unSelectNode) {
        deselectAllNodes(treeview_tags);
        isExplorationMode = false;
        initTagsTreeview();
    }
}

function hideTagReturnLink() {
    const tags_return = $('#tag-selection-return'),
        tags_return_link = $('a', tags_return);
    tags_return_link.hide();
}

function removeTagBadge(tagId) {
    selectedTags = selectedTags.filter(tag => tag.id !== tagId);
    showTagSelection();
    const nodeId = getNodeIdFromTreeviewByTagId(treeview_tags, tagId);
    unselectNode(treeview_tags, nodeId);
}

function removeHighLightSelectedTagBadge(tagId) {
    highlightSelectedTags = highlightSelectedTags.filter(item => item !== tagId);
    showHighlightTagSelection();
    const nodeId = getNodeIdFromTreeviewByTagId(treeview_tags_highlight, tagId);
    unselectNode(treeview_tags_highlight, nodeId);
}

function abbreviateTag(tagPath) {
    return tagPath;
}
