function showTagUnderlineTooltip(event, tagId, color) {
    let tooltip = document.getElementById('tag-underline-tooltip');

    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'tag-underline-tooltip';
        document.body.appendChild(tooltip);

        Object.assign(tooltip.style, {
            position: 'fixed',
            padding: '10px',
            background: '#fff',
            border: '2px solid #333',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            fontSize: '13px',
            pointerEvents: 'none',
            zIndex: '10000',
            maxWidth: '300px',
            wordWrap: 'break-word',
            overflowWrap: 'break-word',
        });
    }

    const tag = findTag(tagId);
    if (!tag) return;

    tooltip.innerHTML = `
        <div style="display: flex; gap: 4px; flex-wrap: wrap; max-width: 280px;">
            <div style="
                display: inline-block;
                padding: 4px 8px;
                border-radius: 3px;
                background-color: ${color};
                color: white;
                font-size: 11px;
                max-width: 100%;
                word-wrap: break-word;
                overflow-wrap: break-word;
            ">
                ${tag.path}
            </div>
        </div>
    `;

    tooltip.style.display = 'block';
    tooltip.style.left = (event.clientX + 10) + 'px';
    tooltip.style.top = (event.clientY + 10) + 'px';
}

function hideTagUnderlineTooltip() {
    const tooltip = document.getElementById('tag-underline-tooltip');
    if (tooltip) tooltip.style.display = 'none';
}

/**
 * Apply colored SVG underlines to a content div based on tag_ranges.
 * Uses Range.getClientRects() to get pixel positions, then draws SVG lines.
 */
function applyTagUnderlines(contentDiv, tagRanges, principalTagId) {
    if (!tagRanges || tagRanges.length === 0) return;

    // Make contentDiv a positioning context for the SVG overlay
    contentDiv.style.position = 'relative';

    const textNodes = collectTextNodes(contentDiv);
    const fullText = textNodes.map(n => n.nodeValue).join('');
    if (fullText.length === 0) return;

    // Build char index -> { node, offsetInNode } mapping
    const charMap = [];
    for (const textNode of textNodes) {
        const nodeText = textNode.nodeValue;
        for (let j = 0; j < nodeText.length; j++) {
            charMap.push({ node: textNode, offset: j });
        }
    }

    // Convert UTF-8 byte offsets to char indices
    const ranges = tagRanges.map(tr => ({
        tag_id: tr.tag_id,
        color: tr.color,
        startChar: getCharIndexFromUTF8Index(fullText, tr.start),
        endChar: getCharIndexFromUTF8Index(fullText, tr.end),
    }));

    // Sort by start, then larger ranges first
    ranges.sort((a, b) => a.startChar - b.startChar || (b.endChar - b.startChar) - (a.endChar - a.startChar));

    // Assign lanes for overlapping ranges
    const laneEnds = [];
    const rangeLanes = ranges.map(range => {
        for (let lane = 0; lane < laneEnds.length; lane++) {
            if (laneEnds[lane] <= range.startChar) {
                laneEnds[lane] = range.endChar;
                return lane;
            }
        }
        laneEnds.push(range.endChar);
        return laneEnds.length - 1;
    });

    const totalLanes = laneEnds.length;
    const LINE_HEIGHT = 3;
    const LINE_GAP = 2;
    const BASE_OFFSET = 2;
    const extraSpace = BASE_OFFSET + totalLanes * (LINE_HEIGHT + LINE_GAP);

    // Add bottom padding so SVG lines don't overlap the badges
    contentDiv.style.paddingBottom = extraSpace + 'px';

    // Increase line-height to make room for stacked underlines between text lines
    if (totalLanes > 0) {
        contentDiv.style.lineHeight = (1.6 + totalLanes * 0.3) + 'em';
    }

    // Create SVG overlay
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('tag-underline-svg');
    svg.style.position = 'absolute';
    svg.style.left = '0';
    svg.style.top = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.overflow = 'visible';

    const containerRect = contentDiv.getBoundingClientRect();

    for (let ri = 0; ri < ranges.length; ri++) {
        const range = ranges[ri];
        const lane = rangeLanes[ri];
        if (range.startChar >= range.endChar || range.startChar >= charMap.length) continue;

        const effectiveEnd = Math.min(range.endChar, charMap.length);

        // Create a DOM Range to get bounding rects
        const domRange = document.createRange();
        const startEntry = charMap[range.startChar];
        const endEntry = charMap[effectiveEnd - 1];
        domRange.setStart(startEntry.node, startEntry.offset);
        domRange.setEnd(endEntry.node, endEntry.offset + 1);

        const rects = domRange.getClientRects();

        for (const rect of rects) {
            const x = rect.left - containerRect.left;
            const y = rect.bottom - containerRect.top + BASE_OFFSET + lane * (LINE_HEIGHT + LINE_GAP);

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', x);
            line.setAttribute('y1', y + LINE_HEIGHT / 2);
            line.setAttribute('x2', x + rect.width);
            line.setAttribute('y2', y + LINE_HEIGHT / 2);
            line.setAttribute('stroke', range.color);
            line.setAttribute('stroke-width', LINE_HEIGHT);
            line.setAttribute('stroke-linecap', 'round');
            if (range.tag_id !== principalTagId) {
                line.setAttribute('stroke-dasharray', '8 6');
                line.setAttribute('stroke-linecap', 'butt');
                line.setAttribute('data-overlay-tag-id', range.tag_id);
                line.style.display = 'none';
            }
            line.classList.add('smooth-stroke');
            line.style.pointerEvents = 'all';
            line.style.cursor = 'pointer';
            line.style.transition = 'stroke-width 0.2s';

            line.addEventListener('mouseenter', function (e) {
                line.setAttribute('stroke-width', LINE_HEIGHT + 2);
                showTagUnderlineTooltip(e, range.tag_id, range.color);
            });
            line.addEventListener('mouseleave', function () {
                line.setAttribute('stroke-width', LINE_HEIGHT);
                hideTagUnderlineTooltip();
            });

            svg.appendChild(line);
        }
    }

    contentDiv.appendChild(svg);
}

