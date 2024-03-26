//https://blog.logrocket.com/creating-custom-select-dropdown-css/

const customSelect = document.querySelector(".custom-select");
const selectBtn = document.querySelector(".select-button");

const selectedValue = document.querySelector(".selected-value");
const optionsList = document.querySelectorAll(".select-dropdown li");

// add click event to select button
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
            const inputRadio = option.querySelector('input[type="radio"]');
            const fullId = inputRadio.id;
            const docId = fullId.split('-')[1];
            linkDocument(inputRadio,docId);
            customSelect.classList.remove("active");
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
