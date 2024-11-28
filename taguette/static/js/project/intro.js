$(document).ready(function() {
    let demoElement = null,
        introjs_selection = null,
        current_step = 0,
        home_intro = introJs().setOptions({
            exitOnOverlayClick: true,
            exitOnEsc: true,
            steps: [
                {
                    title: gettext('Welcome to LibreQDA, a qualitative data analysis software (QDA) developed by the Plateforme en humanités numériques (PHuN) at Université de Sherbrooke.'),
                    intro: gettext('<p>Visit our <a href="https://gitlab.com/bin-cirst/libreqda/libre-qda" target="_blank">Gitlab repository</a></p>'),
                },
                {
                    element: document.querySelector('#intro-documentation'),
                    intro: gettext('<p>To consult the documentation</p>'),
                    position: 'bottom'
                },
                {
                    element: $('#demo-project-container .col:first')[0],
                    intro: gettext('<p>A demo project has been added to your home page.</p>'),
                    position: 'top',
                    doAction: 'create-demo-project'
                },
            ]
        }).
        setOption('disableInteraction', true).
        setOption("nextLabel", gettext('Next')).
        setOption("prevLabel", gettext('Back')).
        setOption("doneLabel", gettext('Continue')).
        onbeforechange(function (targetElement) {
            if(this._introItems[this._currentStep].doAction) {
                switch (this._introItems[this._currentStep].doAction) {
                    case 'create-demo-project':
                        if(demoElement === null) {
                            createDemoProject();
                        }
                        break;
                }
            }
        }).
        onafterchange(function(targetElement) {
            if(this._introItems[this._currentStep].doAction) {
                switch (this._introItems[this._currentStep].doAction) {
                    case 'create-demo-project':
                        setTimeout(function(){
                            repositionIntroJS('right');
                        }, 500);
                        break;
                }
            }
        }).
        oncomplete(function () {
            if(demoElement !== null) {
                demoElement.trigger('click');
            }
        }),
        project_intro = introJs().setOptions({
            showProgress: true,
            exitOnOverlayClick: true,
            exitOnEsc: true,
            hidePrev: true,
            keyboardNavigation: false,
            showBullets: false,
            steps: [
                {
                    element: document.querySelector("#right-panel"),
                    title: gettext('Your documents'),
                    intro: gettext('<p>Use this tab to load files and go through them.</p>'),
                    position: 'right',
                },
                { // #1
                    element: document.querySelector("#left-panel"),
                    title: gettext('Codebook'),
                    intro: gettext('<p>This tab lists all the codes that have been defined. Add new codes with the button dedicated to that purpose.</p><br><p>The total number of uses is indicated by the number on the right, and the number of documents on the left.</p>'),
                    position: 'right'
                },
                { // #2
                    element: document.querySelector("#treeview-tags"),
                    title: gettext('Parent codes'),
                    intro: gettext('<p>You can define codes that include child codes under them.</p>'),
                    position: 'right'
                },
                { // #3
                    element: $("[data-nodeid='1']")[0],
                    title: gettext('Child codes'),
                    intro: gettext('<p>These can be expanded or collapsed.</p>'),
                    position: 'right',
                    doAction: 'expand-tag-childrens'
                },
                { // #4
                    element: $("#documents-list > li:first-child")[0],
                    title: gettext('Consulting documents'),
                    intro: gettext('<p>Click on a document to view its contents. Use the star to save your bookmarks.</p>'),
                    position: 'left',
                },
                { // #5
                    element: document.querySelector("#document-highlight"), // This element doesn't exist
                    title: gettext('Coding'),
                    intro: gettext('<p>Select a portion of text with your cursor. Two buttons will appear to assign a code to the selection.</p>'),
                    position: 'bottom',
                    highlight: [195, 403],
                    nodes: [null, null],
                    highlight_context: [0, 0],
                    doAction: 'document-highlight' // Action to create wrapper for introjs
                },
                { // #6
                    element: document.querySelector("#highlight-add-form"),
                    title: gettext("Selecting a code"),
                    intro: gettext('<p>From the menu, select one or more codes that correspond to the content of the selection and save the changes. In this case, the selection refers to reinforcing social relationships.</p>'),
                    position: 'left',
                    tagPosition: [3],
                    doAction: 'document-selecttag' // Action to create wrapper for introjs
                },
                { //#14
                    element: document.querySelector("#left-panel"),
                    title: gettext('Exploring the codes'),
                    intro: gettext('<p>You can explore the text selections tagged with each code at any time during or after the coding process.</p><br><p> Show all of the selections tagged with a code from the codebook by clicking on it.</p>'),
                    position: 'right',
                },
                { //#15
                    element: document.querySelector("#document-view"),
                    title: gettext('Narrowing your search'),
                    intro: gettext('<p>If there are a large number of selections shown, you can refine the results with an advanced search.</p>'),
                    position: 'left',
                    doAction: 'exploration-mode'
                },
                { //#16
                    element: document.querySelector(".context-menu-root"),
                    title: gettext('Conditional selections'),
                    intro: gettext('<p>By right-clicking, you can specify conditions to either add or exclude additional codes.</p>'),
                    position: 'left',
                    which: 2,
                    doAction: 'select-condition'
                },
                { //#17
                    element: document.querySelector("#document-view"),
                    title: gettext('Exploring the list'),
                    intro: gettext('<p>The labels shown with this query indicate that the selections must necessarily include the codes <i>barriers</i> and <i>skills development</i>.</p>'),
                    position: 'left',
                    doAction: 'apply-condition'
                },
                { //#18
                    element: $('#document-contents .highlight-entry:first .badge')[0],
                    title: gettext('Navigating to documents'),
                    intro: gettext('<p>By clicking on the name of the document, you can return to the context.</p>'),
                    position: 'top',
                    doAction: 'select-badge'
                },
                { //#19
                    element: document.querySelector('#tag-selection-return'),
                    title: gettext('Returning to the selections'),
                    intro: gettext('<p>After consulting the context, you can return to the list of selections previously identified using the advanced search.</p>'),
                    position: 'right',
                    doAction: 'reposition-after-scroll'
                },
                { //#20
                    element: document.querySelector('#document-dropdown-export'),
                    title: gettext('Exporting'),
                    intro: gettext('<p>You can choose to download these selections to your computer, as needed.</p>'),
                    position: 'left',
                },
                { //#22
                    title: gettext('Time to code!'),
                    intro: gettext('<p>Use LibreQDA however you wish, knowing that your data is always saved to your personal account. Feel free to further familiarize yourself with these functions by continuing to code and explore these fictional interviews about board games.</p>'),
                    position: 'left',
                    doAction: 'last'
                },
            ]
        }).
        setOption('disableInteraction', true).
        setOption('scrollTo', 'tooltip').
        setOption("nextLabel", gettext('Next')).
        setOption("prevLabel", gettext('Back')).
        setOption("doneLabel", gettext('Done')).
        onbeforechange(function(targetElement) {
            if(targetElement) {
                // Always submit previous step before continuing
                if($("#highlight-add-modal").hasClass('show')) {
                    $("#highlight-add-form").submit();
                    introjs_selection = null;
                }
                if($("#tag-add-modal").hasClass('show')) {
                    $("#tag-add-form button[type='submit']").trigger('click');
                }

                switch(targetElement.id) {
                    case 'tag-selection-return':
                        $('#document-contents .highlight-entry:first .badge')[0].click();
                        this._introItems[this._currentStep].element = $("#tag-selection-return")[0];
                        break;

                    case 'document-dropdown-export':
                        window.scrollTo({
                            top: 0,
                            behavior: 'instant'
                        });
                        $("#tag-selection-return a").click();
                        break;
                }
                if(this._introItems[this._currentStep].doAction) {
                    switch(this._introItems[this._currentStep].doAction) {
                        case 'expand-tag-childrens':
                            $("[data-nodeid='1'] .expand-icon").trigger('click');
                            for(let i=1; i<=3; i++) {
                                $("[data-nodeid='" + i + "']").addClass('intro-js-tags-child')
                            }
                            $( ".intro-js-tags-child" ).wrapAll( "<div id='intro-js-wrapped' />");
                            // Fix duplicate elements
                            $("#intro-js-wrapped > li:eq(3)").remove();
                            // Force refresh dynamic element
                            this._introItems[this._currentStep].element = $("#intro-js-wrapped")[0];
                            break;
                        case 'document-highlight':
                            //Find where is the text to do the highlight
                            let start_str = this._introItems[this._currentStep].highlight[0],
                                end_str = this._introItems[this._currentStep].highlight[1],
                                start_node = null,
                                end_node = null,
                                start_a = 0,
                                end_a = 0;
                            $("[data-line--id]").each(function(){
                                let line_id = $(this).data('line--id'),
                                    match = line_id.match(/^line-(\d+)-(\d+)$/);
                                if(match) {
                                    let start = match[1],
                                        end = match[2];
                                    if(start <= start_str && end >= start_str) {
                                        start_node = $("text", this)[0].childNodes[0]
                                        start_a = start_str - start;
                                    }
                                    if(start <= end_str && end >= end_str) {
                                        end_node = $("text", this)[0].childNodes[0]
                                        end_a = end_str - start;
                                    }
                                    if(start_node || end_node) {
                                        $(this).addClass('intro-js-highlight');
                                    }
                                    if(end_node) {
                                        return false;
                                    }
                                }
                            });
                            if(start_node && end_node) {
                                this._introItems[this._currentStep].nodes = [start_node, end_node];
                                this._introItems[this._currentStep].highlight_context = [start_a, end_a];
                            }

                            $( ".intro-js-highlight" ).wrapAll( "<div id='document-highlight' />");
                            this._introItems[this._currentStep].element = $("#document-highlight")[0];
                            break;

                        case 'document-selecttag':
                            let tag_position = this._introItems[this._currentStep].tagPosition;
                            if(typeof tag_position === "undefined") {
                                tag_position = [0];
                            }
                            $(window).trigger('click');
                            $('#highlight-add-modal').removeClass('fade');
                            console.log(introjs_selection);
                            createHighlight(introjs_selection);

                            for(let i in tag_position) {
                                $("#highlight-add-form li[data-nodeid='" + tag_position[i] + "']").trigger('click');
                            }

                            $(window).unbind('click');
                            break;
                        case 'exploration-mode':
                            $("[data-nodeid='0']:not(.node-selected)").click();
                            // Reposition
                            setTimeout(function() {
                                window.scrollTo({
                                    top: 0,
                                    behavior: 'instant'
                                });
                                $('.introjs-tooltipReferenceLayer').css('height', $(targetElement).outerHeight())
                                $('.introjs-helperLayer').css('height', $(targetElement).outerHeight())
                                $('.introjs-disableInteraction').css('height', $(targetElement).outerHeight())
                            }, 500);
                            break;
                        case 'select-condition':
                            let i = this._introItems[this._currentStep].which;
                            if(isNaN(i)) {
                                i = 0;
                            }
                            window.scrollTo({
                                top: 0,
                                behavior: 'instant'
                            });
                            if(!$("[data-nodeid='2']").is(':visible')) {
                                $("[data-nodeid='1'] .expand-icon").trigger('click');
                            }
                            $("[data-nodeid='2']").trigger( "contextmenu" );
                            $(".context-menu-root li:nth(" + i + ")").addClass('context-menu-hover context-menu-visible');
                            $(".context-menu-root li:nth(" + i + ") > ul").css('left', $(".context-menu-root").width() + 'px');
                            $(".context-menu-root li:nth(" + i + ") > ul > li:first").addClass('context-menu-hover context-menu-visible');
                            this._introItems[this._currentStep].element = $(".context-menu-root")[0];
                            break;
                        case 'apply-condition':
                            $(".context-menu-root li.context-menu-visible > ul > li.context-menu-hover").trigger('mouseup');
                            break;
                        case 'select-badge':
                            this._introItems[this._currentStep].element = $('#document-contents .highlight-entry:first .badge')[0];
                            break;
                        case 'reposition-after-scroll':
                            setTimeout(function() {
                                //Force scroll to bottom of page
                                window.scrollTo({
                                    top: document.body.scrollHeight,
                                    behavior: 'instant'
                                });

                                let elems = ['.introjs-helperLayer', '.introjs-tooltipReferenceLayer', '.introjs-disableInteraction'],
                                    offset = $('#tag-selection-return').offset().top - $('.introjs-tooltipReferenceLayer').offset().top;

                                for (let i in elems) {
                                    $(elems[i]).css('top', (parseFloat($(elems[i]).css('top')) + offset) + 'px');
                                }
                            }, 500);
                            break;
                        case 'last':
                            $('#project-sidebar').css('width', 0);
                            break;
                    }
                }
                //Scroll to top if new document to prevent position problem with introjs
                if(targetElement.classList.contains('document-link')) {
                    window.scrollTo({
                        top: 0,
                        behavior: 'instant'
                    });
                }
            }
        }).
        onchange(function (targetElement) {
            current_step = this._currentStep;
        }).
        onafterchange(function(targetElement) {
            switch(targetElement.id) {
                case 'document-highlight':
                    $(".intro-js-highlight").unwrap().removeClass('intro-js-highlight');
                    let node_start = this._introItems[this._currentStep].nodes[0],
                        node_end = this._introItems[this._currentStep].nodes[1],
                        text_start = this._introItems[this._currentStep].highlight_context[0],
                        text_end = this._introItems[this._currentStep].highlight_context[1];
                    console.log([[node_start, node_end], [text_start, text_end]])
                    setTimeout(function(){
                        selectRange([node_start, node_end], [text_start, text_end]);
                        repositionIntroJS('top');
                    }, 500);
                    //Force reselection of text is unselected
                    $(window).bind('click', function(e) {
                        selectRange([node_start, node_end], [text_start, text_end]);
                    });
                    break;

                case 'document-dropdown-export':
                    setTimeout(function(){
                        $("#document-dropdown-export").click()
                        $('.introjs-helperLayer').css('width', $('#document-export-dropdown-menu').outerWidth() + 10)
                        $('.introjs-helperLayer').css('height', $('#document-export-dropdown-menu').outerHeight() + $('.introjs-helperLayer').outerHeight())
                        $('.introjs-disableInteraction').css('width', $('#document-export-dropdown-menu').outerWidth() + 10)
                        $('.introjs-disableInteraction').css('height', $('#document-export-dropdown-menu').outerHeight() + $('.introjs-helperLayer').outerHeight())
                    }, 500);
                    break;
            }
            if(targetElement.classList.contains('document-link')) {
                $('a.document-link-a', targetElement)[0].click();
            }
            if(this._introItems[this._currentStep].doAction) {
                switch(this._introItems[this._currentStep].doAction) {
                    case 'select-condition':
                        setTimeout(function(){
                            repositionIntroJS('right', 275);
                        }, 500);
                        break;
                    case 'select-badge':
                        setTimeout(function(){
                            repositionIntroJS('right', 15);
                        }, 500);
                        break;
                }
            }
        }).
        oncomplete(function (){
            $("#start-tutorial").remove();
        }).
        onexit(function () {
            is_demo = true;
            //Make sure everything is back as it was
            $( ".intro-js-tags-child" ).unwrap();
            $( ".intro-js-highlight" ).unwrap();
            $( ".document-highlight" ).unwrap();
            $(window).unbind('click');
        });

    function createDemoProject() {
        log('Create demo project');
        postJSON('/api/create_demo_project')
            .then(function (result) {
                if (result.html) {
                    $('#demo-project-container').prepend(result.html);
                    demoElement = $('#demo-project-container .project:first .project-card');
                    $('#demo-project-container .project.empty').remove();
                }
            })
    }

    let repositionIntroJS = (where='top', offset=0) => {
            //Remove position classes from tooltip
            let cls = $('.introjs-arrow').attr("class").split(/\s+/);
            for(let c in cls) {
                if(cls[c] !== 'introjs-arrow') {
                    $('.introjs-arrow').removeClass(cls[c]);
                }
            }
            cls = $('.introjs-tooltip').attr("class").split(/\s+/);
            for(let c in cls) {
                if(cls[c] !== 'introjs-tooltip') {
                    $('.introjs-tooltip').removeClass(cls[c]);
                }
            }

            //set new position
            switch(where) {
                case 'top':
                    let newtop = -$('.introjs-tooltip').outerHeight() + offset;
                    $('.introjs-tooltip')
                        .addClass('introjs-top-middle-aligned')
                        .css('top', newtop + 'px')
                        .css('margin-top', '-10px');
                    $('.introjs-arrow').css('display', 'inherit').addClass('bottom-middle');
                    break;
                case 'left':
                    $('.introjs-tooltip')
                        .addClass('introjs-left-middle-aligned')
                        .css('left', -$('.introjs-tooltip').outerWidth() + 'px')
                        .css('margin-right', -offset + 'px');
                    $('.introjs-arrow').css('display', 'inherit').addClass('right');
                    break;
                case 'right':
                    $('.introjs-tooltip')
                        .addClass('introjs-right-middle-aligned')
                        .css('left', $('.introjs-helperLayer').outerWidth() + 'px')
                        .css('margin-left', offset + 'px');
                    $('.introjs-arrow').css('display', 'inherit').addClass('left');
                    $('.introjs-disableInteraction').css('width', ($('.introjs-tooltip').offset().left - $('.introjs-disableInteraction').offset().left) + 'px');
                    break;
            }
        },
        showHomeIntro = () => {
            home_intro.start();
        },
        selectRange = (nodes, positions) => {
            let range=document.createRange(),
                selection = window.getSelection();
            range.setStart(nodes[0], positions[0]);
            range.setEnd(nodes[1], positions[1]);
            selection.removeAllRanges();
            selection.addRange(range);

            introjs_selection = describeSelection();
        },
        showProjectIntro = (step=1) => {
            project_intro.start();
            if(step && !isNaN(step) && step > 0) {
                log(`IntroJS : Go to step: ${step}`)
                project_intro.goToStepNumber(step);
            }
        }

    $("#a-start-demo").click(function(){
        showHomeIntro();
    });

    $("#start-tutorial").click(function(){
        showProjectIntro(current_step+1);
    });

    if($("#a-start-demo").length && is_demo) {
        // In index.html template
        showHomeIntro();
    } else if(is_demo) {
        // In project.html template
        showProjectIntro();
    }
});
