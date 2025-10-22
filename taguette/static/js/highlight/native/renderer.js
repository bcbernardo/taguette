// V2 Highlight System - HTML preserved with SVG overlay

let ntv_highlights = {};
let ntv_current_document = null;
function ntv_lengthUTF8(char) {
    const code = char.charCodeAt(0);
    if (code <= 0x7F) return 1;
    if (code <= 0x7FF) return 2;
    if (code >= 0xD800 && code <= 0xDFFF) return 4;
    return 3;
}

function ntv_lengthUTF8String(str) {
    let len = 0;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code <= 0x7F) {
            len += 1;
        } else if (code <= 0x7FF) {
            len += 2;
        } else if (code >= 0xD800 && code <= 0xDBFF) {
            len += 4;
            i++;
        } else {
            len += 3;
        }
    }
    return len;
}

// Hybrid search: snippet-based (primary) with UTF-8 offset fallback for legacy highlights
function ntv_findHighlightInDOM(container, highlight) {
    let range = ntv_findBySnippet(
        container, 
        highlight.snippet, 
        highlight.context_before, 
        highlight.context_after
    );
    
    if (range) return range;
    
    // Fallback: use UTF-8 offsets for old highlights without snippets
    if (highlight.start_offset !== undefined && highlight.end_offset !== undefined) {
        log(`[ntv] Snippet not found for highlight ${highlight.id}, using UTF-8 offsets`, 'error');
        range = ntv_findByUTF8Offsets(container, highlight.start_offset, highlight.end_offset);
        if (range) return range;
    }
    
    log(`[ntv] Highlight ${highlight.id} not found in DOM`, 'error');
    return null;
}

function ntv_findBySnippet(container, snippet, contextBefore, contextAfter) {
    if (!snippet || !container) return null;
    
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = snippet;
    const cleanSnippet = tempDiv.textContent || tempDiv.innerText || '';

    if (!cleanSnippet.trim()) return null;
    
    // TreeWalker: traverse all text nodes while preserving HTML structure
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    
    let fullText = '';
    let textNodes = [];
    let node;
    
    while (node = walker.nextNode()) {
        textNodes.push({
            node: node,
            startIndex: fullText.length,
            endIndex: fullText.length + node.textContent.length
        });
        fullText += node.textContent;
    }

    const normalizedText = fullText.toLowerCase();
    const normalizedSnippet = cleanSnippet.toLowerCase();
    
    const occurrences = [];
    let searchIndex = 0;
    
    while ((searchIndex = normalizedText.indexOf(normalizedSnippet, searchIndex)) !== -1) {
        const endIndex = searchIndex + cleanSnippet.length;
        
        const startNodeInfo = textNodes.find(n => 
            searchIndex >= n.startIndex && searchIndex < n.endIndex
        );
        const endNodeInfo = textNodes.find(n => 
            endIndex > n.startIndex && endIndex <= n.endIndex
        );
        
        if (startNodeInfo && endNodeInfo) {
            const range = document.createRange();
            range.setStart(startNodeInfo.node, searchIndex - startNodeInfo.startIndex);
            range.setEnd(endNodeInfo.node, endIndex - endNodeInfo.startIndex);
            occurrences.push({ range, position: searchIndex });
        }
        
        searchIndex++;
    }
    
    if (occurrences.length === 0) return null;
    if (occurrences.length === 1) return occurrences[0].range;

    // Disambiguate multiple occurrences using context before/after
    if (contextBefore || contextAfter) {
        for (const occ of occurrences) {
            const beforeText = fullText.substring(Math.max(0, occ.position - 100), occ.position);
            const afterText = fullText.substring(occ.position + cleanSnippet.length, occ.position + cleanSnippet.length + 100);
            
            const matchBefore = !contextBefore || beforeText.includes(contextBefore.slice(-30));
            const matchAfter = !contextAfter || afterText.includes(contextAfter.slice(0, 30));
            
            if (matchBefore && matchAfter) return occ.range;
        }
    }

    return occurrences[0].range;
}

