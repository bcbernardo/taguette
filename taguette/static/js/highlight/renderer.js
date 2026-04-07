const LINE_HEIGHT = 3;
const LINE_GAP = 2;
const BASE_OFFSET = 2;

function renderHighlights(hlList) {
    const container = document.getElementById('highlight-content');
    const svg = document.getElementById('highlights-overlay');
    if (!svg || !container) return;

    const targets = getBlockTargets(container);
    targets.forEach(el => { el.style.lineHeight = ''; });

    const targetMaxLanes = estimateMaxLanesPerTarget(hlList, targets, container);

    let layoutChanged = false;
    targetMaxLanes.forEach((maxLanes, el) => {
        const newLH = (1.6 + maxLanes * 0.18) + 'em';
        if (el.style.lineHeight !== newLH) {
            el.style.lineHeight = newLH;
            layoutChanged = true;
        }
    });

    if (layoutChanged) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => drawHighlights(hlList, container, svg));
        });
    } else {
        drawHighlights(hlList, container, svg);
    }
}

function estimateMaxLanesPerTarget(hlList, targets, container) {
    if (hlList.length === 0) return new Map();

    const textNodes = collectTextNodes(container);
    const { fullText } = buildCharMap(textNodes);

    const nodeToTarget = new Map();
    textNodes.forEach(node => {
        let el = node.parentElement;
        while (el && el.id !== 'highlight-content') {
            if (targets.includes(el)) {
                nodeToTarget.set(node, el);
                break;
            }
            el = el.parentElement;
        }
    });

    const charToTarget = [];
    textNodes.forEach(node => {
        const target = nodeToTarget.get(node);
        for (const _ of node.textContent) {
            charToTarget.push(target);
        }
    });

    const targetHighlights = new Map();
    hlList.forEach(hl => {
        const startChar = getCharIndexFromUTF8Index(fullText, hl.start_offset);
        const endChar = getCharIndexFromUTF8Index(fullText, hl.end_offset);
        const midChar = Math.max(0, Math.min(charToTarget.length - 1, Math.floor((startChar + endChar) / 2)));
        const target = charToTarget[midChar];
        if (target) {
            if (!targetHighlights.has(target)) targetHighlights.set(target, []);
            targetHighlights.get(target).push(hl);
        }
    });

    const result = new Map();
    targetHighlights.forEach((hls, target) => {
        const sorted = hls.slice().sort((a, b) => a.start_offset - b.start_offset);
        const laneEnds = [];
        for (const hl of sorted) {
            let placed = false;
            for (let i = 0; i < laneEnds.length; i++) {
                if (laneEnds[i] <= hl.start_offset) {
                    laneEnds[i] = hl.end_offset;
                    placed = true;
                    break;
                }
            }
            if (!placed) laneEnds.push(hl.end_offset);
        }
        result.set(target, laneEnds.length);
    });

    return result;
}

function getBlockTargets(container) {
    const targets = [];
    const chunksWithBlocks = new Set();
    const blockSelectors = '.document-chunk p, .document-chunk h1, .document-chunk h2, .document-chunk h3, .document-chunk h4, .document-chunk h5, .document-chunk h6, .document-chunk li, .document-chunk blockquote';

    container.querySelectorAll(blockSelectors).forEach(el => {
        targets.push(el);
        const chunk = el.closest('.document-chunk');
        if (chunk) chunksWithBlocks.add(chunk);
    });

    container.querySelectorAll('.document-chunk').forEach(chunk => {
        if (!chunksWithBlocks.has(chunk)) targets.push(chunk);
    });

    return targets;
}

