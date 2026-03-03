/*
 * Utilities
 */

// NEW selector
jQuery.expr[':'].contains_insensitive = function(a, i, m) {
    return jQuery(a).text().toUpperCase()
        .indexOf(m[3].toUpperCase()) >= 0;
};

if (!Object.entries) {
    Object.entries = function (obj) {
        let ownProps = Object.keys(obj),
            i = ownProps.length,
            resArray = new Array(i); // preallocate the Array
        while (i--) {
            resArray[i] = [ownProps[i], obj[ownProps[i]]];
        }

        return resArray;
    };
}

function sortByKey(array, key, reverse) {
    let orderByX = 1;
    if (reverse) {
        orderByX = -1
    }
    array.sort(function (a, b) {
        if (key(a) < key(b)) {
            return -1 * orderByX;
        } else if (key(a) > key(b)) {
            return orderByX;
        } else {
            return 0;
        }
    });
}

function encodeGetParams(params) {
    return Object.entries(params)
        .filter(function (kv) {
            return kv[1] !== undefined;
        })
        .map(function (kv) {
            return kv.map(encodeURIComponent).join("=");
        })
        .join("&");
}

// Don't use RegExp literals https://github.com/python-babel/babel/issues/640
let _escapeA = new RegExp('&', 'g'),
    _escapeL = new RegExp('<', 'g'),
    _escapeG = new RegExp('>', 'g'),
    _escapeQ = new RegExp('"', 'g'),
    _escapeP = new RegExp("'", 'g');

function escapeHtml(s) {
    return s
        .replace(_escapeA, "&amp;")
        .replace(_escapeL, "&lt;")
        .replace(_escapeG, "&gt;")
        .replace(_escapeQ, "&quot;")
        .replace(_escapeP, "&#039;");
}

function nextElement(node) {
    while (node && !node.nextSibling) {
        node = node.parentNode;
    }
    if (!node) {
        return null;
    }
    node = node.nextSibling;
    while (node.firstChild) {
        node = node.firstChild;
    }
    return node;
}

let onlyWhitespace = new RegExp('^[\r\n\t]*$');

function getScrollPos() {
    var doc = document.scrollingElement || document.documentElement, body = document.body;
    var x = (doc && doc.scrollLeft || body && body.scrollLeft || 0) - (doc.clientLeft || 0);
    var y = (doc && doc.scrollTop || body && body.scrollTop || 0) - (doc.clientTop || 0);
    return {x: x, y: y};
}

function getCookie(name) {
    const r = document.cookie.match("\\b" + name + "=([^;]*)\\b");
    return r ? r[1] : undefined;
}

function ApiError(response, message) {
    if (!message) {
        message = "Status " + response.status;
    }
    this.status = response.status;
    this.message = message;
}

ApiError.prototype.toString = function () {
    return this.message;
};

function getJSON(url = '', args) {
    if (args) {
        args = '?' + encodeGetParams(args);
    } else {
        args = '';
    }
    return fetch(
        base_path + url + args,
        {
            credentials: 'same-origin',
            mode: 'same-origin',
            redirect: 'error'
        }
    ).then(function (response) {
        if (response.status !== 200) {
            return response.json()
                .then(
                    function (json) {
                        if ("error" in json) {
                            throw new ApiError(response, json.error);
                        } else {
                            throw new ApiError(response);
                        }
                    },
                    function () {
                        throw new ApiError(response);
                    }
                );
        }
        return response.json().catch(function () {
            throw new ApiError(response, "Invalid JSON");
        });
    });
}

function deleteURL(url = '', args) {
    if (args) {
        args = encodeGetParams(args);
    } else {
        args = '';
    }
    let xsrf = getCookie('_xsrf');
    return fetch(
        base_path + url + '?' + (xsrf !== undefined ? '_xsrf=' + encodeURIComponent(xsrf) + '&' : '') + args,
        {
            credentials: 'same-origin',
            mode: 'same-origin',
            cache: 'no-cache',
            redirect: 'error',
            method: 'DELETE'
        }
    ).then(function (response) {
        if (response.status !== 204) {
            throw new ApiError(response);
        }
    });
}