function ntv_findByUTF8Offsets(container, startOffset, endOffset) {
    const text = container.textContent;
    
    // Build UTF-8 to character index map (handles emojis and multi-byte chars)
    let utf8Index = 0;
    const utf8ToCharMap = [];
    
    for (let i = 0; i < text.length; i++) {
        utf8ToCharMap[utf8Index] = i;
        utf8Index += ntv_lengthUTF8(text[i]);
    }
    utf8ToCharMap[utf8Index] = text.length;
    
    const startChar = utf8ToCharMap[startOffset] || 0;
    const endChar = utf8ToCharMap[endOffset] || text.length;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    
    let currentChar = 0;
    let startNode = null, startNodeOffset = 0;
    let endNode = null, endNodeOffset = 0;
    let node;
    
    while (node = walker.nextNode()) {
        const nodeLength = node.textContent.length;
        
        if (!startNode && currentChar + nodeLength > startChar) {
            startNode = node;
            startNodeOffset = startChar - currentChar;
        }
        
        if (!endNode && currentChar + nodeLength >= endChar) {
            endNode = node;
            endNodeOffset = endChar - currentChar;
            break;
        }
        
        currentChar += nodeLength;
    }
    
    if (startNode && endNode) {
        const range = document.createRange();
        range.setStart(startNode, startNodeOffset);
        range.setEnd(endNode, endNodeOffset);
        return range;
    }

    return null;
}

// Smart lane assignment: minimizes visual stacking by detecting actual horizontal overlap
// Non-overlapping highlights can share the same lane, reducing "+X" badges
function assignSmartLanes(rectsInLine) {
    const lanes = [];
    rectsInLine.sort((a, b) => a.rect.x - b.rect.x);
    
    for (const current of rectsInLine) {
        let placed = false;
        
        // Try to fit in an existing lane
        for (let laneIdx = 0; laneIdx < lanes.length; laneIdx++) {
            const lane = lanes[laneIdx];
            
            const overlaps = lane.some(other => {
                if (other.highlight.id === current.highlight.id) return false;
                // Check horizontal overlap using pixel coordinates
                return !(current.rect.x >= other.rect.x + other.rect.width || 
                         other.rect.x >= current.rect.x + current.rect.width);
            });
            
            if (!overlaps) {
                lane.push(current);
                current.stackIndex = laneIdx;
                placed = true;
                break;
            }
        }
        
        // Create new lane if no fit found
        if (!placed) {
            current.stackIndex = lanes.length;
            lanes.push([current]);
        }
    }
    
    return lanes;
}

