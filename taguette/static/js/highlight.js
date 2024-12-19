// Inspired by https://github.com/doccano/v-annotator

// important classes for highlight documents
class Font {
    constructor(fontSize, fontFamily, fontWeight) {
        this.fontSize = fontSize;
        this.fontFamily = fontFamily;
        this.fontWeight = fontWeight;
        this.charWidthCache = {};
    }

    cachedWidthOf(char) {
        if (this.charWidthCache[char] !== undefined) {
            return this.charWidthCache[char];
        }

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        context.font = `${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`;
        const width = context.measureText(char).width;

        this.charWidthCache[char] = width;

        return width;
    }

    widthOf(text) {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        context.font = `${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`;
        return context.measureText(text).width;
    }

    static create(textElement) {
        const computedStyle = window.getComputedStyle(textElement);
        return new Font(
            parseFloat(computedStyle.fontSize),
            computedStyle.fontFamily,
            computedStyle.fontWeight
        );
    }
}

class LineWidthManager {
    constructor(maxLineWidth, maxLabelWidth) {
        this.maxLineWidth = maxLineWidth;
        this.maxLabelWidth = maxLabelWidth;
        this.totalWidth = 0;
    }

    get width() {
        return this.totalWidth;
    }

    get maxWidth() {
        return this.maxLineWidth - this.maxLabelWidth;
    }

    add(width) {
        this.totalWidth += width;
    }

    reset() {
        this.totalWidth = 0;
    }

    isFull(wordOrLabelWidth = 0) {
        return this.maxWidth < this.totalWidth + wordOrLabelWidth;
    }

    canAdd(width) {
        return this.totalWidth + width <= this.maxWidth;
    }

    isEmpty() {
        return this.totalWidth === 0;
    }
}

class TextLine {
    constructor(startOffset, endOffset) {
        this.startOffset = startOffset;
        this.endOffset = endOffset;
    }
}

class BaseTextLineSplitter {
    constructor(widthManager, font) {
        this.widthManager = widthManager;
        this.font = font;
        this.wordWidthCache = new Map();
    }

    needsNewline(i, text, char) {
        if (char === "\n" || char === "\r") {
            return true;
        }

        const wordWidth = this.calculateWordLength(i, text);
        return !this.widthManager.canAdd(wordWidth);
    }

    calculateWordLength(i, text) {
        const restOfText = text.slice(i);
        const spaceIndex = restOfText.indexOf(' ');
        const newlineIndex = restOfText.indexOf('\n');
        const returnIndex = restOfText.indexOf('\r');

        //  check no word is split at the end of line
        let endIndex = spaceIndex !== -1 ? spaceIndex : restOfText.length;
        if (newlineIndex !== -1 && newlineIndex < endIndex) endIndex = newlineIndex;
        if (returnIndex !== -1 && returnIndex < endIndex) endIndex = returnIndex;

        const word = restOfText.slice(0, endIndex);

        if (this.wordWidthCache.has(word)) {
            return this.wordWidthCache.get(word);
        }

        let totalWidth = 0;
        for (let j = 0; j < word.length; j++) {
            totalWidth += this.font.cachedWidthOf(word[j]);
        }

        this.wordWidthCache.set(word, totalWidth);

        return totalWidth;
    }

    clearCache() {
        this.wordWidthCache.clear();
    }
}
class FullTextLineSplitter extends BaseTextLineSplitter {
    constructor(widthManager, font) {
        super(widthManager, font);
    }

    split(text) {
        this.clearCache();
        document_lines.length = 0;
        this.widthManager.reset();
        let startOffsetUTF8 = 0;
        let currentUTF8Offset = 0;
        const textLength = text.length;
        const lines = [];

        for (let i = 0; i < textLength; i++) {
            const ch = text[i];
            const charWidth = this.font.cachedWidthOf(ch);
            const charUTF8Length = lengthUTF8(ch);

            if (this.needsNewline(i, text, ch)) {
                lines.push(new TextLine(startOffsetUTF8, currentUTF8Offset));
                this.widthManager.reset();
                startOffsetUTF8 = currentUTF8Offset;
            }

            this.widthManager.add(charWidth);
            currentUTF8Offset += charUTF8Length;
        }

        if (!this.widthManager.isEmpty()) {
            lines.push(new TextLine(startOffsetUTF8, currentUTF8Offset));
        }

        return lines;
    }
}