function postJSON(url = '', data = {}, args) {
    if (args) {
        args = encodeGetParams(args);
    } else {
        args = '';
    }
    let xsrf = getCookie('_xsrf');
    return fetch(
        base_path + url + '?' + (xsrf !== undefined ? '_xsrf=' + encodeURIComponent(xsrf) + '&' : '') + args,
        {
            credentials: 'same-origin',
            mode: 'same-origin',
            cache: 'no-cache',
            redirect: 'error',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify(data)
        }
    ).then(function (response) {
        if (response.status !== 200) {
            return response.json()
                .then(
                    function (json) {
                        if ("error" in json) {
                            throw new ApiError(response, json.error);
                        } else {
                            throw new ApiError(response);
                        }
                    },
                    function () {
                        throw new ApiError(response);
                    }
                );
        }
        return response.json().catch(function () {
            throw new ApiError(response, "Invalid JSON");
        });
    });
}

function patchJSON(url = '', data = {}, args) {
    if (args) {
        args = encodeGetParams(args);
    } else {
        args = '';
    }
    let xsrf = getCookie('_xsrf');
    return fetch(
        base_path + url + '?' + (xsrf !== undefined ? '_xsrf=' + encodeURIComponent(xsrf) + '&' : '') + args,
        {
            credentials: 'same-origin',
            mode: 'same-origin',
            cache: 'no-cache',
            redirect: 'error',
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify(data)
        }
    ).then(function (response) {
        if (response.status !== 204) {
            return response.json()
                .then(
                    function (json) {
                        if ("error" in json) {
                            throw new ApiError(response, json.error);
                        } else {
                            throw new ApiError(response);
                        }
                    },
                    function () {
                        throw new ApiError(response);
                    }
                );
        } else {
            return null;
        }
    });
}

// Returns the byte length of a string encoded in UTF-8
// https://stackoverflow.com/q/5515869/711380
function getCharIndexFromUTF8Index(str, utf8Index) {
    let charIndex = 0;
    let currentUTF8Index = 0;
    while (currentUTF8Index < utf8Index && charIndex < str.length) {
        currentUTF8Index += lengthUTF8(str.charAt(charIndex));
        charIndex++;
    }
    return charIndex;
}

function lengthUTF8(s) {
    if (window.TextEncoder) {
        return (new TextEncoder('utf-8').encode(s)).length;
    } else {
        let l = s.length;
        for (let i = s.length - 1; i >= 0; --i) {
            let code = s.charCodeAt(i);
            if (code > 0x7f && code <= 0x7ff) ++l;
            else if (code > 0x7ff && code <= 0xffff) l += 2;
            if (code >= 0xDC00 && code <= 0xDFFF) i--; // trailing surrogate
        }
        return l;
    }
}

// Escape a string for use in a regexp
// https://stackoverflow.com/a/6969486/711380
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

window.addEventListener('load', function () {
    // https://css-tricks.com/snippets/jquery/draggable-without-jquery-ui/
    (function ($) {
        $.fn.drags = function (opt) {
            opt = $.extend({handle: "", cursor: "move"}, opt);
            let $el;
            let $drag;
            if (opt.handle === "") {
                 $el = this;
            } else {
                 $el = this.find(opt.handle);
            }

            return $el.css('cursor', opt.cursor).on("mousedown", function (e) {
                if (opt.handle === "") {
                    $drag = $(this).addClass('draggable');
                } else {
                    $drag = $(this).addClass('active-handle').parent().addClass('draggable');
                }
                let z_idx = $drag.css('z-index'),
                    drg_h = $drag.outerHeight(),
                    drg_w = $drag.outerWidth(),
                    pos_y = $drag.offset().top + drg_h - e.pageY,
                    pos_x = $drag.offset().left + drg_w - e.pageX;
                $drag.css('z-index', 1000).parents().on("mousemove", function (e) {
                    $('.draggable').offset({
                        top: e.pageY + pos_y - drg_h,
                        left: e.pageX + pos_x - drg_w
                    }).on("mouseup", function () {
                        $(this).removeClass('draggable').css('z-index', z_idx);
                    });
                });
                e.preventDefault(); // disable selection
            }).on("mouseup", function () {
                if (opt.handle === "") {
                    $(this).removeClass('draggable');
                } else {
                    $(this).removeClass('active-handle').parent().removeClass('draggable');
                }
            });
        }
    })(jQuery);
});

