// V1 Highlight System - Main Entry Point
// Converts HTML to plain text and renders highlights with embedded SVG

let document_lines = [];
let wordTracker = {};


function createRanges(element, highlight, line) {
    const ranges = new Ranges(false);
    const hasTspans = element.getElementsByTagName('tspan').length > 0;
    if (hasTspans) {
        const tempContainer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const tempText = document.createElementNS("http://www.w3.org/2000/svg", "text");

        tempText.setAttribute("x", element.getAttribute("x"));
        tempText.setAttribute("y", element.getAttribute("y"));
        tempText.setAttribute("text-anchor", element.getAttribute("text-anchor"));
        const tspans = Array.from(element.getElementsByTagName('tspan'));
        const validTspan = tspans.find(tspan => tspan.textContent.trim() !== "") || tspans[0];
        const tempTspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
        Array.from(validTspan.attributes).forEach(attr => {
            tempTspan.setAttribute(attr.name, attr.value);
        });

        const fullText = tspans.map(tspan => tspan.textContent).join('');
        tempTspan.textContent = fullText;

        tempText.appendChild(tempTspan);
        tempContainer.appendChild(tempText);
        document.body.appendChild(tempContainer);
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
                const adjustedLeft = rect.left - elementRect.left;
                const adjustedRight = rect.right - elementRect.left;
                ranges.add(adjustedLeft, adjustedRight);
            }
        }
        document.body.removeChild(tempContainer);
    } else {
        const node = element.firstChild;
        const lineText = element.textContent;
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
                const adjustedLeft = rect.left - elementRect.left;
                const adjustedRight = rect.right - elementRect.left;
                ranges.add(adjustedLeft, adjustedRight);
            }
        }
    }

    return ranges;
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

    container.innerHTML = '';

    // Build UTF-8 byte offset to char index map for accurate positioning
    const utf8IndexMap = createUTF8IndexMap(textStructure.plainText);

    const lineWidthManager = new LineWidthManager(maxWidth, 50);
    const splitter = new FullTextLineSplitter(lineWidthManager, font);

    // Split text into lines based on max width (canvas measurement)
    const splitStartTime = performance.now();
    const lines = splitter.split(textStructure.plainText);

    const splitEndTime = performance.now();
    log(`split time : ${((splitEndTime - splitStartTime) / 1000).toFixed(3)} secondes`);

    // Apply highlights to each line with SVG rendering
    const highlightStartTime = performance.now();
    lines.forEach(line => {
        applyHighlightsToLine(line, textStructure, highlights, container, utf8IndexMap, direction);
    });
    const highlightEndTime = performance.now();
    log(`applyHighlights time : ${((highlightEndTime - highlightStartTime) / 1000).toFixed(3)} seconds`);

    const endTime = performance.now();
    log(`total displayTextWithHighlights time: ${((endTime - startTime) / 1000).toFixed(3)} seconds`);
}

function applyHighlightsToLine(line, textStructure, highlights, container, utf8IndexMap, direction) {
    // Use <defs> for Firefox to prevent interference with text selection
    applyHighlights(line, textStructure, highlights, container, utf8IndexMap, direction, isFirefox());
}

function applyHighlights(line, textStructure, highlights, container, utf8IndexMap, direction, useDefs = false) {
    const svgNamespace = "http://www.w3.org/2000/svg";
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
    const highlightsGroup = useDefs ? createDefsHighlightGroup(line, svgNamespace, svg): null;
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
    const lineContent = getUTF8Substring(
        formattedContent.plainText,
        line.startOffset,
        line.endOffset,
        utf8IndexMap
    );

    let remainingPortions = formattedContent.formattedPortions;
    if (!remainingPortions.some(portion => lineContent.includes(portion.text))) {
        textElement.textContent = lineContent;
        return;
    }

    let remainingText = lineContent;
    while (remainingText.length > 0) {
        const portionIndex = remainingPortions.findIndex(portion =>
            remainingText.includes(portion.text)
        );

        if (portionIndex === -1) {
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
        if (!wordTracker[word]) {
            wordTracker[word] = 0;
        }
        wordTracker[word]++;
        if (textIndex > 0) {
            const tspan = document.createElementNS(svgNamespace, "tspan");
            tspan.textContent = remainingText.substring(0, textIndex);
            textElement.appendChild(tspan);
        }
        if (wordTracker[word] === nextFormattedPortion.wordPosition) {
            const formattedTspan = document.createElementNS(svgNamespace, "tspan");
            applyFormatAttributes(formattedTspan, nextFormattedPortion.format);

            formattedTspan.textContent = nextFormattedPortion.text;
            textElement.appendChild(formattedTspan);
            remainingPortions.splice(portionIndex, 1);
        } else {
            const tspan = document.createElementNS(svgNamespace, "tspan");
            tspan.textContent = nextFormattedPortion.text;
            textElement.appendChild(tspan);
        }
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