class Range {
    constructor(x1, x2) {
        if (x1 > x2) {
            throw new RangeError(`The argument must be x1 <= x2.`);
        }
        this.x1 = x1;
        this.x2 = x2;
    }

    get center() {
        return this.x1 + (this.x2 - this.x1) / 2;
    }
}

class Ranges {
    constructor(rtl = false) {
        this.rtl = rtl;
        this._items = [];
    }

    get items() {
        return this._items;
    }

    add(x1, x2) {
        const range = new Range(x1, x2);
        if (this.rtl) {
            this._items.unshift(range);
        } else {
            this._items.push(range);
        }
    }

    get first() {
        return this.items[0];
    }

    get center() {
        return this.first.center;
    }
}

function createRanges(element, highlight, line) {
    const ranges = new Ranges(false);
    const hasTspans = element.getElementsByTagName('tspan').length > 0;

    // Handle formatted text with <tspan> elements
    if (hasTspans) {
        const tempContainer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const tempText = document.createElementNS("http://www.w3.org/2000/svg", "text");

        tempText.setAttribute("x", element.getAttribute("x"));
        tempText.setAttribute("y", element.getAttribute("y"));
        tempText.setAttribute("text-anchor", element.getAttribute("text-anchor"));

        // Merge all <tspan> content into one temporary <tspan>
        const tspans = Array.from(element.getElementsByTagName('tspan'));
        const validTspan = tspans.find(tspan => tspan.textContent.trim() !== "") || tspans[0];
        const tempTspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");

        // Copy attributes from the valid tspan
        Array.from(validTspan.attributes).forEach(attr => {
            tempTspan.setAttribute(attr.name, attr.value);
        });

        const fullText = tspans.map(tspan => tspan.textContent).join('');
        tempTspan.textContent = fullText;

        tempText.appendChild(tempTspan);
        tempContainer.appendChild(tempText);
        document.body.appendChild(tempContainer);

        // Calculate start and end offsets
        const start = Math.max(highlight.start_offset, line.startOffset) - line.startOffset;
        const end = Math.min(highlight.end_offset, line.endOffset) - line.startOffset;

        // Convert UTF-8 offsets to character offsets
        const startChar = getCharIndexFromUTF8Index(fullText, start);
        const endChar = getCharIndexFromUTF8Index(fullText, end);

        if (startChar !== -1 && endChar !== -1) {
            const range = document.createRange();
            range.setStart(tempTspan.firstChild, startChar);
            range.setEnd(tempTspan.firstChild, endChar);

            const rects = range.getClientRects();
            const elementRect = tempText.getBoundingClientRect();

            for (const rect of rects) {
                // Adjust the coordinates based on the parent element's position
                const adjustedLeft = rect.left - elementRect.left;
                const adjustedRight = rect.right - elementRect.left;
                ranges.add(adjustedLeft, adjustedRight);
            }
        }

        // Clean up the temporary container
        document.body.removeChild(tempContainer);
    } else {
        // Handle plain text (no <tspan> formatting)
        const node = element.firstChild;
        const lineText = element.textContent;

        // Calculate start and end offsets
        const start = Math.max(highlight.start_offset, line.startOffset) - line.startOffset;
        const end = Math.min(highlight.end_offset, line.endOffset) - line.startOffset;

        // Convert UTF-8 offsets to character offsets
        const startChar = getCharIndexFromUTF8Index(lineText, start);
        const endChar = getCharIndexFromUTF8Index(lineText, end);

        if (startChar !== -1 && endChar !== -1) {
            const range = document.createRange();
            range.setStart(node, startChar);
            range.setEnd(node, endChar);

            const rects = range.getClientRects();
            const elementRect = element.getBoundingClientRect();

            for (const rect of rects) {
                // Adjust the coordinates based on the parent element's position
                const adjustedLeft = rect.left - elementRect.left;
                const adjustedRight = rect.right - elementRect.left;
                ranges.add(adjustedLeft, adjustedRight);
            }
        }
    }

    return ranges;
}

