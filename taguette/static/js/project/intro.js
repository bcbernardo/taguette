$(document).ready(function() {
    let demoElement = null,
        introjs_selection = null;

    function createDemoProject() {
        log('Create demo project');
        postJSON('/api/create_demo_project')
            .then(function (result) {
                if (result.html) {
                    $('#demo-project-container').prepend(result.html);
                    demoElement = $('#demo-project-container .project:first .project-card');
                }
            })
    }

    let showHomeIntro = () => {
            introJs().setOptions({
                exitOnOverlayClick: true,
                exitOnEsc: true,
                steps: [
                    {
                        title: gettext('Welcome to LibreQDA, an open source qualitative analysis application.'),
                        intro: gettext('<p>To get the source code: <a href="https://gitlab.com/bin-cirst/libreqda/libre-qda" target="_blank">Gitlab</a></p>'),
                    },
                    {
                        element: document.querySelector('#intro-documentation'),
                        intro: gettext('<p>To consult documentation</p>'),
                        position: 'bottom'
                    },
                    {
                        element: document.querySelectorAll("a.project")[0],
                        intro: gettext('<p>A mini project has been added to your home screen to simulate an analysis approach.</p>'),
                        position: 'top'
                    },
                ]
            }).
            setOption('disableInteraction', true).
            setOption("nextLabel", gettext('Next')).
            setOption("prevLabel", gettext('Back')).
            setOption("doneLabel", gettext('Continue')).
            onchange(function (targetElement) {
                if(targetElement.classList.contains('project') &&
                    demoElement === null) {
                    createDemoProject();
                }
            }).oncomplete(function () {
                if(demoElement !== null) {
                    demoElement.trigger('click');
                }
            }).start();
        },
        selectRange = (nodes, positions) => {
            let range=document.createRange();
            range.setStart(nodes[0], positions[0]);
            range.setEnd(nodes[1], positions[1]);
            window.getSelection().addRange(range);

            introjs_selection = describeSelection();
        },
        repositionIntroJS = (where='top') => {
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
                    let newtop = -$('.introjs-tooltip').outerHeight();
                    $('.introjs-tooltip')
                        .addClass('introjs-top-middle-aligned')
                        .css('top', newtop + 'px')
                        .css('margin-top', '-10px');
                    $('.introjs-arrow').css('display', 'inherit').addClass('bottom-middle');
                case 'left':
                    let newleft = -$('.introjs-tooltip').outerWidth();
                    $('.introjs-tooltip')
                        .addClass('introjs-top-middle-aligned')
                        .css('margin-left', newleft + 'px');
                    $('.introjs-arrow').css('display', 'inherit').addClass('bottom-middle');
            }
        },
        showProjectIntro = () => {
            introJs().setOptions({
                showProgress: true,
                exitOnOverlayClick: true,
                exitOnEsc: true,
                steps: [
                    {
                        element: document.querySelector("#right-panel"),
                        title: gettext('Documents'),
                        intro: gettext('<p>To manipulate documents.</p>'),
                        position: 'right',
                    },
                    {
                        element: document.querySelector("#left-panel"),
                        title: gettext('Code tree'),
                        intro: gettext('<p>The list of all tags in your projects. You can add codes by clicking on the "Create a code button"</p>'),
                        position: 'right'
                    },
                    {
                        element: document.querySelector("#treeview-tags"),
                        title: gettext('Parents codes'),
                        intro: gettext('<p>Here are all the parents codes.</p>'),
                        position: 'right'
                    },
                    {
                        element: $("[data-nodeid='1']")[0],
                        title: gettext('Children codes'),
                        intro: gettext('<p>If you click on a parent code you can seel all childrens.</p>'),
                        position: 'right',
                    },
                    {
                        element: $("#documents-list > li:first-child")[0],
                        title: gettext('Load a document'),
                        intro: gettext('<p>To load a document you can click on it in the right panel.</p>'),
                        position: 'left',
                    },
                    {
                        element: document.querySelector("#document-highlight"), // This element doesn't exist
                        title: gettext('Highlight excerpt'),
                        intro: gettext('<p>You can highlight a text excerpt and assign a code by clicking `New highlight`.</p>'),
                        position: 'bottom',
                        highlight: [195, 403],
                        nodes: [null, null],
                        highlight_context: [0, 0],
                        doAction: 'document-highlight' // Action to create wrapper for introjs
                    },
                    {
                        element: document.querySelector("#highlight-add-form"),
                        title: gettext("Let's assign a code"),
                        intro: gettext('<p>Add the code `renforcement_relations` by clicking the corresponding code and save.</p>'),
                        position: 'left',
                        tagPosition: [3],
                        doAction: 'document-selecttag' // Action to create wrapper for introjs
                    },
                    {
                        element: document.querySelector("#document-highlight"), // This element doesn't exist
                        title: gettext('Highlight another excerpt'),
                        intro: gettext("<p>Let's select another text excerpt and assign another code.</p>"),
                        position: 'bottom',
                        highlight: [2161, 2461],
                        nodes: [null, null],
                        highlight_context: [0, 0],
                        doAction: 'document-highlight' // Action to create wrapper for introjs
                    },
                    {
                        element: document.querySelector("#highlight-add-form"),
                        title: gettext("Let's assign anoher code"),
                        intro: gettext('<p>Add the code `developpement_competences` by clicking the corresponding code and save.</p>'),
                        position: 'left',
                        tagPosition: [2],
                        doAction: 'document-selecttag' // Action to create wrapper for introjs
                    },
                    {
                        element: document.querySelector("#document-highlight"), // This element doesn't exist
                        title: gettext('Highlight a third one'),
                        intro: gettext("<p>Let's select a third excerpt and assign another code.</p>"),
                        position: 'bottom',
                        highlight: [2850, 3255],
                        nodes: [null, null],
                        highlight_context: [0, 0],
                        doAction: 'document-highlight' // Action to create wrapper for introjs
                    },
                    {
                        element: document.querySelector("#highlight-add-form"),
                        title: gettext("Let's assign a code"),
                        intro: gettext('<p>Add the code `barrieres` by clicking the corresponding code and save.</p>'),
                        position: 'left',
                        tagPosition: [0],
                        doAction: 'document-selecttag' // Action to create wrapper for introjs
                    },
                    {
                        element: $("#documents-list > li:nth(1)")[0],
                        title: gettext('Load another document'),
                        intro: gettext('<p>2024-05-23_entrevue_Marc_ingenieur.txt.</p>'),
                        position: 'left',
                    },
                    //#9.1
                    {
                        element: document.querySelector("#document-highlight"), // This element doesn't exist
                        title: gettext('Highlight text'),
                        intro: gettext("<p>Let's select a excerpt and assign a code.</p>"),
                        position: 'bottom',
                        highlight: [494, 806],
                        nodes: [null, null],
                        highlight_context: [0, 0],
                        doAction: 'document-highlight' // Action to create wrapper for introjs
                    },
                    {
                        element: document.querySelector("#highlight-add-form"),
                        title: gettext("Let's assign a code"),
                        intro: gettext('<p>Add the code `barrieres` by clicking the corresponding code and save.</p>'),
                        position: 'left',
                        tagPosition: [0],
                        doAction: 'document-selecttag' // Action to create wrapper for introjs
                    },
                    //#9.2
                    {
                        element: document.querySelector("#document-highlight"), // This element doesn't exist
                        title: gettext('Highlight text'),
                        intro: gettext("<p>Let's select a excerpt and assign a code.</p>"),
                        position: 'bottom',
                        highlight: [2182, 2400],
                        nodes: [null, null],
                        highlight_context: [0, 0],
                        doAction: 'document-highlight' // Action to create wrapper for introjs
                    },
                    {
                        element: document.querySelector("#highlight-add-form"),
                        title: gettext("Let's assign a code"),
                        intro: gettext('<p>Add the code `renforcement_relations` by clicking the corresponding code and save.</p>'),
                        position: 'left',
                        tagPosition: [3],
                        doAction: 'document-selecttag' // Action to create wrapper for introjs
                    },
                    //#10
                    {
                        element: document.querySelector("#document-highlight"), // This element doesn't exist
                        title: gettext('Highlight text'),
                        intro: gettext("<p>Add more than 1 code to an excerpt.</p>"),
                        position: 'bottom',
                        highlight: [2182, 2733],
                        nodes: [null, null],
                        highlight_context: [0, 0],
                        doAction: 'document-highlight' // Action to create wrapper for introjs
                    },
                    {
                        element: document.querySelector("#highlight-add-form"),
                        title: gettext("Let's assign 3 codes"),
                        intro: gettext('<p>Select `renforcement_relations`, `developpement_competences`, `barrieres` by clicking corresponding codes and save.</p>'),
                        position: 'left',
                        tagPosition: [0, 2, 3],
                        doAction: 'document-selecttag' // Action to create wrapper for introjs
                    },
                    //#11
                    {
                        element: $("#documents-list > li:nth(2)")[0],
                        title: gettext('Take a look to a last document'),
                        intro: gettext('<p>2024-05-26_entrevue_Nadia_enseignante.txt.</p>'),
                        position: 'left',
                    },
                    //#11.1
                    {
                        element: document.querySelector("#document-highlight"), // This element doesn't exist
                        title: gettext('Highlight text'),
                        intro: gettext("<p>Highlight text and add code.</p>"),
                        position: 'bottom',
                        highlight: [255, 574],
                        nodes: [null, null],
                        highlight_context: [0, 0],
                        doAction: 'document-highlight' // Action to create wrapper for introjs
                    },
                    {
                        element: document.querySelector("#highlight-add-form"),
                        title: gettext("Let's assign a codes"),
                        intro: gettext('<p>Select `developpement_competences` and save.</p>'),
                        position: 'left',
                        tagPosition: [2],
                        doAction: 'document-selecttag' // Action to create wrapper for introjs
                    },
                    //#11.2
                    {
                        element: document.querySelector("#document-highlight"), // This element doesn't exist
                        title: gettext('Highlight text'),
                        intro: gettext("<p>Highlight text and add code.</p>"),
                        position: 'bottom',
                        highlight: [1794, 2421],
                        nodes: [null, null],
                        highlight_context: [0, 0],
                        doAction: 'document-highlight' // Action to create wrapper for introjs
                    },
                    {
                        element: document.querySelector("#highlight-add-form"),
                        title: gettext("Let's assign a codes"),
                        intro: gettext('<p>Select `developpement_competences` and save.</p>'),
                        position: 'left',
                        tagPosition: [0, 2, 3],
                        doAction: 'document-selecttag' // Action to create wrapper for introjs
                    },
                    {
                        element: document.querySelector("#create-tag-link"),
                        title: gettext("Create codes"),
                        intro: gettext('<p>As you read on, you\'ll have to create codes, which you can do in several ways.</p>'),
                        position: 'right',
                    },
                    {
                        element: document.querySelector("#tag-add-form"),
                        title: gettext("Let's create a code"),
                        intro: gettext('<p>Create the code `games` and assign a color.</p>'),
                        position: 'left',
                        doAction: 'open-tag-add-form' // Action to create wrapper for introjs
                    },
                    {
                        element: document.querySelector("#treeview-tags"),
                        title: gettext('Analyze'),
                        intro: gettext('<p>After encoding several passages, you can analyze them. Let\'s click on games</p>'),
                        position: 'right',
                        doAction: 'create-highlights'
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
                    if($("#highlight-add-form").is(':visible')) {
                        $("#highlight-add-form").submit();
                        introjs_selection = null;
                    }
                    switch(targetElement.id) {
                        case '1':
                            $("#1 .expand-icon").trigger('click');
                            for(let i=1; i<=3; i++) {
                                $("[data-nodeid='" + i + "']").addClass('intro-js-tags-child')
                            }
                            $( ".intro-js-tags-child" ).wrapAll( "<div id='intro-js-wrapped' />");
                            // Fix duplicate elements
                            $("#intro-js-wrapped > li:lt(3)").each(function(){
                                $(this).remove();
                            });
                            // Force refresh dynamic element
                            this._introItems[this._currentStep].element = $("#intro-js-wrapped")[0];
                            break;

                        default:
                            if(this._introItems[this._currentStep].doAction) {
                                switch(this._introItems[this._currentStep].doAction) {
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
                                                if(start_node) {
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
                                        createHighlight(introjs_selection);

                                        for(let i in tag_position) {
                                            $("#highlight-add-form li[data-nodeid='" + tag_position[i] + "']").trigger('click');
                                        }

                                        $(window).unbind('click');
                                        break;
                                    case 'open-tag-add-form':
                                        $('#tag-add-modal').removeClass('fade');
                                        createTag();
                                        $("#tag-add-path").val(gettext('games'));
                                        $('#tag-add-color').val("#9141ac");
                                        break;
                                    case 'create-highlights':
                                        let highlights = [[ 732, 764 ], [ 924, 933 ], [ 1210, 1218 ]];

                                        for(let i in highlights) {
                                            createHighlight(highlights[i]);
                                            $("#highlight-add-form li[data-nodeid='5']").trigger('click');
                                            $("#highlight-add-form").submit();
                                        }
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
                }
            }).
            onchange(function (targetElement) {
            }).
            onafterchange(function(targetElement) {
                switch(targetElement.id) {
                    case 'document-highlight':
                        $( ".intro-js-highlight" ).unwrap();
                        $( ".intro-js-highlight" ).removeClass('intro-js-highlight');
                        let node_start = this._introItems[this._currentStep].nodes[0],
                            node_end = this._introItems[this._currentStep].nodes[1],
                            text_start = this._introItems[this._currentStep].highlight_context[0],
                            text_end = this._introItems[this._currentStep].highlight_context[1];
                        setTimeout(function(){
                            selectRange([node_start, node_end], [text_start, text_end]);
                            repositionIntroJS('top');
                        }, 500);
                        //Force reselection of text is unselected
                        $(window).bind('click', function(e) {
                            selectRange([node_start, node_end], [text_start, text_end]);
                        });
                        break;
                    default:
                        if(targetElement.classList.contains('document-link')) {
                            $('a.document-link-a', targetElement)[0].click();
                        }
                }
            }).
            oncomplete(function () {
                //Make sure everything is back as it was
                $( ".intro-js-tags-child" ).unwrap();
                $( ".intro-js-highlight" ).unwrap();
                // $( ".document-highlight" ).unwrap();
                $(window).unbind('click');
            }).start();
        }

    $("#a-start-demo").click(function(){
        showHomeIntro();
    });

    // In project.html template
    if(is_demo) {
        showProjectIntro();
    }
});