function ntv_groupHighlightsByPosition(highlights, container) {
    const containerRect = container.getBoundingClientRect();
    const allRects = [];
    
    try {
        highlights.forEach(hl => {
            const range = ntv_findHighlightInDOM(container, hl);
            if (!range) {
                log(`[ntv] ❌ Highlight ${hl.id} not found in DOM, skipping`, 'error');
                return;
            }

            const rects = range.getClientRects();

            Array.from(rects).forEach((rect, idx) => {
                allRects.push({
                    highlight: hl,
                    rect: {
                        x: rect.left - containerRect.left,
                        y: rect.top - containerRect.top,
                        width: rect.width,
                        height: rect.height
                    },
                    stackIndex: 0
                });
            });
        });
    } catch (error) {
        log('[ntv] ❌ Error in groupHighlightsByPosition:', 'error', error);
    }

    // Group rects by visual line (~25px height) for lane assignment
    const lineHeight = 25;
    const lineGroups = new Map();
    
    allRects.forEach(item => {
        const lineIndex = Math.floor(item.rect.y / lineHeight);
        if (!lineGroups.has(lineIndex)) {
            lineGroups.set(lineIndex, []);
        }
        lineGroups.get(lineIndex).push(item);
    });

    lineGroups.forEach((rectsInLine, lineIndex) => {
        rectsInLine.sort((a, b) => a.rect.x - b.rect.x);
        assignSmartLanes(rectsInLine);
    });

    // Badge system: max 2 visible lanes (0-1), rest hidden with "+X" badge
    const MAX_OPAQUE_STACK = 1;
    
    // Group by position zones (50px horizontal buckets) to place badges
    const positionGroups = new Map();
    
    allRects.forEach(item => {
        const lineIndex = Math.floor(item.rect.y / 25);
        const xBucket = Math.floor(item.rect.x / 50);
        const key = `${lineIndex}-${xBucket}`;
        
        if (!positionGroups.has(key)) {
            positionGroups.set(key, []);
        }
        positionGroups.get(key).push(item);
    });
    
    const badges = new Map();
    
    positionGroups.forEach((items, key) => {
        items.sort((a, b) => a.stackIndex - b.stackIndex);
        
        const transparentCount = items.filter(item => item.stackIndex > MAX_OPAQUE_STACK).length;
        
        if (transparentCount > 0) {
            const representative = items.find(item => item.stackIndex === MAX_OPAQUE_STACK) || items[0];
            
            badges.set(key, {
                rect: representative.rect,
                stackIndex: MAX_OPAQUE_STACK,
                count: transparentCount,
                allItems: items.filter(item => item.stackIndex > MAX_OPAQUE_STACK)
            });
        }
        
        items.forEach(item => {
            if (item.stackIndex > MAX_OPAQUE_STACK) {
                item.isTransparent = true;
            } else {
                item.isTransparent = false;
            }
        });
    });

    return { visibleRects: allRects, indicators: badges };
}

