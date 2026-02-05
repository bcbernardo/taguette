// Utility classes and functions for highlight system

class Font {
    constructor(fontSize, fontFamily, fontWeight) {
        this.fontSize = fontSize;
        this.fontFamily = fontFamily;
        this.fontWeight = fontWeight;
        this.charWidthCache = {};
    }

    // Canvas-based text width measurement (cached for performance)
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


// Build map: UTF-8 byte offset -> character index (handles emojis)
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
    try {
        const div = document.createElement('div');
        div.innerHTML = html;
        const plainText = extractTextFromHtml(html);

        const formattedPortions = [];
        let index = 1;

    function countOccurrencesUpTo(searchText, node) {
        let count = 0;
        let tempDiv = document.createElement('div');

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

        const textUpToNode = extractTextFromHtml(tempDiv.innerHTML);
        let position = 0;
        while ((position = textUpToNode.indexOf(searchText, position)) !== -1) {
            count++;
            position += searchText.length;
        }

        return count + 1;
    }

    function processNode(node, depth = 0) {
        if (depth > 100) {
            return;
        }
        
        try {
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
                    if (text && text.trim().length > 0) {
                        try {
                            const wordPosition = countOccurrencesUpTo(text, node);
                            formattedPortions.push({
                                index: index++,
                                text: text,
                                format: format,
                                wordPosition: wordPosition
                            });
                        } catch (error) {
                            formattedPortions.push({
                                index: index++,
                                text: text,
                                format: format,
                                wordPosition: 0
                            });
                        }
                    }
                }
            }

            Array.from(node.childNodes).forEach(child => processNode(child, depth + 1));
        } catch (error) {
            log("Error in processNode", 'error', {error, depth});
        }
    }

        processNode(div);

        return { html, plainText, formattedPortions };
    } catch (error) {
        throw error;
    }
}

