$(document).ready(function() {
    $('#entity_id-select').hierarchySelect({
        hierarchy: false,
        search: true,
        width: 'auto',
        initialValueSet: true
    });

    $("#cilogon").click(function(){
        let entity_id = encodeURIComponent($("#entity_id").val()),
            url = $(this).attr('href').split('?')[0],
            url_with_params = `${url}?entity_id=${entity_id}`;
        $(this).attr('href', url_with_params);
    });
})