/*
 * Highlights
 */

let document_lines = [];
const DEFAULT_STROKE_WIDTH = "4";
let wordTracker = {};

function extractTextFromHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;

    const cleanNode = (node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
            const textNode = document.createTextNode(node.textContent);
            node.replaceWith(textNode);
        }
        [...node.childNodes].forEach(cleanNode);
    };

    cleanNode(div);

    return div.textContent.trim();
}

function extractFormattedContent(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    const plainText = extractTextFromHtml(html);

    const formattedPortions = [];
    let index = 1;

    /**
     * Count occurrences of a specific text up to the current node.
     */
    function countOccurrencesUpTo(searchText, node) {
        let count = 0;
        let tempDiv = document.createElement('div');

        // Traverse previous siblings and parent nodes
        let currentNode = node;
        while (currentNode.previousSibling) {
            tempDiv.prepend(currentNode.previousSibling.cloneNode(true));
            currentNode = currentNode.previousSibling;
        }
        while (currentNode.parentNode && currentNode.parentNode !== div) {
            currentNode = currentNode.parentNode;
            while (currentNode.previousSibling) {
                tempDiv.prepend(currentNode.previousSibling.cloneNode(true));
                currentNode = currentNode.previousSibling;
            }
        }

        // Count occurrences of the text
        const textUpToNode = extractTextFromHtml(tempDiv.innerHTML);
        let position = 0;
        while ((position = textUpToNode.indexOf(searchText, position)) !== -1) {
            count++;
            position += searchText.length;
        }

        return count + 1;
    }

    /**
     * Recursively processes nodes to extract formatted content.
     */
    function processNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            let format = null;
            switch (node.tagName) {
                case 'STRONG': case 'B': format = 'bold'; break;
                case 'EM': case 'I': format = 'italic'; break;
                case 'U': format = "underline"; break;
                case 'H1': format = "heading1"; break;
                case 'H2': format = "heading2"; break;
                case 'H3': format = "heading3"; break;
                case 'H4': case 'H5': case 'H6': format = "bold"; break;
            }

            if (format) {
                const text = node.textContent;
                formattedPortions.push({
                    index: index++,
                    text: text,
                    format: format,
                    wordPosition: countOccurrencesUpTo(text, node)
                });
            }
        }

        // Process child nodes
        Array.from(node.childNodes).forEach(child => processNode(child));
    }

    processNode(div);

    return { html, plainText, formattedPortions };
}

function getMaxWidth() {
    const computedStyle = window.getComputedStyle(document_contents);
    return parseFloat(computedStyle.width) -
        parseFloat(computedStyle.paddingLeft) -
        parseFloat(computedStyle.paddingRight) -
        parseFloat(computedStyle.borderLeftWidth) -
        parseFloat(computedStyle.borderRightWidth);
}

function setHighlights(textStructure, container, highlights, direction) {

    const maxWidth = getMaxWidth();
    const font = Font.create(container);

    displayTextWithHighlights(container, textStructure, font, maxWidth, highlights, direction);
}

function displayTextWithHighlights(container, textStructure,  font, maxWidth, highlights, direction) {

    const startTime = performance.now();
    log('start displayTextWithHighlights');

    container.innerHTML = '';

    const utf8IndexMap = createUTF8IndexMap(textStructure.plainText);

    const lineWidthManager = new LineWidthManager(maxWidth, 50);
    const splitter = new FullTextLineSplitter(lineWidthManager, font);

    const splitStartTime = performance.now();
    const lines = splitter.split(textStructure.plainText);

    log('line total : ' + lines.length);
    console.log(lines);

    const splitEndTime = performance.now();
    log(`split time : ${((splitEndTime - splitStartTime) / 1000).toFixed(3)} secondes`);

    const highlightStartTime = performance.now();
    lines.forEach(line => {
        applyHighlightsToLine(line, textStructure, highlights, container, utf8IndexMap, direction);
    });
    const highlightEndTime = performance.now();
    log(`applyHighlights time : ${((highlightEndTime - highlightStartTime) / 1000).toFixed(3)} secondes`);

    const endTime = performance.now();
    log(`total displayTextWithHighlights time: ${((endTime - startTime) / 1000).toFixed(3)} secondes`);
}

