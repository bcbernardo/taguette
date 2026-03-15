// Custom Select Dropdown with Toolbar Actions
// Based on https://blog.logrocket.com/creating-custom-select-dropdown-css/

// DOM Elements
const customSelect = document.querySelector(".custom-select");
const selectBtn = document.querySelector(".select-button");
const selectedValue = document.querySelector(".selected-value");
const toolbarActionButtons = document.querySelector(".toolbar-action-buttons");

// Toggle dropdown on button click
selectBtn.addEventListener("click", () => {
    customSelect.classList.toggle("active");
    selectBtn.setAttribute(
        "aria-expanded",
        selectBtn.getAttribute("aria-expanded") === "true" ? "false" : "true"
    );
});

// Add event listeners to options
function addEventListenerToOption() {
    const optionsList = document.querySelectorAll(".select-dropdown li");

    optionsList.forEach((option) => {
        option.addEventListener("keyup", createHandler(option));
        option.addEventListener("click", createHandler(option));
    });
}

// Create event handler
function createHandler(option) {
    return function(e) {
        // Handle click events
        if (e.type === "click" && e.clientX !== 0 && e.clientY !== 0) {
            const text = this.children[1].textContent;
            updateSelectedValue(text);

            const input = option.querySelector('input[type="radio"]');
            const docId = input.id.split('-')[1];

            linkDocument(input, docId);
            toggleToolbarActions(true);
            emptyTagSelection(true);
        }

        // Handle keyboard events
        if (e.key === "Enter") {
            const text = this.textContent;
            updateSelectedValue(text);
            customSelect.classList.remove("active");
        }
    };
}

// Update selected value
function updateSelectedValue(text) {
    selectedValue.textContent = text;
    selectedValue.title = text;
    customSelect.classList.toggle('empty', !text);
}

// Toggle toolbar actions
function toggleToolbarActions(show = false) {
    if(show) {
        customSelect.classList.remove("active");
        toolbarActionButtons.style.display = '';

        if(current_document) {
            const doc = documents[current_document];
            updateSelectedValue(doc ? doc.name : '');
        } else {
            updateSelectedValue('');
        }
    } else {
        toolbarActionButtons.style.setProperty('display', 'none', 'important');
        updateSelectedValue('');
    }
}

// Initialize event listeners
addEventListenerToOption();
// Toggle Toolbars actions
toggleToolbarActions(false);