function ntv_renderAllHighlights(highlights) {
    const startTime = performance.now();
    
    const svg = document.getElementById('ntv-highlights-overlay');
    const container = document.getElementById('ntv-document-content');
    
    if (!svg || !container) {
        log('[ntv] SVG overlay or content container not found', 'error');
        return;
    }

    const svgNS = "http://www.w3.org/2000/svg";
    svg.innerHTML = '';
    
    const groupStartTime = performance.now();
    const { visibleRects, indicators } = ntv_groupHighlightsByPosition(highlights, container);
    const groupEndTime = performance.now();
    log(`[ntv] grouping time: ${((groupEndTime - groupStartTime) / 1000).toFixed(3)} seconds`, 'info');
    
    const renderStartTime = performance.now();
    let lineCount = 0;
    let gradientCount = 0;
    
    visibleRects.forEach(item => {
        const { highlight, rect, stackIndex, isTransparent } = item;

        if (isTransparent) return;

        const tags = highlight.tags.map(tagId => findTag(tagId));
        const colors = tags.map(tag => tag.color);
        const lineY = rect.y + rect.height + 3 + (stackIndex * 5);

        if (colors.length === 1) {
            const line = ntv_createSVGLine(rect.x, lineY, rect.x + rect.width, colors[0], highlight, false);
            line.setAttribute("opacity", 0.9);
            svg.appendChild(line);
        } else {
            // Multi-tag: use SVG gradient to show all colors
            const group = document.createElementNS(svgNS, "g");
            group.setAttribute("data-line-id", `ntv-line-group-${lineCount}`);
            
            const gradientId = `ntv-gradient-${lineCount}-${gradientCount++}`;
            const gradient = ntv_createSVGGradient(gradientId, colors);
            group.appendChild(gradient);
            
            const line = ntv_createSVGLine(rect.x, lineY, rect.x + rect.width, `url(#${gradientId})`, highlight, true);
            line.setAttribute("opacity", 0.9);
            group.appendChild(line);
            
            svg.appendChild(group);
        }
        lineCount++;
    });

    indicators.forEach((badge, posKey) => {
        const { rect, stackIndex, count, allItems } = badge;
        const badgeY = rect.y + rect.height + 3 + ((stackIndex + 1) * 5) + 2;

        const badgeGroup = document.createElementNS(svgNS, "g");
        badgeGroup.setAttribute("class", "ntv-badge");
        badgeGroup.setAttribute("data-position-key", posKey);
        badgeGroup.style.cursor = 'pointer';
        badgeGroup.style.pointerEvents = 'all';

        const circle = document.createElementNS(svgNS, "circle");
        circle.setAttribute("cx", rect.x + rect.width + 8);
        circle.setAttribute("cy", badgeY);
        circle.setAttribute("r", "10");
        circle.setAttribute("fill", "#ff6b6b");
        circle.setAttribute("opacity", "0.85");
        circle.style.pointerEvents = 'all';
        badgeGroup.appendChild(circle);

        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("x", rect.x + rect.width + 8);
        text.setAttribute("y", badgeY + 4);
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("font-size", "11");
        text.setAttribute("font-weight", "bold");
        text.setAttribute("fill", "white");
        text.style.pointerEvents = 'none';
        text.textContent = `+${count}`;
        badgeGroup.appendChild(text);
        
        badgeGroup.addEventListener('mouseenter', function(e) {
            const tooltipContent = allItems.map(item => {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = item.highlight.snippet || '';
                const cleanSnippet = (tempDiv.textContent || tempDiv.innerText || '').substring(0, 50);
                return `• ${cleanSnippet}...`;
            }).join('<br>');
            
            let tooltip = document.getElementById('ntv-highlight-tooltip');
            if (!tooltip) {
                tooltip = document.createElement('div');
                tooltip.id = 'ntv-highlight-tooltip';
                document.body.appendChild(tooltip);
                Object.assign(tooltip.style, {
                    position: 'fixed',
                    padding: '10px',
                    background: '#fff',
                    border: '2px solid #333',
                    borderRadius: '6px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                    fontSize: '13px',
                    maxWidth: '400px',
                    zIndex: '10000',
                    pointerEvents: 'none'
                });
            }
            
            tooltip.innerHTML = `<strong>${count} ${gettext("hidden highlights")}:</strong><br><br>${tooltipContent}`;
            tooltip.style.display = 'block';
            tooltip.style.left = (e.clientX + 15) + 'px';
            tooltip.style.top = (e.clientY + 15) + 'px';
        });
        
        badgeGroup.addEventListener('mouseleave', function() {
            ntv_hideLineTooltip();
        });
        
        badgeGroup.addEventListener('click', function(e) {
            e.stopPropagation();
            ntv_showHiddenHighlightsModal(allItems, e);
        });

        svg.appendChild(badgeGroup);
    });
    
    const renderEndTime = performance.now();
    log(`[ntv] render time: ${((renderEndTime - renderStartTime) / 1000).toFixed(3)} seconds`, 'info');
    
    const endTime = performance.now();
    log(`[ntv] total renderAllHighlights time: ${((endTime - startTime) / 1000).toFixed(3)} seconds`, 'info');
}

// Create SVG line for highlight
function ntv_createSVGLine(x1, y, x2, color, highlight, isGradient = false) {
    const svgNS = "http://www.w3.org/2000/svg";
    const line = document.createElementNS(svgNS, "line");
    
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y + (isGradient ? 0.1 : 0));
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "4");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("data-highlight-id", highlight.id);
    line.style.pointerEvents = 'all';
    line.style.cursor = 'pointer';
    line.style.transition = 'stroke-width 0.2s';
    
    line.addEventListener('mouseenter', function(e) {
        line.setAttribute("stroke-width", "5");
        ntv_showLineTooltip(e, highlight.id);
    });
    
    line.addEventListener('mouseleave', function() {
        line.setAttribute("stroke-width", "4");
        ntv_hideLineTooltip();
    });
    
    line.addEventListener('click', function() {
        ntv_editHighlight.call(line);
    });
    
    return line;
}

