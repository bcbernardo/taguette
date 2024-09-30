$(document).ready(function() {
    const regEscape = v => v.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const $formSearch = $("#form-search-documents");
    const $inputSearch = $("#input-search-documents");
    const $divSearchResults = $("#ul-search-results");
    const minimumCharacters = 3;
    let searchTimeout = null;


    $inputSearch.keyup(function(){
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(function(){
            doSearch();
        }, 500);
    });

    $formSearch.submit(function(e){
        e.preventDefault();
        clearTimeout(searchTimeout);
        doSearch();

        return false;
    });

    $('button.page-selector').click(function(e) {
        e.stopPropagation();
        e.preventDefault();

        doSearch($(this).data('page'));

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

    function doSearch(page=1) {
        const searchText = $inputSearch.val().toLowerCase(),
            previousPage = page - 1,
            nextPage = page + 1;
        if(searchText.length < minimumCharacters) {
            log(`Not enough characters to search documents, ${minimumCharacters} or more characters are required`)
            return;
        }
        log(`Search in documents '${searchText}'`);
        $divSearchResults.html('');

        if(searchText !== '') {
            showSearchSpinner();

            getJSON(
                `/api/project/${project_id}/search/${encodeURIComponent(searchText)}?page=${page}`
            )
                .then(function (result) {
                    $("<li/>", {
                        'class': "dropdown-item disabled sticky first",
                        'html': gettext("Found in %(nb)s document(s)", {nb: result['nb_results']}) + `<span class='pagination'>${page} / ${result['pages']}</span>`
                    }).appendTo($divSearchResults);
                    if(result['nb_results'] > 0) {
                        $('#btn-search-previous-page').data('page', previousPage);
                        $('#btn-search-next-page').data('page', nextPage);
                        if(previousPage <= 0) {
                            $('#btn-search-previous-page').prop('disabled', true);
                        } else {
                            $('#btn-search-previous-page').prop('disabled', false);
                        }
                        log(`nextpage: ${nextPage} >= ${result['pages']}`)
                        if(nextPage > result['pages']) {
                            $('#btn-search-next-page').prop('disabled', true);
                        } else {
                            $('#btn-search-next-page').prop('disabled', false);
                        }
                        $('button.page-selector').show();
                    } else {
                        $('button.page-selector').hide();
                    }
                    for(let k in result['documents']) {
                        let d = result['documents'][k];
                        // Add document title
                        $("<li/>", {
                            'class': "dropdown-item disabled sticky",
                            'text': `${d['name']} (${d['occurences']} occurences)`
                        }).appendTo($divSearchResults);

                        // Find results and context
                        let results = d['contents'].split(new RegExp(regEscape(result['search_text']), "ig"));
                        for(let i=0; i<results.length-1; i++) {
                            let start = results[i].slice(-40),
                                end = results[i+1].slice(0, 40),
                                a = document.createElement('a');
                            a.className = "dropdown-item";
                            a.innerHTML = `...${start}<span class="search-item">${result['search_text']}</span>${end}...`
                            linkDocument(a, d['id'], null, `${result['search_text']}/${i}`);
                            $("<li/>").append(a).appendTo($divSearchResults);
                        }
                    }

                    // Force show
                    if(!$("#dropdown-trigger-search").hasClass('show')) {
                        $("#dropdown-trigger-search").dropdown('toggle');
                    }
                })
                .catch(function (error) {
                    log("Failed to search in documents", 'error', {error});
                    showAlert(gettext("Error searching documents!"), 'error', {error})
                })
                .then(function (result) {
                    hideSearchSpinner();
                });
        } else {
            clearSearchContent()
        }
    }
});