function drawHighlights(hlList, container, svg) {
    const startTime = performance.now();
    const svgNS = "http://www.w3.org/2000/svg";
    svg.innerHTML = '';

    const textNodes = collectTextNodes(container);
    const { fullText, charMap } = buildCharMap(textNodes);
    const containerRect = container.getBoundingClientRect();

    const allRects = [];
    hlList.forEach(hl => {
        const rects = highlightToRects(hl, fullText, charMap, containerRect);
        if (!rects || rects.length === 0) return;
        rects.forEach(rect => {
            allRects.push({ highlight: hl, rect, stackIndex: 0 });
        });
    });

    const lineGroups = new Map();
    allRects.forEach(item => {
        const lineIndex = Math.floor(item.rect.y / 25);
        if (!lineGroups.has(lineIndex)) lineGroups.set(lineIndex, []);
        lineGroups.get(lineIndex).push(item);
    });

    lineGroups.forEach(rectsInLine => assignSmartLanes(rectsInLine));

    let lineCount = 0;
    let gradientCount = 0;

    allRects.forEach(item => {
        const { highlight, rect, stackIndex } = item;
        const tags = highlight.tags.map(tagId => findTag(tagId));
        const colors = tags.map(tag => tag.color);
        const lineY = rect.y + rect.height + BASE_OFFSET + (stackIndex * (LINE_HEIGHT + LINE_GAP));

        if (colors.length === 1) {
            const line = createSVGLine(rect.x, lineY, rect.x + rect.width, colors[0], highlight, false);
            line.setAttribute("opacity", 0.9);
            svg.appendChild(line);
        } else {
            const group = document.createElementNS(svgNS, "g");
            const gradientId = `gradient-${lineCount}-${gradientCount++}`;
            group.appendChild(createSVGGradient(gradientId, colors));

            const line = createSVGLine(rect.x, lineY, rect.x + rect.width, `url(#${gradientId})`, highlight, true);
            line.setAttribute("opacity", 0.9);
            group.appendChild(line);
            svg.appendChild(group);
        }
        lineCount++;
    });

    svg.setAttribute('height', container.scrollHeight);
    svg.style.height = container.scrollHeight + 'px';
    log(`renderHighlights: ${((performance.now() - startTime) / 1000).toFixed(3)}s, ${lineCount} lines`);
}

function collectTextNodes(container) {
    const nodes = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let node;
    while (node = walker.nextNode()) nodes.push(node);
    return nodes;
}

function buildCharMap(textNodes) {
    let fullText = '';
    const charMap = [];
    textNodes.forEach(node => {
        const text = node.textContent;
        for (let i = 0; i < text.length; i++) {
            charMap.push({ node, offset: i });
        }
        fullText += text;
    });
    return { fullText, charMap };
}

function highlightToRects(highlight, fullText, charMap, containerRect) {
    if (highlight.start_offset === undefined || highlight.end_offset === undefined) return null;

    const startChar = getCharIndexFromUTF8Index(fullText, highlight.start_offset);
    const endChar = getCharIndexFromUTF8Index(fullText, highlight.end_offset);
    if (startChar >= charMap.length || endChar <= 0 || startChar >= endChar) return null;

    const clampedStart = Math.max(0, startChar);
    const clampedEnd = Math.min(charMap.length, endChar);
    const startEntry = charMap[clampedStart];
    const endEntry = charMap[clampedEnd - 1];
    if (!startEntry || !endEntry) return null;

    try {
        const range = document.createRange();
        range.setStart(startEntry.node, startEntry.offset);
        range.setEnd(endEntry.node, endEntry.offset + 1);

        const clientRects = range.getClientRects();
        const raw = [];
        for (const r of clientRects) {
            if (r.width > 0 && r.height > 0) {
                raw.push({
                    x: r.left - containerRect.left,
                    y: r.top - containerRect.top,
                    width: r.width,
                    height: r.height
                });
            }
        }
        return deduplicateRects(raw);
    } catch (e) {
        log(`Error creating range for highlight ${highlight.id}: ${e.message}`, 'error');
        return null;
    }
}

function deduplicateRects(rects) {
    // Remove exact duplicates
    const unique = [];
    for (const r of rects) {
        const isDupe = unique.some(u =>
            Math.abs(u.x - r.x) < 1 && Math.abs(u.y - r.y) < 1 &&
            Math.abs(u.width - r.width) < 1 && Math.abs(u.height - r.height) < 1
        );
        if (!isDupe) unique.push(r);
    }

    // 2. Remove block-level rects (taller than text rects)
    const medianHeight = unique.length > 0
        ? unique.map(r => r.height).sort((a, b) => a - b)[Math.floor(unique.length / 2)]
        : 20;
    const result = [];
    for (const r of unique) {
        if (r.height > medianHeight * 1.3) {
            const hasOverlapping = unique.some(other => {
                if (other === r) return false;
                return Math.abs(r.y - other.y) < r.height &&
                       other.height <= medianHeight * 1.1;
            });
            if (hasOverlapping) continue; // skip this block-level rect
        }
        result.push(r);
    }

    // Merge adjacent rects on the same visual line
    result.sort((a, b) => a.y - b.y || a.x - b.x);
    const merged = [];
    for (const rect of result) {
        const last = merged[merged.length - 1];
        if (last && Math.abs(last.y - rect.y) < 3) {
            const gap = rect.x - (last.x + last.width);
            if (gap < 2) {
                last.width = Math.max(last.x + last.width, rect.x + rect.width) - last.x;
                last.height = Math.max(last.height, rect.height);
                continue;
            }
        }
        merged.push({ ...rect });
    }
    return merged;
}