function ntv_createSVGGradient(id, colors) {
    const svgNS = "http://www.w3.org/2000/svg";
    const gradient = document.createElementNS(svgNS, "linearGradient");
    
    gradient.setAttribute("id", id);
    gradient.setAttribute("x1", "0%");
    gradient.setAttribute("y1", "0%");
    gradient.setAttribute("x2", "100%");
    gradient.setAttribute("y2", "0%");
    
    colors.forEach((color, index) => {
        const stop = document.createElementNS(svgNS, "stop");
        const offset = colors.length === 1 ? "100%" : `${(index / (colors.length - 1)) * 100}%`;
        stop.setAttribute("offset", offset);
        stop.setAttribute("stop-color", color);
        gradient.appendChild(stop);
    });
    
    return gradient;
}

function ntv_showLineTooltip(event, highlightId) {
    let tooltip = document.getElementById('ntv-highlight-tooltip');
    
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'ntv-highlight-tooltip';
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
            overflowWrap: 'break-word'
        });
    }
    
    const highlight = ntv_highlights[highlightId];
    if (!highlight) return;
    
    const tags = highlight.tags.map(tagId => findTag(tagId));
    
    // Clean the snippet HTML for display
    let cleanSnippet = '';
    if (highlight.snippet) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = highlight.snippet;
        cleanSnippet = tempDiv.textContent || tempDiv.innerText || '';
    }
    
    tooltip.innerHTML = `
        ${cleanSnippet ? `
            <div style="font-size: 11px; color: #666; margin-bottom: 6px; font-style: italic; word-wrap: break-word;">
                "${cleanSnippet.substring(0, 60)}${cleanSnippet.length > 60 ? '...' : ''}"
            </div>
        ` : ''}
        <div style="display: flex; gap: 4px; flex-wrap: wrap; max-width: 280px;">
            ${tags.map(tag => `
                <div style="
                    display: inline-block;
                    padding: 4px 8px;
                    border-radius: 3px;
                    background-color: ${tag.color};
                    color: white;
                    font-size: 11px;
                    max-width: 100%;
                    word-wrap: break-word;
                    overflow-wrap: break-word;
                ">
                    ${tag.path || tag.name}
                </div>
            `).join('')}
        </div>
    `;
    
    tooltip.style.display = 'block';
    tooltip.style.left = (event.clientX + 10) + 'px';
    tooltip.style.top = (event.clientY + 10) + 'px';
}

function ntv_hideLineTooltip() {
    const tooltip = document.getElementById('ntv-highlight-tooltip');
    if (tooltip) tooltip.style.display = 'none';
}