function loadTag(tag_path, page) {
    if (page === undefined) {
        page = 1;
    }
    if(tag_path !== undefined) {
        showSpinner();
    }
    getJSON(
        `/api/project/${project_id}/highlights/${encodeURIComponent(tag_path)}?page=${page}`
    )
        .then(function (result) {
            log(`Loaded highlights for tag ${tag_path}`);
            document_contents.style.direction = 'ltr';
            current_tag = tag_path;
            // current_document = null;
            let document_links = document.getElementsByClassName('document-link-current');
            for (let i = document_links.length - 1; i >= 0; --i) {
                document_links[i].classList.remove('document-link-current');
            }
            // No need to clear the 'tag-current', we are calling updateTagsList() below
            document_contents.innerHTML = '';
            highlights = {};
            for (const hl of result.highlights) {
                let content = document.createElement('div');
                if (hl.text_direction === 'RIGHT_TO_LEFT') {
                    content.style.direction = 'rtl';
                } else {
                    content.style.direction = 'ltr';
                }
                content.innerHTML = hl.content;
                let elem = document.createElement('div');
                elem.className = 'highlight-entry';
                elem.setAttribute('id', 'highlight-entry-' + hl.id);
                elem.appendChild(content);
                elem.appendChild(document.createTextNode(' '));

                // Separate principal tags (selected in treeview) from associated tags
                const selectedTagIds = new Set(selectedTags.map(t => t.id));

                let principalTags = [];
                let associatedTags = [];
                hl.tags.forEach(function (tagId) {
                    const tag = findTag(tagId);
                    if (tag) {
                        if (selectedTagIds.has(tag.id)) {
                            principalTags.push(tag);
                        } else {
                            associatedTags.push(tag);
                        }
                    }
                });

                // Row 1: doclink + principal tag badges
                let badgeRow = document.createElement('div');
                badgeRow.className = 'd-flex flex-wrap gap-1 align-items-center';

                let doclink = document.createElement('a');
                doclink.className = 'badge badge-primary';
                const documentPath = buildDocumentPath(hl.document_id);
                doclink.textContent = documentPath;
                linkDocument(doclink, hl.document_id, hl.id);
                badgeRow.appendChild(doclink);

                for (let j = 0; j < principalTags.length; j++) {
                    let taglink = document.createElement('a');
                    taglink.className = 'badge';
                    taglink.setAttribute('style', `background-color: ${principalTags[j].color}; color: white; font-weight: bold;`);
                    taglink.textContent = principalTags[j].path;
                    badgeRow.appendChild(taglink);
                }

                elem.appendChild(badgeRow);

                // Row 2: "Associated tags:" label + associated tag badges (only if any)
                if (associatedTags.length > 0) {
                    let assocRow = document.createElement('div');
                    assocRow.className = 'd-flex flex-wrap gap-2 align-items-center mt-2';

                    let label = document.createElement('small');
                    label.textContent = gettext('Overlapping:');
                    label.style.color = '#6c757d';
                    assocRow.appendChild(label);

                    associatedTags.sort((a, b) => a.path.localeCompare(b.path));
                    for (let j = 0; j < associatedTags.length; j++) {
                        let taglink = document.createElement('a');
                        taglink.className = 'badge badge-outline-tag';
                        taglink.setAttribute('style',
                            `border: 2px dashed ${associatedTags[j].color}; color: ${associatedTags[j].color}; background: transparent; font-weight: bold; cursor: pointer;`
                        );
                        taglink.textContent = associatedTags[j].path;
                        taglink.setAttribute('data-overlay-tag-id', associatedTags[j].id);
                        taglink.addEventListener('mouseenter', function () {
                            const tagId = parseInt(this.getAttribute('data-overlay-tag-id'));
                            content.querySelectorAll('line[data-overlay-tag-id="' + tagId + '"]').forEach(function (l) {
                                l.style.display = '';
                            });
                        });
                        taglink.addEventListener('mouseleave', function () {
                            const tagId = parseInt(this.getAttribute('data-overlay-tag-id'));
                            content.querySelectorAll('line[data-overlay-tag-id="' + tagId + '"]').forEach(function (l) {
                                l.style.display = 'none';
                            });
                        });
                        assocRow.appendChild(taglink);
                    }

                    elem.appendChild(assocRow);
                }

                document_contents.appendChild(elem);

                // Apply SVG underlines after element is in the DOM (needed for getBoundingClientRect)
                if (hl.tag_ranges && hl.tag_ranges.length > 0) {
                    const principalTag = findTag(tag_path);
                    const principalTagId = principalTag ? principalTag.id : null;
                    applyTagUnderlines(content, hl.tag_ranges, principalTagId);
                }
            }
            if (result.highlights.length === 0) {
                document_contents.innerHTML = '<p style="font-style: oblique; text-align: center;">' + gettext("No highlights with this tag yet.") + '</p>';
            }

            // Pagination controls
            function makePageLink(page_nb, label, current, enabled) {
                let item;
                if (current) {
                    item = document.createElement('li');
                    item.className = 'page-item active';
                    item.innerHTML = '<span class="page-link">' + label + '<span class="sr-only">(current)</span></span>';
                } else if (!enabled) {
                    item = document.createElement('li');
                    item.className = 'page-item disabled';
                    item.innerHTML = '<span class="page-link">' + label + '</span>';
                } else {
                    item = document.createElement('li');
                    item.className = 'page-item';
                    let link = document.createElement('a');
                    link.className = 'page-link';
                    link.setAttribute('href', '#');
                    link.innerText = label;
                    link.addEventListener('click', function (e) {
                        e.preventDefault();
                        loadTag(tag_path, page_nb);
                    });
                    item.appendChild(link);
                }
                return item;
            }

            if (result.pages > 1 || page !== 1) {
                if (result.pages === undefined && page !== 1) {
                    result.pages = 1;
                }
                let pagination = document.createElement('nav');
                pagination.setAttribute('aria-label', "Page navigation");
                let pagination_ul = document.createElement('ul');
                pagination_ul.className = 'pagination justify-content-center';
                const min_page = Math.max(2, page - 2);
                const max_page = Math.min(result.pages - 1, page + 2);

                // Previous button
                pagination_ul.appendChild(makePageLink(page - 1, "Previous", false, page > 1));
                // Page 1
                pagination_ul.appendChild(makePageLink(1, 1, 1 === page, 1 !== page));
                // "..." between 1 and other pages, if appropriate
                if (min_page > 2) {
                    pagination_ul.appendChild(makePageLink(page, "...", false, false));
                }
                // Other pages
                for (let i = min_page; i <= max_page; ++i) {
                    pagination_ul.appendChild(makePageLink(i, i, i === page, i !== page));
                }
                // "..." between other pages and last page, if appropriate
                if (max_page < result.pages - 1) {
                    pagination_ul.appendChild(makePageLink(page, "...", false, false));
                }
                // Last page
                pagination_ul.appendChild(makePageLink(result.pages, result.pages, result.pages === page, result.pages !== page));
                // Next button
                pagination_ul.appendChild(makePageLink(page + 1, "Next", false, page < result.pages));

                pagination.appendChild(pagination_ul);
                document_contents.appendChild(pagination);
            }

            // Update export button
            const items = document.querySelectorAll('#document-export-dropdown-menu a');
            for (const item of items) {
                const ext = item.dataset.extension;
                if (item.dataset.highlights === 'false') {
                    item.style.display = 'none';
                } else {
                    item.setAttribute('href', base_path + '/project/' + project_id + '/export/highlights/' + encodeURIComponent(tag_path) + '.' + ext);
                    item.style.display = '';
                }
            }

            toggleToolbarActions(true)

            // Scroll up
            window.setTimeout(function () {
                window.scrollTo(0, 0);
            }, 0);
        })
        .catch(function (error) {
            log("Failed to load tag highlights", 'error', {error});
            showAlert(`${gettext("Error loading tag highlights!")} \n \n`, 'error', {error})
        })
        .then(function (result) {
            hideSpinner();
        });
}
