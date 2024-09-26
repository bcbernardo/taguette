$(document).ready(function() {
    const regEscape = v => v.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const $formSearch = $("#form-search-documents");
    const $inputSearch = $("#input-search-documents");
    const $divSearchResults = $("#ul-search-results");
    let searchTimeout = null;

    $inputSearch.keyup(function(){
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(function(){
            doSearch();
        }, 500);
    });

    $formSearch.submit(function(e){
        e.preventDefault();
        doSearch();

        return false;
    });

    function showSearchSpinner() {
        $formSearch.addClass('searching');
    }

    function hideSearchSpinner() {
        $formSearch.removeClass('searching');
    }

    function clearSearchContent() {
        $divSearchResults.html('');
    }

    function doSearch() {
        const searchText = $inputSearch.val().toLowerCase(),
            url = `${base_path}/project/${project_id}/search/${encodeURIComponent(searchText)}`;
        // window.history.pushState({search_text: searchText}, `Search ${searchText}`, url);
        log(`Search in documents '${searchText}'`);
        $divSearchResults.html('');

        if(searchText !== undefined && searchText !== '') {
            showSearchSpinner();

            getJSON(
                `/api/project/${project_id}/search/${encodeURIComponent(searchText)}`
            )
                .then(function (result) {
                    for(let k in result['documents']) {
                        let d = result['documents'][k];
                        // Add document title
                        $("<ul/>", {
                            'class': "dropdown-item disabled",
                            'text': `${d['name']} (${d['occurences']})`
                        }).appendTo($divSearchResults)

                        // Find results and context
                        let results = d['contents'].split(new RegExp(regEscape(result['search_text']), "ig"));
                        for(let i=0; i<results.length-1; i++) {
                            let start = results[i].slice(-40),
                                end = results[i+1].slice(0, 40);
                            $("<ul/>").append(
                                $('<a/>', {
                                    'class': "dropdown-item",
                                    'html': `...${start}<span class="search-item">${result['search_text']}</span>${end}...`
                                })
                            ).appendTo($divSearchResults);
                        }
                    }
                })
                .catch(function (error) {
                    log("Failed to search in documents", 'error', {error});
                    showAlert(`${gettext("Error searching documents!")} \n \n`, 'error', {error})
                })
                .then(function (result) {
                    hideSearchSpinner();
                });
        } else {
            clearSearchContent()
        }
    }
});