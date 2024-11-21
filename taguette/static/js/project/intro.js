$(document).ready(function() {
    let demoElement = null,
        introjs_selection = null,
        current_step = 0,
        home_intro = introJs().setOptions({
            exitOnOverlayClick: true,
            exitOnEsc: true,
            steps: [
                {
                    title: gettext('Bienvenue sur LibreQDA, un logiciel d\'analyse qualitative développé en code source libre ouvert par la Plateforme en humanités numériques de l\'Université de Sherbrooke.'),
                    intro: gettext('<p>Visitez notre dépôt de code <a href="https://gitlab.com/bin-cirst/libreqda/libre-qda" target="_blank">Gitlab</a></p>'),
                },
                {
                    element: document.querySelector('#intro-documentation'),
                    intro: gettext('<p>Pour consulter la documentation.</p>'),
                    position: 'bottom'
                },
                {
                    element: $('#demo-project-container .col:first')[0],
                    intro: gettext('<p>Un projet tutoriel a été ajouté à votre espace personnel.</p>'),
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
                    title: gettext('Vos documents'),
                    intro: gettext('<p>Utilisez cet onglet pour charger des fichiers et naviguer entre eux</p>'),
                    position: 'right',
                },
                { // #1
                    element: document.querySelector("#left-panel"),
                    title: gettext('Arbre de codes'),
                    intro: gettext('<p>Cet onglet liste tous les codes que vous définissez. Ajoutez-en avec le bouton dédié à cet effet.</p><br><p>La fréquence totale d\'usage est indiquée dans la pastille de droite, et le nombre de documents dans celle de gauche.</p>'),
                    position: 'right'
                },
                { // #2
                    element: document.querySelector("#treeview-tags"),
                    title: gettext('Codes parents'),
                    intro: gettext('<p>Vous pouvez définir des codes qui sont appelés à en contenir d\'autres</p>'),
                    position: 'right'
                },
                { // #3
                    element: $("[data-nodeid='1']")[0],
                    title: gettext('Codes enfants'),
                    intro: gettext('<p>Ils peuvent être développés ou réduits.</p>'),
                    position: 'right',
                    doAction: 'expand-tag-childrens'
                },
                { // #4
                    element: $("#documents-list > li:first-child")[0],
                    title: gettext('Consulter les documents'),
                    intro: gettext('<p>Cliquez sur un document pour consulter son contenu. Utilisez l\'étoile pour enregistrer vos favoris.</p>'),
                    position: 'left',
                },
                { // #5
                    element: document.querySelector("#document-highlight"), // This element doesn't exist
                    title: gettext('Encoder'),
                    intro: gettext('<p>Sélectionnez un passage de texte avec votre curseur. Deux boutons apparaîtront pour y assigner un code.</p>'),
                    position: 'bottom',
                    highlight: [195, 403],
                    nodes: [null, null],
                    highlight_context: [0, 0],
                    doAction: 'document-highlight' // Action to create wrapper for introjs
                },
                { // #6
                    element: document.querySelector("#highlight-add-form"),
                    title: gettext("Sélectionner un code"),
                    intro: gettext('<p>Depuis le menu, sélectionnez des codes existants qui correspondent au contenu de la sélection et sauvegardez l\'opération. Ici, l\'extrait concerne le renforcement des relations sociales.</p>'),
                    position: 'left',
                    tagPosition: [3],
                    doAction: 'document-selecttag' // Action to create wrapper for introjs
                },
                { //#14
                    element: document.querySelector("#left-panel"),
                    title: gettext('Exploration des codes'),
                    intro: gettext('<p>Pendant ou après la phase d\'encodage, vous pouvez toujours explorer les passages de textes auxquels vous avez assigné des codes.</p><br><p> Affichez tous les extraits encodés avec un code de votre arbre en cliquant dessus.</p>'),
                    position: 'right',
                },
                { //#15
                    element: document.querySelector("#document-view"),
                    title: gettext('Préciser votre besoin d\'information'),
                    intro: gettext('<p>Si votre liste d\'extraits est longue, vous pouvez la raffiner avec une recherche avancée.</p>'),
                    position: 'left',
                    doAction: 'exploration-mode'
                },
                { //#16
                    element: document.querySelector(".context-menu-root"),
                    title: gettext('Sélection conditionnelle'),
                    intro: gettext('<p>D\'un clic droit, vous pouvez spécifier des conditions pour croiser des codes, en inclure plus ou en ignorer certains.</p>'),
                    position: 'left',
                    which: 2,
                    doAction: 'select-condition'
                },
                { //#17
                    element: document.querySelector("#document-view"),
                    title: gettext('Analyze'),
                    intro: gettext('<p>Les pastilles de la requête montrent que les extraits récupérés doivent nécessairement inclure les codes <i>barrieres</i> et <i>developpment_competences</i>.</p>'),
                    position: 'left',
                    doAction: 'apply-condition'
                },
                { //#18
                    element: $('#document-contents .highlight-entry:first .badge')[0],
                    title: gettext('Naviguer vers le document'),
                    intro: gettext('<p>En cliquant sur le nom du document, vous pouvez retourner au contexte.</p>'),
                    position: 'top',
                    doAction: 'select-badge'
                },
                { //#19
                    element: document.querySelector('#tag-selection-return'),
                    title: gettext('Retourner aux extraits'),
                    intro: gettext('<p>Après avoir consulté le contexte, vous pouvez retourner `a la liste d\'extraits précédement récupérés à l\'aide d\'une recherche avancée.</p>'),
                    position: 'right',
                    doAction: 'reposition-after-scroll'
                },
                { //#20
                    element: document.querySelector('#document-dropdown-export'),
                    title: gettext('Export'),
                    intro: gettext('<p>Au besoin, téléchargez cette liste d\'extraits sur votre ordinateur.</p>'),
                    position: 'left',
                },
                { //#22
                    title: gettext('À vous d\'encoder!'),
                    intro: gettext('<p>Utilisez LibreQDA comme vous le souhaitez avec l\'assurance que vos donnée seront sauvegardée sur votre espace personnel. Pour vous familiariser d\'avantage avec les fonctionnalités, poursuivez l\'encodage et l\'exploration des fichiers d\'entretiens fictives concernant les jeux de sociétés.</p>'),
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