function assignSmartLanes(rectsInLine) {
    const lanes = [];
    rectsInLine.sort((a, b) => a.rect.x - b.rect.x);

    for (const current of rectsInLine) {
        let placed = false;
        for (let laneIdx = 0; laneIdx < lanes.length; laneIdx++) {
            const overlaps = lanes[laneIdx].some(other => {
                if (other.highlight.id === current.highlight.id) return false;
                return !(current.rect.x >= other.rect.x + other.rect.width ||
                         other.rect.x >= current.rect.x + current.rect.width);
            });
            if (!overlaps) {
                lanes[laneIdx].push(current);
                current.stackIndex = laneIdx;
                placed = true;
                break;
            }
        }
        if (!placed) {
            current.stackIndex = lanes.length;
            lanes.push([current]);
        }
    }
    return lanes;
}

function createSVGLine(x1, y, x2, color, highlight, isGradient) {
    const svgNS = "http://www.w3.org/2000/svg";
    const line = document.createElementNS(svgNS, "line");

    line.setAttribute("x1", x1);
    line.setAttribute("y1", y);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y + (isGradient ? 0.1 : 0));
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", LINE_HEIGHT);
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("data-highlight-id", highlight.id);
    line.style.pointerEvents = 'all';
    line.style.cursor = 'pointer';
    line.style.transition = 'stroke-width 0.2s';

    line.addEventListener('mouseenter', function(e) {
        line.setAttribute("stroke-width", "5");
        showLineTooltip(e, highlight.id);
    });
    line.addEventListener('mouseleave', function() {
        line.setAttribute("stroke-width", LINE_HEIGHT);
        hideLineTooltip();
    });
    line.addEventListener('click', function() {
        editHighlight.call(line);
    });

    return line;
}

function createSVGGradient(id, colors) {
    const svgNS = "http://www.w3.org/2000/svg";
    const gradient = document.createElementNS(svgNS, "linearGradient");
    gradient.setAttribute("id", id);
    gradient.setAttribute("x1", "0%");
    gradient.setAttribute("y1", "0%");
    gradient.setAttribute("x2", "100%");
    gradient.setAttribute("y2", "0%");

    colors.forEach((color, index) => {
        const stop = document.createElementNS(svgNS, "stop");
        stop.setAttribute("offset", colors.length === 1 ? "100%" : `${(index / (colors.length - 1)) * 100}%`);
        stop.setAttribute("stop-color", color);
        gradient.appendChild(stop);
    });
    return gradient;
}

function showLineTooltip(event, highlightId) {
    let tooltip = document.getElementById('highlight-tooltip');

    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'highlight-tooltip';
        document.body.appendChild(tooltip);
        Object.assign(tooltip.style, {
            position: 'fixed', padding: '10px', background: '#fff',
            border: '2px solid #333', borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)', fontSize: '13px',
            pointerEvents: 'none', zIndex: '10000', maxWidth: '300px',
            wordWrap: 'break-word', overflowWrap: 'break-word'
        });
    }

    const hl = highlights[highlightId];
    if (!hl) return;

    const tags = hl.tags.map(tagId => findTag(tagId));
    tooltip.innerHTML = `
        <div style="display: flex; gap: 4px; flex-wrap: wrap; max-width: 280px;">
            ${tags.map(tag => `
                <div style="display: inline-block; padding: 4px 8px; border-radius: 3px;
                    background-color: ${tag.color}; color: white; font-size: 11px;">
                    ${tag.path || tag.name}
                </div>
            `).join('')}
        </div>
    `;
    tooltip.style.display = 'block';
    tooltip.style.left = (event.clientX + 10) + 'px';
    tooltip.style.top = (event.clientY + 10) + 'px';
}

function hideLineTooltip() {
    const tooltip = document.getElementById('highlight-tooltip');
    if (tooltip) tooltip.style.display = 'none';
}