// ******* Handle SVG Line Render ************* //

function applyHighlightsToLine(line, textStructure, highlights, container, utf8IndexMap, direction) {
    // Switch to using <defs> for line underline in Firefox to prevent interference with text selection.
    applyHighlights(line, textStructure, highlights, container, utf8IndexMap, direction, isFirefox());
}

function applyHighlights(line, textStructure, highlights, container, utf8IndexMap, direction, useDefs = false) {
    const svgNamespace = "http://www.w3.org/2000/svg";

    // Create global defs if needed
    if (useDefs && !globalDefs) {
        globalDefs = document.createElementNS(svgNamespace, "defs");
        container.parentElement.appendChild(globalDefs);
    }

    document_lines.push(line);

    const lineContent = getUTF8Substring(textStructure.plainText, line.startOffset, line.endOffset, utf8IndexMap);

    if (lineContent === '\n') {
        const textElement = document.createElementNS(svgNamespace, "text");
        textElement.textContent = lineContent;
        container.appendChild(textElement);
        return;
    }

    // Line row container
    const divContainer = document.createElement('div');
    divContainer.setAttribute('data-line--id', `line-${line.startOffset}-${line.endOffset}`);

    const svg = document.createElementNS(svgNamespace, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "40px");

    const textGroup = document.createElementNS(svgNamespace, "g");
    textGroup.setAttribute("data-line--id", `line-group-${line.startOffset}-${line.endOffset}`);
    textGroup.setAttribute("transform", "translate(0, 20)");

    const textElement = document.createElementNS(svgNamespace, "text");
    setTextAttributes(textElement, lineContent, direction);
    formatText(textElement, textStructure, line, utf8IndexMap);

    textGroup.appendChild(textElement);
    svg.appendChild(textGroup);
    divContainer.appendChild(svg);
    container.appendChild(divContainer);

    // Create highlight group based on `useDefs`
    const highlightsGroup = useDefs ? createDefsHighlightGroup(line, svgNamespace, svg): null;

    // Process highlights
    let highlightCount = 0;
    highlights.forEach((highlight) => {
        if (highlight.end_offset > line.startOffset && highlight.start_offset < line.endOffset) {
            const range = createRanges(textElement, highlight, line);
            range.items.forEach((rect) => {
                rect.y = useDefs ? calculateYPositionWithDefs(highlightCount) : calculateYPosition(highlightCount);
                const lineElement = createSvgUnderline(textGroup, rect, highlight, useDefs);
                if(!useDefs) {
                    textGroup.appendChild(lineElement);
                } else {
                    highlightsGroup.appendChild(lineElement);
                }
                highlightCount++;
            });
        }
    });

    adjustLineHeight(divContainer, textGroup, highlightCount);
}

function setTextAttributes(textElement, lineContent, direction) {
    const textXPosition = direction === 'RIGHT_TO_LEFT' ? "100%" : "0";
    const textAnchor = direction === 'RIGHT_TO_LEFT' ? "end" : "start";

    textElement.setAttribute("x", textXPosition);
    textElement.setAttribute("y", "0");
    textElement.setAttribute("text-anchor", textAnchor);
}

