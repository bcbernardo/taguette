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
}

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
}

/*
  addTag
 */
function addTag(tag) {
    // Check if the tag with the same id already exists
    let existingTag = findTag(tag.id);
    const existingTagColor =  existingTag?.color ?? '';

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
            parentTag.children.push(Object.assign({count: DEFAULT_COUNT,
                count_document: DEFAULT_COUNT,
                children: []}, tag));
        } else {
            // Add new tag with default values
            tags.push(Object.assign({count: DEFAULT_COUNT,
                count_document: DEFAULT_COUNT,
                children: []}, tag));
        }
    }

    // Check if the tag color has changed
    if(existingTagColor !== '' && (existingTagColor !== tag.color)) {
        // Todo: check if tag is in highlight before update doc
        updateAndLoadDocument()
    }

    updateTagsList();
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
    sortTagsByKey(tags, sortTags[0], isReverse);

    // update all treeview and select tags
    initTagsTreeview(false);

    initTagsHighlightTreeview(false);
    initTagHierarchySelect();
    initMergeTagHierarchySelect();
    hideSearchErrorMessage();

    //check if create from highlight modal
    if(createTagFromHighlight) {
        console.log('tag from id');
        const nodeId = getNodeIdFromTreeviewByTagId('treeview-tags-highlight', last_added_tag)
        treeview_tags_highlight.treeview('selectNode', nodeId);
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
    return `${conditionTextHtml}<span title="${tag.path}" style="background-color: ${tag.color}; color: white; padding: 3px 8px; border-radius: 15px; margin-top: 15px; display: inline-flex; align-items: center; font-size: 0.8rem;">
        ${abbreviation}
        <button onclick="removeTagBadge(${tag.id})" style="background-color: transparent; border: none; color: white; cursor: pointer; margin-left: 5px;font-size: 1rem; font-weight: bold">x</button>
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
    const tagsCriteria = $('#tag-selection-criteria');

    let criteriaContent = selectedTags.length > 0 ?
        '<span id="clear-selection" class="mx-2" onclick="emptyTagSelection(true)" style="cursor:pointer;">' +
        '<i class="fa fa-times" aria-hidden="true" title="Clear selection"></i></span>' : '';

    if (selectedTags.length > 0) {
        criteriaContent += "<span style='font-size: 0.9rem'>" + gettext("Your selection") + " : <br/></span>";
        tagsCriteria.show();
        selectedTags.forEach((item, index) => {
            const tag = findTag(item.id);
            criteriaContent += generateTagBadgeHtml(tag, index, item.condition);
        });
    } else {
        tagsCriteria.hide();
    }

    tagsCriteria.html(criteriaContent);
}

function emptyTagSelection(unSelectNode = false) {
    //keep reselect instead of empty
    selectedTags = [];
    showTagSelection();
    hideTagReturnLink();

    if (unSelectNode) {
        deselectAllNodes('treeview-tags');
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
    const nodeId = getNodeIdFromTreeviewByTagId('treeview-tags', tagId);
    unselectNode('treeview-tags', nodeId);
}

function abbreviateTag(tagPath) {
    return tagPath;
}