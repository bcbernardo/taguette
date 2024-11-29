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
    const node = element.firstChild;

    if (!node) {
        console.error("Invalid text content: no text node found.");
        return ranges;
    }

    const lineContent = node.textContent;
    const start = Math.max(highlight.start_offset, line.startOffset) - line.startOffset;
    const end = Math.min(highlight.end_offset, line.endOffset) - line.startOffset;

    // Convert UTF-8 offsets to character offsets
    const startChar = getCharIndexFromUTF8Index(lineContent, start);
    const endChar = getCharIndexFromUTF8Index(lineContent, end);

    if (startChar === -1 || endChar === -1) {
        console.error("Invalid UTF-8 index.");
        return ranges;
    }

    const range = document.createRange();
    range.setStart(node, startChar);
    range.setEnd(node, endChar);

    const rects = range.getClientRects();

    for (const rect of rects) {
        // Adjust the coordinates based on the parent element's position
        const elementRect = element.getBoundingClientRect();
        const adjustedLeft = rect.left - elementRect.left;
        const adjustedRight = rect.right - elementRect.left;
        ranges.add(adjustedLeft, adjustedRight);
    }

    return ranges;
}

/*
 * Highlights
 */

let document_lines = [];
const DEFAULT_STROKE_WIDTH = "4";


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

function getMaxWidth() {
    const computedStyle = window.getComputedStyle(document_contents);
    return parseFloat(computedStyle.width) -
        parseFloat(computedStyle.paddingLeft) -
        parseFloat(computedStyle.paddingRight) -
        parseFloat(computedStyle.borderLeftWidth) -
        parseFloat(computedStyle.borderRightWidth);
}

function setHighlights(text, container, highlights, direction) {

    const maxWidth = getMaxWidth();
    const font = Font.create(container);

    displayTextWithHighlights(container, text, font, maxWidth, highlights, direction);
}

function displayTextWithHighlights(container, text, font, maxWidth, highlights, direction) {
    const startTime = performance.now();
    log('start displayTextWithHighlights');

    container.innerHTML = '';

    const utf8IndexMap = createUTF8IndexMap(text);

    const lineWidthManager = new LineWidthManager(maxWidth, 50);
    const splitter = new FullTextLineSplitter(lineWidthManager, font);

    const splitStartTime = performance.now();
    const lines = splitter.split(text, container, highlights);

    log('line total : ' + lines.length);

    const splitEndTime = performance.now();
    log(`split time : ${((splitEndTime - splitStartTime) / 1000).toFixed(3)} secondes`);

    const highlightStartTime = performance.now();
    lines.forEach(line => {
        applyHighlightsToLine(line, text, highlights, container, utf8IndexMap, direction);
    });
    const highlightEndTime = performance.now();
    log(`applyHighlights time : ${((highlightEndTime - highlightStartTime) / 1000).toFixed(3)} secondes`);

    const endTime = performance.now();
    log(`total displayTextWithHighlights time: ${((endTime - startTime) / 1000).toFixed(3)} secondes`);
}


// ******* Handle SVG Line Render ************* //

function applyHighlightsToLine(line, text, highlights, container, utf8IndexMap, direction) {
    // Switch to using <defs> for line underline in Firefox to prevent interference with text selection.
    applyHighlights(line, text, highlights, container, utf8IndexMap, direction, isFirefox());
}

function applyHighlights(line, text, highlights, container, utf8IndexMap, direction, useDefs = false) {
    const svgNamespace = "http://www.w3.org/2000/svg";

    // Create global defs if needed
    if (useDefs && !globalDefs) {
        globalDefs = document.createElementNS(svgNamespace, "defs");
        container.parentElement.appendChild(globalDefs);
    }

    document_lines.push(line);

    const lineContent = getUTF8Substring(text, line.startOffset, line.endOffset, utf8IndexMap);
    if (lineContent === '') return;

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
    setupTextAttributes(textElement, lineContent, direction);

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

function setupTextAttributes(textElement, lineContent, direction) {
    const textXPosition = direction === 'RIGHT_TO_LEFT' ? "100%" : "0";
    const textAnchor = direction === 'RIGHT_TO_LEFT' ? "end" : "start";

    textElement.setAttribute("x", textXPosition);
    textElement.setAttribute("y", "0");
    textElement.setAttribute("text-anchor", textAnchor);
    textElement.textContent = lineContent;
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
    const colors = highlight.tags.map(id => findTag(id).color);

    if (colors.length === 1) {
        return createSvgLine(textParent, svgNamespace, highlight, rect, colors[0], 'solid', useDefs);
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
        useDefs
    );
}

function createSvgLine(svgParent, svgNamespace, highlight, rect, color, strokeType = 'solid', useDefs = false) {
    const line = document.createElementNS(svgNamespace, "line");

    const textElement = svgParent.querySelector('text');
    const textBox = textElement.getBBox();

    const x1 = textBox.x + (rect.x1 === 0 ? 4 : rect.x1);
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
        line.setAttribute("onmouseover", "this.style.strokeWidth='7'");
        line.setAttribute("onmouseout", `this.style.strokeWidth='${DEFAULT_STROKE_WIDTH}'`);
    } else {
        line.classList.add("smooth-stroke");
        line.addEventListener("mouseover", () => line.setAttribute("stroke-width", "7"));
        line.addEventListener("mouseout", () => line.setAttribute("stroke-width", DEFAULT_STROKE_WIDTH));
        line.addEventListener("click", () => editHighlight.call(line, highlight.id));
    }

    return line;
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