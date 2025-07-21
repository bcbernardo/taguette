const collection_hierarchy_select = $('#collection-hierarchy-select');
const document_collection_hierarchy_select = $('#document-collection-hierarchy-select');
const hs_menu_inner_collection = $('.hs-menu-inner');
const hs_menu_inner_document = $('.hs-menu-inner');

const COLLECTION_DEFAULT_LEVEL = 1;

// Creates a default 'None' option for collections
function addDefaultValueCollection(parentContainer) {
    const li = $("<li>");
    const a = $("<a>").addClass("dropdown-item")
        .attr("data-value", '')
        .attr("data-default-selected", '')
        .attr("data-level", COLLECTION_DEFAULT_LEVEL)
        .text(gettext('None'));
    li.append(a);

    parentContainer.append(li);
}

// Recursively generates items from collection hierarchy data
function generateCollectionHierarchyItem(data, parentContainer, level) {
    $.each(data, function (index, item) {
        const li = $("<li>");
        const a = $("<a>").addClass("dropdown-item")
            .attr("data-value", item.id)
            .attr("data-level", level)
            .attr("href", "#")
            .text(item.name);

        li.append(a);
        parentContainer.append(li);

        if (item.children && item.children.length > 0) {
            generateCollectionHierarchyItem(item.children, parentContainer, level + COLLECTION_DEFAULT_LEVEL);
        }
    });
}

// Init collection hierarchy select dropdown for create collection
function initCollectionHierarchySelect() {
    initHierarchySelectCollection(hs_menu_inner_collection, collection_hierarchy_select, true);
}

// Sets up a hierarchy select dropdown for collections
function initHierarchySelectCollection(menu, select, withDefault = true) {
    menu.html('');

    if(withDefault) {
        addDefaultValueCollection(menu);
    }

    generateCollectionHierarchyItem(collections, menu, COLLECTION_DEFAULT_LEVEL);

    select.hierarchySelect({
        width: 'auto'
    });
}

// Init document collection hierarchy select dropdown
function initDocumentCollectionHierarchySelect(initialValueSet = false) {
    initHierarchySelectCollection(hs_menu_inner_document, document_collection_hierarchy_select, true, initialValueSet);
}

// Init document change collection hierarchy select dropdown
function initDocumentChangeCollectionHierarchySelect(initialValueSet = false) {
    const document_change_collection_hierarchy_select = $('#document-change-collection-hierarchy-select');
    initHierarchySelectCollection(hs_menu_inner_document, document_change_collection_hierarchy_select, true, initialValueSet);
} 