//https://blog.logrocket.com/creating-custom-select-dropdown-css/

const customSelect = document.querySelector(".custom-select");
const selectBtn = document.querySelector(".select-button");

const selectedValue = document.querySelector(".selected-value");
const optionsList = document.querySelectorAll(".select-dropdown li");

const toolbarActionButtons = document.querySelector(".toolbar-action-buttons");
toggleToolbarActions(false);

selectBtn.addEventListener("click", () => {
    // add/remove active class on the container element
    customSelect.classList.toggle("active");
    // update the aria-expanded attribute based on the current state
    selectBtn.setAttribute(
        "aria-expanded",
        selectBtn.getAttribute("aria-expanded") === "true" ? "false" : "true"
    );
});

optionsList.forEach((option) => {
    function handler(e) {
        // Click Events
        if (e.type === "click" && e.clientX !== 0 && e.clientY !== 0) {
            selectedValue.textContent = this.children[1].textContent;
            const input = option.querySelector('input[type="radio"]');
            const fullId = input.id;
            const docId = fullId.split('-')[1];
            linkDocument(input,docId);
            toggleToolbarActions(true);
            emptyTagSelection(true);
        }
        // Key Events
        if (e.key === "Enter") {
            selectedValue.textContent = this.textContent;
            customSelect.classList.remove("active");
        }
    }

    option.addEventListener("keyup", handler);
    option.addEventListener("click", handler);
});

function toggleToolbarActions(show = false) {
    if(show) {
        customSelect.classList.remove("active");
        toolbarActionButtons.style.display = '';
        if(current_document) {
            const doc = documents[current_document];
            selectedValue.textContent = doc.name;
        }
    } else {
        toolbarActionButtons.style.setProperty('display', 'none', 'important');
        selectedValue.textContent = '';
    }
}