function formatText(textElement, formattedContent, line, utf8IndexMap) {
    const svgNamespace = "http://www.w3.org/2000/svg";

    // Extract line content from the plain text using UTF-8 offsets
    const lineContent = getUTF8Substring(
        formattedContent.plainText,
        line.startOffset,
        line.endOffset,
        utf8IndexMap
    );

    let remainingPortions = formattedContent.formattedPortions;

    // Return early if no formatted text exists in this line
    if (!remainingPortions.some(portion => lineContent.includes(portion.text))) {
        textElement.textContent = lineContent;
        return;
    }

    let remainingText = lineContent;

    // Iterate over the remaining line text to find and format portions
    while (remainingText.length > 0) {
        // Find the next formatted portion in the remaining text
        const portionIndex = remainingPortions.findIndex(portion =>
            remainingText.includes(portion.text)
        );

        if (portionIndex === -1) {
            // No more formatted portions, add the remaining raw text
            if (remainingText) {
                const tspan = document.createElementNS(svgNamespace, "tspan");
                tspan.textContent = remainingText;
                textElement.appendChild(tspan);
            }
            break;
        }

        const nextFormattedPortion = remainingPortions[portionIndex];
        const textIndex = remainingText.indexOf(nextFormattedPortion.text);
        const word = nextFormattedPortion.text;

        // Initialize word tracker for this word if not already set
        if (!wordTracker[word]) {
            wordTracker[word] = 0;
        }

        // Increment the tracker even if the word isn't formatted yet
        wordTracker[word]++;

        // Add raw text before the formatted portion
        if (textIndex > 0) {
            const tspan = document.createElementNS(svgNamespace, "tspan");
            tspan.textContent = remainingText.substring(0, textIndex);
            textElement.appendChild(tspan);
        }

        // Format the portion only if the occurrence matches the word position
        if (wordTracker[word] === nextFormattedPortion.wordPosition) {
            const formattedTspan = document.createElementNS(svgNamespace, "tspan");
            applyFormatAttributes(formattedTspan, nextFormattedPortion.format);

            formattedTspan.textContent = nextFormattedPortion.text;
            textElement.appendChild(formattedTspan);

            // Remove the processed portion from the list
            remainingPortions.splice(portionIndex, 1);
        } else {
            // Add as raw text if the occurrence doesn't match
            const tspan = document.createElementNS(svgNamespace, "tspan");
            tspan.textContent = nextFormattedPortion.text;
            textElement.appendChild(tspan);
        }

        // Update the remaining text to process
        remainingText = remainingText.substring(textIndex + nextFormattedPortion.text.length);
    }
}

function applyFormatAttributes(tspan, format) {
    switch (format) {
        case "bold":
            tspan.setAttribute("font-weight", "bold");
            break;
        case "italic":
            tspan.setAttribute("font-style", "italic");
            break;
        case "heading1":
            tspan.setAttribute("font-weight", "bold");
            tspan.setAttribute("font-size", "150%");
            break;
        case "heading2":
            tspan.setAttribute("font-weight", "bold");
            tspan.setAttribute("font-size", "130%");
            break;
        case "heading3":
            tspan.setAttribute("font-weight", "bold");
            tspan.setAttribute("font-size", "120%");
            break;
        case "underline":
            tspan.setAttribute("text-decoration", "underline");
            break;
        case "strikethrough":
            tspan.setAttribute("text-decoration", "line-through");
            break;
    }
}

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

function createSvgUnderline(textParent, rect, highlight, useDefs = false) {
    const svgNamespace = "http://www.w3.org/2000/svg";

    const tags = highlight.tags.map(id => findTag(id));
    const colors = tags.map(tag => tag.color);

    if (colors.length === 1) {
        return createSvgLine(textParent, svgNamespace,
            highlight, rect, colors[0],
            'solid',
            useDefs, tags);
    }

    // Gradient
    const gradient = createSvgGradient(svgNamespace, highlight, colors);
    textParent.appendChild(gradient);

    return createSvgLine(
        textParent,
        svgNamespace,
        highlight,
        rect,
        `url(#gradient-${highlight.id})`,
        'gradient',
        useDefs,
        tags
    );
}

function createSvgLine(svgParent, svgNamespace, highlight, rect,
                       color,
                       strokeType = 'solid',
                       useDefs = false,
                       tags) {
    const line = document.createElementNS(svgNamespace, "line");

    const textElement = svgParent.querySelector('text');
    const textBox = textElement.getBBox();

    const x1 = textBox.x + (rect.x1 === 0 ? 2 : rect.x1);
    const x2 = textBox.x + rect.x2;

    // Set basic attributes
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
        line.setAttribute("onmouseover", `
            this.style.strokeWidth='7';
            showLineTooltip(event, ${JSON.stringify(tags)});
        `);
        line.setAttribute("onmouseout", `
            this.style.strokeWidth='${DEFAULT_STROKE_WIDTH}';
            hideLineTooltip();
        `);
    } else {
        line.classList.add("smooth-stroke");
        line.addEventListener("mouseover", (event) => {
            line.setAttribute("stroke-width", "7");
            showLineTooltip(event, tags);
        });
        line.addEventListener("mouseout", () => {
            line.setAttribute("stroke-width", DEFAULT_STROKE_WIDTH);
            hideLineTooltip();
        });
        line.addEventListener("click", () => editHighlight.call(line, highlight.id));
    }

    return line;
}

