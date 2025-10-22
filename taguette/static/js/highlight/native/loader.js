// Native document loader - HTML preserved + SVG overlay

function ntv_loadDocument(document_id, highlight_id = null, splitParagraphs = true, search_text = null) {
    if (document_id === null) {
        document_contents.style.direction = 'ltr';
        document_contents.innerHTML = '<p style="font-style: oblique; text-align: center;">' + 
            gettext("Load a document on the left") + '</p>';
        return;
    }
    
    showSpinner();
    
    const info = getJSON(`/api/project/${project_id}/document/${document_id}`);
    const contents = getJSON(`/api/project/${project_id}/document/${document_id}/contents`);
    
    Promise.all([info, contents])
        .then(function (results) {
            const info = results[0];
            const contents = results[1];
            
            document_contents.innerHTML = '';
            ntv_highlights = {};
            
            const mainContainer = document.createElement('div');
            mainContainer.style.position = 'relative';
            mainContainer.style.width = '100%';
            
            const contentDiv = document.createElement('div');
            contentDiv.id = 'ntv-document-content';
            contentDiv.style.userSelect = 'text';
            contentDiv.style.position = 'relative';
            contentDiv.style.direction = info.text_direction === 'RIGHT_TO_LEFT' ? 'rtl' : 'ltr';
            contentDiv.style.padding = '20px';
            contentDiv.style.lineHeight = '1.6';
            
            const allHTML = contents.contents.map((chunk, index) => {
                return `<div id="ntv-chunk-${chunk.offset}" class="ntv-document-chunk" data-chunk-index="${index}">${chunk.contents}</div>`;
            }).join('\n');
            
            contentDiv.innerHTML = allHTML;
            
            disableEditing(contentDiv);
            addDragFunctionality(contentDiv);
            
            mainContainer.appendChild(contentDiv);
            
            // SVG overlay: absolute positioning allows drawing over preserved HTML
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.id = 'ntv-highlights-overlay';
            svg.style.position = 'absolute';
            svg.style.top = '0';
            svg.style.left = '0';
            svg.style.width = '100%';
            svg.style.height = '100%';
            svg.style.pointerEvents = 'none';
            svg.style.zIndex = '10';
            svg.style.overflow = 'visible';
            
            mainContainer.appendChild(svg);
            document_contents.appendChild(mainContainer);
            
            for (let i = 0; i < info.highlights.length; ++i) {
                const id = '' + info.highlights[i].id;
                ntv_highlights[id] = info.highlights[i];
            }
            
            // Double RAF: ensures DOM layout is complete before measuring rects
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    ntv_renderAllHighlights(Object.values(ntv_highlights));
                });
            });
            
            ntv_current_document = document_id;
            current_document = document_id;
            toggleToolbarActions(true);
            updateDocumentLinkHighlight(current_document);
            updateDocumentExportButton(project_id, document_id);
            
            if (highlight_id) {
                setTimeout(() => scrollToHighlight(highlight_id, search_text), 200);
            }
        })
        .catch(function (error) {
            log("[ntv] Failed to load document", 'error', error);
            showAlert(`${gettext("Error loading document!")} \n\n`, 'error');
        })
        .then(hideSpinner);
}
