$(document).ready(function() {
    let demoElement = null;

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

    let showIntro = () => {
        introJs().setOption("dontShowAgain", true).setOptions({
            showProgress: true,
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
    }

    $("#a-start-demo").click(function(){
        showIntro();
    });
});