function showLineTooltip(event, tags) {
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

    tooltip.style.display = 'block';
    tooltip.style.left = (event.clientX + 10) + 'px';
    tooltip.style.top = (event.clientY + 10) + 'px';
}

function hideLineTooltip() {
    const tooltip = document.getElementById('highlight-tooltip');
    if (tooltip) {
        tooltip.style.display = 'none';
    }
}

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

// ******* Handle Highlight add ************* //
function addHighlight(highlight) {
    const id = '' + highlight.id;
    highlights[id] = highlight;

    document_lines.forEach(line => {
        if (highlight.end_offset > line.startOffset && highlight.start_offset < line.endOffset) {
            const divContainer = document.querySelector(`[data-line--id="line-${line.startOffset}-${line.endOffset}"]`);
            if (!divContainer) {
                return;
            }
            const useDefs = isFirefox();
            if (useDefs) {
                addHighlightWithDefs(line, highlight, divContainer);
            } else {
                addHighlightWithoutDefs(line, highlight, divContainer);
            }
        }
    });
}

function addHighlightWithDefs(line, highlight, divContainer) {
    const highlightsGroup = document.querySelector(`g[id="highlights-${line.startOffset}-${line.endOffset}"]`);
    if (!highlightsGroup) return;

    const existingLine = highlightsGroup.querySelector(`line[data-highlight-id="${highlight.id}"]`);
    if (existingLine) {
        removeHighlightWithDefs(line, highlight, divContainer);
    }

    const existingHighlightsCount = highlightsGroup.querySelectorAll('line').length;

    const textGroup = divContainer.querySelector(`g[data-line--id="line-group-${line.startOffset}-${line.endOffset}"]`);
    const range = createRanges(textGroup.querySelector('text'), highlight, line);

    range.items.forEach((rect, index) => {
        rect.y = calculateYPositionWithDefs(existingHighlightsCount);
        const lineElement = createSvgUnderline(textGroup, rect, highlight, true);
        highlightsGroup.appendChild(lineElement);
    });

    adjustLineHeight(divContainer, textGroup, existingHighlightsCount + 1);
}

function addHighlightWithoutDefs(line, highlight, divContainer) {
    const textGroup = divContainer.querySelector(`g[data-line--id="line-group-${line.startOffset}-${line.endOffset}"]`);
    if (!textGroup) return;

    const existingLine = textGroup.querySelector(`line[data-highlight-id="${highlight.id}"]`);
    if (existingLine) {
        removeHighlightWithoutDefs(line, highlight, divContainer);
    }

    const existingHighlightsCount = textGroup.querySelectorAll('line').length;

    const range = createRanges(textGroup.querySelector('text'), highlight, line);

    range.items.forEach((rect, index) => {
        rect.y = calculateYPosition(existingHighlightsCount);
        const lineElement = createSvgUnderline(textGroup, rect, highlight);
        textGroup.appendChild(lineElement);
    });

    adjustLineHeight(divContainer, textGroup, existingHighlightsCount + 1);
}

// ******* Handle Highlight remove ************* //
function removeHighlight(id, line = null) {
    id = '' + id;
    if (!highlights[id]) {
        return;
    }
    const highlight = highlights[id];

    const linesToCheck = line ? [line] : document_lines;

    linesToCheck.forEach(line => {
        if (highlight.end_offset > line.startOffset && highlight.start_offset < line.endOffset) {
            const divContainer = document.querySelector(`[data-line--id="line-${line.startOffset}-${line.endOffset}"]`);
            if (!divContainer) {
                return;
            }
            const useDefs = isFirefox();
            if (useDefs) {
                removeHighlightWithDefs(line, highlight, divContainer);
            } else {
                removeHighlightWithoutDefs(line, highlight, divContainer);
            }
        }
    });
}