function showAlert(message, status) {

    const alertModal = $('#alertModal');

    let modalTitle = '';
    let alertClass = '';
    let modalContent = '';
    let iconClass = '';

    switch (status) {
        case 'info':
            modalTitle = 'Information';
            alertClass = 'alert-info';
            modalContent = 'This is some information content.';
            iconClass = 'fa-info-circle';
            break;
        case 'error':
            modalTitle = 'Erreur';
            alertClass = 'alert-danger';
            modalContent = 'This is some error content.';
            iconClass = 'fa-exclamation-triangle';
            break;
        case 'warning':
            modalTitle = 'Avertissement';
            alertClass = 'alert-warning';
            modalContent = 'This is some warning content.';
            iconClass = 'fa-exclamation-circle';
            break;
        default:
            modalTitle = 'Alerte';
            alertClass = 'alert-primary';
            modalContent = 'This is some default content.';
            iconClass = 'fa-info';
    }

    $('#alertModalLabel').text(modalTitle);

    const alertMessageHtml = `
        <div class="alert ${alertClass}" role="alert">
            <i class="fa ${iconClass}"></i> <strong>${message}</strong>
        </div>
    `;

    $('#alertMessage').html(alertMessageHtml)
    alertModal.modal('show');

    alertModal.on('hidden.bs.modal', function () {
        $('#alertMessage').html('');
    });
}

function showConfirm(message, confirmCallback, show_danger_button=false) {

    $('#confirmMessage').html(message);

    if(show_danger_button) {
        $('#confirmButton').addClass('btn-danger');
        $('#confirmButton').removeClass('btn-primary');
    } else {
        $('#confirmButton').addClass('btn-primary');
        $('#confirmButton').removeClass('btn-danger');
    }

    $('#confirmModal').modal('show');

    $('#confirmButton').off('click').on('click', function () {
        if (typeof confirmCallback === 'function') {
            confirmCallback();
        }

        $('#confirmModal').modal('hide');
    });
}

function log(message, status = 'info', context = {}) {
    const timestamp = new Date().toLocaleString();
    const logMessage = `${timestamp} [${status.toUpperCase()}]: ${message}`;
    if (status.toLowerCase() === 'error') {
       // console.error(logMessage, context);
    } else {
        console.log(logMessage, context);
    }
}

function showSpinner(cancel_action=null, show_progress=false) {
    let $spinner_modal = $('#spinner-modal')
    if (typeof $spinner_modal.modal !== 'undefined') {
        $spinner_modal.modal('show');
        if(cancel_action !== null) {
            $('button.cancel', $spinner_modal).show();
            $('button.cancel', $spinner_modal).bind("click", cancel_action);
        }
        if(show_progress) {
            $("#progress", $spinner_modal).show();
        } else {
            $("#progress", $spinner_modal).hide();
        }
    }
}

function updateProgress(percent) {
    function doUpdateProgress(){
        let $spinner_modal = $('#spinner-modal');
        if (typeof $spinner_modal.modal !== 'undefined') {
            if (isNaN(percent) || (percent < 0)) {
                percent = 0;
            }
            if (percent > 100) {
                percent = 100;
            }
            $("#progress .progress-bar", $spinner_modal).css('width', percent + '%');
            $("#progress .progress-bar", $spinner_modal).css('aria-valuenow', percent);
            log(`Upload progress: ${percent}%`);
        }
    }
    window.requestAnimationFrame(doUpdateProgress);
}

function hideSpinner() {
    let $spinner_modal = $('#spinner-modal');
    $spinner_modal.modal('hide');
    $('button.cancel', $spinner_modal).hide();
    $('button.cancel', $spinner_modal).unbind("click");
}


/*
 * Selection stuff
 */

let chunk_offsets = [];

// Get the document offset from a position
function describePos(node, offset) {
    // Convert current offset from character to bytes
    offset = lengthUTF8(node.textContent.substring(0, offset));
    while (!node.id) {
        if (node.previousSibling) {
            node = node.previousSibling;
            offset += lengthUTF8(node.textContent);
        } else {
            node = node.parentNode;
        }
    }
    if (node.id.substring(0, 11) !== 'doc-offset-') {
        return null;
    }
    return parseInt(node.id.substring(11)) + offset;
}