// Show modal with hidden highlights (for "+X" badge)
function ntv_showHiddenHighlightsModal(hiddenItems, event) {
    let modal = document.getElementById('ntv-hidden-highlights-modal');
    
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'ntv-hidden-highlights-modal';
        document.body.appendChild(modal);
        
        Object.assign(modal.style, {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'white',
            border: '2px solid #333',
            borderRadius: '12px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            padding: '20px',
            maxWidth: '600px',
            maxHeight: '70vh',
            overflow: 'auto',
            zIndex: '10001'
        });
        
        const overlay = document.createElement('div');
        overlay.id = 'ntv-modal-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;';
        overlay.addEventListener('click', function() {
            modal.style.display = 'none';
            overlay.style.display = 'none';
        });
        document.body.appendChild(overlay);
    }
    
    const overlay = document.getElementById('ntv-modal-overlay');
    
    // Build the content
    let content = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h3 style="margin: 0; color: #333;">
                <i class="fas fa-layer-group"></i> ${hiddenItems.length} ${gettext("hidden highlights")}
            </h3>
            <button onclick="document.getElementById('ntv-hidden-highlights-modal').style.display='none'; document.getElementById('ntv-modal-overlay').style.display='none';" 
                    style="border: none; background: none; font-size: 24px; cursor: pointer; color: #999;">
                ×
            </button>
        </div>
        <div style="color: #666; font-size: 13px; margin-bottom: 15px;">
            ${gettext("These highlights are hidden to avoid visual clutter.")}
        </div>
    `;
    
    hiddenItems.forEach((item, index) => {
        const highlight = item.highlight;
        const tags = highlight.tags.map(tagId => findTag(tagId));
        
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = highlight.snippet || '';
        const cleanSnippet = (tempDiv.textContent || tempDiv.innerText || '').substring(0, 150);

        const colorBadges = tags.map(tag =>
            `<span style="display:inline-block; width:12px; height:12px; background:${tag.color}; border-radius:50%; margin-right:4px;" title="${tag.path}"></span>`
        ).join('');

        content += `
            <div class="ntv-hidden-highlight-card" data-highlight-id="${highlight.id}"
                 style="padding: 12px; margin-bottom: 10px; border: 1px solid #ddd; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                <div style="display: flex; align-items: center; margin-bottom: 8px;">
                    <div style="display: flex; gap: 2px;">
                        ${colorBadges}
                    </div>
                </div>
                <div style="color: #333; font-size: 14px; line-height: 1.5;">
                    "${cleanSnippet}${cleanSnippet.length >= 150 ? '...' : ''}"
                </div>
                <div style="margin-top: 8px; font-size: 12px; color: #666;">
                    ${tags.map(t => `<span style="background:#e9ecef; padding:2px 8px; border-radius:12px; margin-right:5px;">${t.path}</span>`).join('')}
                </div>
                <div style="margin-top: 10px; text-align: right;">
                    <button class="btn btn-sm btn-outline-primary" style="font-size: 11px; padding: 4px 12px;">
                        <i class="fas fa-edit"></i> ${gettext("Edit")}
                    </button>
                </div>
            </div>
        `;
    });
    
    modal.innerHTML = content;
    modal.style.display = 'block';
    overlay.style.display = 'block';


    const cards = modal.querySelectorAll('.ntv-hidden-highlight-card');
    cards.forEach(card => {
        const highlightId = card.getAttribute('data-highlight-id');

        card.addEventListener('mouseenter', function() {
            card.style.background = '#f8f9fa';
            card.style.borderColor = '#007bff';
        });
        
        card.addEventListener('mouseleave', function() {
            card.style.background = 'white';
            card.style.borderColor = '#ddd';
        });

        card.addEventListener('click', function(e) {
            if (window.getSelection) {
                window.getSelection().removeAllRanges();
            }

            modal.style.display = 'none';
            overlay.style.display = 'none';

            const highlight = ntv_highlights['' + highlightId];
            if (highlight) {
                const fakeElement = {
                    getAttribute: function(attr) {
                        if (attr === 'data-highlight-id') return highlightId;
                        return null;
                    }
                };
                ntv_editHighlight.call(fakeElement);
            }
        });
    });
}

function ntv_describeSelection() {
    const sel = window.getSelection();
    if (sel.rangeCount === 0 || sel.isCollapsed) {
        return null;
    }
    
    const range = sel.getRangeAt(0);
    const container = document.getElementById('ntv-document-content');
    
    if (!container) {
        log('[ntv] ntv-document-content container not found!', 'error');
        return null;
    }
    
    if (!container.contains(range.commonAncestorContainer)) {
        return null;
    }

    const tempRange = document.createRange();
    tempRange.selectNodeContents(container);
    tempRange.setEnd(range.startContainer, range.startOffset);
    const textBeforeStart = tempRange.toString();
    
    tempRange.selectNodeContents(container);
    tempRange.setEnd(range.endContainer, range.endOffset);
    const textBeforeEnd = tempRange.toString();

    const startOffset = ntv_lengthUTF8String(textBeforeStart);
    const endOffset = ntv_lengthUTF8String(textBeforeEnd);

    return [startOffset, endOffset];
}