function removeHighlightWithoutDefs(line, highlight, divContainer) {
    const textGroup = divContainer.querySelector(`g[data-line--id="line-group-${line.startOffset}-${line.endOffset}"]`);
    if (!textGroup) return;

    const highlightsToRemove = textGroup.querySelectorAll(`[data-highlight-id="${highlight.id}"]`);
    highlightsToRemove.forEach(hl => hl.remove());

    const gradientElement = document.querySelector(`#gradient-${highlight.id}`);
    if (gradientElement) gradientElement.remove();

    const remainingHighlights = textGroup.querySelectorAll('line[data-highlight-id]');
    updateHighlightPositions(textGroup, divContainer, remainingHighlights);
}

function removeHighlightWithDefs(line, highlight, divContainer) {
    const highlightsGroup = document.querySelector(`g[id="highlights-${line.startOffset}-${line.endOffset}"]`);
    if (!highlightsGroup) return;

    const highlightsToRemove = highlightsGroup.querySelectorAll(`[data-highlight-id="${highlight.id}"]`);
    highlightsToRemove.forEach(hl => hl.remove());

    const gradientElement = document.querySelector(`#gradient-${highlight.id}`);
    if (gradientElement) gradientElement.remove();

    const remainingHighlights = highlightsGroup.querySelectorAll('line[data-highlight-id]');
    updateHighlightPositions(highlightsGroup, divContainer, remainingHighlights, true);
}

function updateHighlightPositions(group, divContainer, highlights, useDefs = false) {
    highlights.forEach((hl, index) => {
        const newY = useDefs ? calculateYPositionWithDefs(index) : calculateYPosition(index);
        const isGradient = hl.getAttribute('stroke').startsWith('url(#gradient-');
        const newY2 = isGradient ? newY + 0.1 : newY;

        hl.setAttribute('y1', '' + newY);
        hl.setAttribute('y2', '' + newY2);
    });

    const lineCount = highlights.length;
    adjustLineHeight(divContainer, group, lineCount);
}

// Utils
function createUTF8IndexMap(text) {
    const map = [0];
    let utf8Length = 0;
    for (let i = 0; i < text.length; i++) {
        utf8Length += lengthUTF8(text[i]);
        map.push(utf8Length);
    }
    return map;
}

function getUTF8Substring(text, startUTF8, endUTF8, utf8IndexMap) {
    let startIndex = utf8IndexMap.findIndex(offset => offset > startUTF8) - 1;
    let endIndex = utf8IndexMap.findIndex(offset => offset >= endUTF8);
    return text.slice(startIndex, endIndex);
}

function getCharIndexFromUTF8Index(str, utf8Index) {
    let charIndex = 0;
    let currentUTF8Index = 0;

    while (currentUTF8Index < utf8Index && charIndex < str.length) {
        const char = str.charAt(charIndex);
        const charUTF8Length = lengthUTF8(char);
        currentUTF8Index += charUTF8Length;
        charIndex++;
    }

    return charIndex;
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

// Save highlight drag drop
function saveHighlightDragDrop(tagId) {

    const selection = current_selection;

    const hl_tags = [tagId];

    const highlight = {
        selection,
        tags: hl_tags
    }

    const callbackSuccess = () => {
        log("Highlight posted");
    };
    const callbackFail = (error) => {
        log("Failed to create highlight", 'error', {error})
        showAlert(`${gettext("Couldn't create highlight!")} \n\n`,'error');
    };

    //call submit
    submitHighLightCreation(highlight, callbackSuccess, callbackFail);

}

function submitHighLightCreation(highlight, callbackSuccess, callbackFail) {

    let request;
    const { id, selection, tags} = highlight;
    let requestData = {
        start_offset: selection[0],
        end_offset: selection[1],
        tags: tags,
    };

    if (highlight.id) {
        log(`Posting update for highlight ${id}`);
        request = postJSON(
            `/api/project/${project_id}/document/${current_document}/highlight/${id}`,
            requestData
        );
    } else {
        log("Posting new highlight");
        request = postJSON(
            `/api/project/${project_id}/document/${current_document}/highlight/new`,
            requestData
        );
    }
    showSpinner();
    request.then(function (reply) {
        callbackSuccess(reply);
    }).catch(function (error) {
        callbackFail(error);
    }).finally(hideSpinner);
}