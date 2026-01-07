// SVG rendering functions for highlight system

const DEFAULT_STROKE_WIDTH = "4";
const highlightTags = new Map();

// Firefox workaround: use <defs> to prevent SVG from interfering with text selection
function createDefsHighlightGroup(line, svgNamespace, svg) {
    const highlightsId = `highlights-${line.startOffset}-${line.endOffset}`;
    const highlightsGroup = document.createElementNS(svgNamespace, "g");
    highlightsGroup.setAttribute("id", highlightsId);
    highlightsGroup.setAttribute("class", "highlights");
    globalDefs.appendChild(highlightsGroup);

    const useElement = document.createElementNS(svgNamespace, "use");
    useElement.setAttribute("href", `#${highlightsId}`);
    svg.appendChild(useElement);

    return highlightsGroup;
}

// Multi-tag: create linear gradient to show all colors
function createSvgGradient(svgNamespace, highlight, colors) {
    const gradient = document.createElementNS(svgNamespace, "linearGradient");
    gradient.setAttribute("id", `gradient-${highlight.id}`);
    gradient.setAttribute("x1", "0%");
    gradient.setAttribute("y1", "0%");
    gradient.setAttribute("x2", "100%");
    gradient.setAttribute("y2", "0%");

    colors.forEach((color, index) => {
        const stop = document.createElementNS(svgNamespace, "stop");
        stop.setAttribute("offset", `${(index / (colors.length - 1)) * 100}%`);
        stop.setAttribute("stop-color", color);
        gradient.appendChild(stop);
    });

    return gradient;
}

function createSvgLine(svgParent, svgNamespace, highlight, rect, color, strokeType = 'solid', useDefs = false) {
    const line = document.createElementNS(svgNamespace, "line");

    const textElement = svgParent.querySelector('text');
    const textBox = textElement.getBBox();

    const x1 = textBox.x + (rect.x1 === 0 ? 2 : rect.x1);
    const x2 = textBox.x + rect.x2;

    line.setAttribute("data-highlight-id", highlight.id);
    line.setAttribute("data-parent-line-id", $(svgParent).data('line--id').replace('-group', ''));
    line.setAttribute("x1", x1);
    line.setAttribute("x2", x2);
    line.setAttribute("y1", rect.y);
    line.setAttribute("y2", rect.y + (strokeType === 'gradient' ? 0.1 : 0));
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-width", DEFAULT_STROKE_WIDTH);
    line.setAttribute("pointer-events", "all");

    if (useDefs) {
        line.setAttribute("onclick", `editHighlight.call(this, '${highlight.id}')`);
        line.setAttribute("onmouseover", `this.style.strokeWidth='7'; showLineTooltip.call(this, this, '${highlight.id}', true);`);
        line.setAttribute("onmouseout", `this.style.strokeWidth='${DEFAULT_STROKE_WIDTH}'; hideLineTooltip();`);
    } else {
        line.classList.add("smooth-stroke");
        line.addEventListener("mouseover", (event) => { 
            line.setAttribute("stroke-width", "7"); 
            showLineTooltip(event, highlight.id); 
        });
        line.addEventListener("mouseout", () => { 
            line.setAttribute("stroke-width", DEFAULT_STROKE_WIDTH); 
            hideLineTooltip(); 
        });
        line.addEventListener("click", () => editHighlight.call(line, highlight.id));
    }

    return line;
}

function createSvgUnderline(textParent, rect, highlight, useDefs = false) {
    const svgNamespace = "http://www.w3.org/2000/svg";

    const tags = highlight.tags.map(id => findTag(id));
    const colors = tags.map(tag => tag.color);
    highlightTags.set(highlight.id, tags);

    if (colors.length === 1) {
        return createSvgLine(textParent, svgNamespace, highlight, rect, colors[0], 'solid', useDefs);
    }

    const gradient = createSvgGradient(svgNamespace, highlight, colors);
    textParent.appendChild(gradient);

    return createSvgLine(textParent, svgNamespace, highlight, rect, `url(#gradient-${highlight.id})`, 'gradient', useDefs);
}

function showLineTooltip(element, highlightId, useDefs = false) {
    let tooltip = document.getElementById('highlight-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'highlight-tooltip';
        document.body.appendChild(tooltip);

        tooltip.style.position = 'fixed';
        tooltip.style.padding = '8px';
        tooltip.style.background = '#fff';
        tooltip.style.border = '1px solid #ddd';
        tooltip.style.borderRadius = '4px';
        tooltip.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        tooltip.style.fontSize = '12px';
        tooltip.style.pointerEvents = 'none';
        tooltip.style.zIndex = '1000';
    }

    const tags = highlightTags.get(parseInt(highlightId, 10));

    tooltip.innerHTML = tags.map(tag => `
       <div class="tag-badge" style="
           display: block;
           padding: 4px 8px;
           margin: 4px 0;
           border-radius: 3px;
           background-color: ${tag.color};
           color: white;
           font-size: 1rem;
           white-space: nowrap;
       ">
           ${tag.path}
       </div>
   `).join('');

    if(useDefs) {
        const rect = element.getBoundingClientRect();
        tooltip.style.display = 'block';
        tooltip.style.left = (rect.right - (rect.width / 2)) + 'px';
        tooltip.style.top = (rect.top + 10) + 'px';
    } else {
        tooltip.style.display = 'block';
        tooltip.style.left = (element.clientX + 10) + 'px';
        tooltip.style.top = (element.clientY + 10) + 'px';
    }
}

function hideLineTooltip() {
    const tooltip = document.getElementById('highlight-tooltip');
    if (tooltip) {
        tooltip.style.display = 'none';
    }
}

function adjustLineHeight(divContainer, textGroup, highlightCount) {
    const lineHeight = 40;
    const extraHeightPerHighlight = 12.5;
    const totalHeight = lineHeight + highlightCount * extraHeightPerHighlight;
    textGroup.parentNode.setAttribute("height", `${totalHeight}px`);
    divContainer.style.height = `${totalHeight}px`;
}

function calculateYPositionWithDefs(itemsCount) {
    const baseY = 30;
    const spacing = 10;
    const additionalSpacing = 5;
    return baseY + (itemsCount * spacing) + (itemsCount * additionalSpacing);
}

function calculateYPosition(itemsCount) {
    const baseY = 10;
    const spacing = 10;
    const additionalSpacing = 5;
    return baseY + (itemsCount * spacing) + (itemsCount * additionalSpacing);
}

