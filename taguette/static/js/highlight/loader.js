let highlightResizeObserver = null;

function loadDocumentHighlights(document_id, highlight_id, splitParagraphs, search_text) {
    if (document_id === null) {
        document_contents.style.direction = 'ltr';
        document_contents.innerHTML = '<p style="font-style: oblique; text-align: center;">' +
            gettext("Load a document on the left") + '</p>';
        toggleToolbarActions(false);
        return;
    }

    showSpinner();

    const info = getJSON(`/api/project/${project_id}/document/${document_id}`);
    const contents = getJSON(`/api/project/${project_id}/document/${document_id}/contents`);

    Promise.all([info, contents])
        .then(function(results) {
            const info = results[0];
            const contents = results[1];

            document_contents.innerHTML = '';
            highlights = {};

            if (highlightResizeObserver) {
                highlightResizeObserver.disconnect();
                highlightResizeObserver = null;
            }

            const mainContainer = document.createElement('div');
            mainContainer.style.position = 'relative';
            mainContainer.style.width = '100%';

            const contentDiv = document.createElement('div');
            contentDiv.id = 'highlight-content';
            contentDiv.style.userSelect = 'text';
            contentDiv.style.position = 'relative';
            contentDiv.style.direction = info.text_direction === 'RIGHT_TO_LEFT' ? 'rtl' : 'ltr';
            contentDiv.style.padding = '20px';
            contentDiv.style.lineHeight = '1.6';

            const allHTML = contents.contents.map((chunk, index) => {
                return `<div id="doc-offset-${chunk.offset}" class="document-chunk" data-chunk-index="${index}">${chunk.contents}</div>`;
            }).join('\n');

            contentDiv.innerHTML = allHTML;
            disableEditing(contentDiv);
            addDragFunctionality(contentDiv);
            mainContainer.appendChild(contentDiv);

            // SVG overlay drawn on top of text — pointer-events: none so it doesn't block selection
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.id = 'highlights-overlay';
            svg.style.position = 'absolute';
            svg.style.top = '0';
            svg.style.left = '0';
            svg.style.width = '100%';
            svg.style.height = '100%';
            svg.style.pointerEvents = 'none';
            svg.style.zIndex = '9';
            svg.style.overflow = 'visible';

            mainContainer.appendChild(svg);
            document_contents.appendChild(mainContainer);

            for (const element of info.highlights) {
                const id = '' + element.id;
                highlights[id] = element;
            }

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    try {
                        renderHighlights(Object.values(highlights));
                    } catch (error) {
                        log("Error rendering highlights", 'error', error);
                    }
                });
            });

            let _resizeTimeout = null;
            highlightResizeObserver = new ResizeObserver(() => {
                if (_renderingInProgress) return;
                if (_resizeTimeout) clearTimeout(_resizeTimeout);
                _resizeTimeout = setTimeout(() => {
                    try {
                        renderHighlights(Object.values(highlights));
                    } catch (error) {
                        log("Error re-rendering on resize", 'error', error);
                    }
                }, 300);
            });
            highlightResizeObserver.observe(contentDiv);

            current_document = document_id;
            toggleToolbarActions(true);
            updateDocumentLinkHighlight(current_document);
            updateDocumentExportButton(project_id, document_id);
            updateLinksTarget(document_contents);

            if (highlight_id) {
                setTimeout(() => scrollToHighlight(highlight_id, search_text), 200);
            }
        })
        .catch(function(error) {
            log("Failed to load document", 'error', error);
            showAlert(`${gettext("Error loading document!")} \n\n`, 'error');
        })
        .then(hideSpinner);
}