// Find a position from the document offset
function locatePos(pos) {
    // Find the right chunk
    let chunk_start = 0;
    for (let i = 0; i < chunk_offsets.length; ++i) {
        if (chunk_offsets[i] > pos) {
            break;
        }
        chunk_start = chunk_offsets[i];
    }

    let offset = pos - chunk_start;
    let node = document.getElementById('doc-offset-' + chunk_start);
    while (node.firstChild) {
        node = node.firstChild;
    }
    while (offset > 0) {
        if (lengthUTF8(node.textContent) >= offset) {
            break;
        } else {
            offset -= lengthUTF8(node.textContent);
            node = nextElement(node);
        }
    }
    return [node, offset]
}

let current_selection = null;

function describeSelection() {
    const sel = window.getSelection();
    if (sel.rangeCount === 0 || sel.isCollapsed) return null;

    const range = sel.getRangeAt(0);
    const container = document.getElementById('highlight-content');
    if (!container || !container.contains(range.commonAncestorContainer)) return null;

    const tempRange = document.createRange();
    tempRange.selectNodeContents(container);
    tempRange.setEnd(range.startContainer, range.startOffset);
    const startOffset = lengthUTF8(tempRange.toString());

    tempRange.selectNodeContents(container);
    tempRange.setEnd(range.endContainer, range.endOffset);
    const endOffset = lengthUTF8(tempRange.toString());

    return [startOffset, endOffset];
}

function splitAtPos(pos, after) {
    let node = pos[0], idx = pos[1];
    if (idx === 0) {
        // Leftmost index: return current node
        return node;
    } else if (idx >= lengthUTF8(node.textContent)) {
        // Rightmost index: return next node
        return nextElement(node);
    } else {
        // Find the character index from the byte index
        let idx_char = 0;
        while (idx > 0) {
            let code = node.textContent.charCodeAt(idx_char);
            if (code <= 0x7f) idx -= 1;
            else if (code <= 0x7ff) idx -= 2;
            else if (code <= 0xffff) idx -= 3;
            else idx -= 4;
            idx_char += 1;
        }
        if (idx_char >= node.textContent.length) {
            log("Error computing character position!", 'error');
            idx_char = node.textContent.length - 1;
        }
        // Split, return right node
        return node.splitText(idx_char);
    }
}

// Restore a described selection
function restoreSelection(saved) {
    let sel = window.getSelection();
    sel.removeAllRanges();
    if (saved !== null) {
        let range = document.createRange();
        let start = locatePos(saved[0]);
        let end = locatePos(saved[1]);
        range.setStart(start[0], start[1]);
        range.setEnd(end[0], end[1]);
        sel.addRange(range);
    }
}

function isFirefox() {
    return navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
}

function hasVerticalScrollbar() {
    // Get the total height of the document content
    const documentHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.offsetHeight,
        document.body.clientHeight,
        document.documentElement.clientHeight
    );

    // Get the height of the viewport (visible area)
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    // Compare the document height with the viewport height
    return documentHeight > viewportHeight;
}

/*
 * Apply scroll behavior to all pages
 * Previously page-project only (taguette.js)
 */

window.addEventListener('load', function() {
    let scrollPos = 0;
    window.addEventListener('scroll', function() {
        let isScrollUp = scrollPos > document.documentElement.scrollTop;
        if(document.documentElement.scrollTop < 50 || isScrollUp) {
            document.body.classList.remove('scrolled');
        } else if(hasVerticalScrollbar() && !document.body.classList.contains('scrolled')) {
            document.body.classList.add('scrolled');
        }
        scrollPos = document.documentElement.scrollTop;
    });
});
function initHelpPopover(elementId, sections) {
    const contentParts = sections.map((section, index) => {
        const itemsList = section.items.map(item => `<li>${gettext(item)}</li>`).join('');
        const marginClass = index === sections.length - 1 ? 'mb-0' : 'mb-2';
        return `
            <p class="mb-2"><strong>${gettext(section.title)}</strong></p>
            <ul class="${marginClass} ps-3">
                ${itemsList}
            </ul>
        `;
    }).join('');

    const helpContent = `<div class="text-start">${contentParts}</div>`;

    const popoverElement = document.getElementById(elementId);
    if (popoverElement) {
        new bootstrap.Popover(popoverElement, {
            content: helpContent,
            html: true,
            sanitize: false
        });
    }
}
