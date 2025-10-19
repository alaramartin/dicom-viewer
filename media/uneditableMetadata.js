// script to handle the UI of when the image is compressed (and therefore no edits can be made)
const vscode = acquireVsCodeApi();

document.addEventListener("DOMContentLoaded", function() {
    // remove contenteditable from all editable cells
    document.querySelectorAll(".editable-cell").forEach(cell => {
        cell.removeAttribute("contenteditable");
        cell.classList.add("not-editable");
    });

    // all sequence elemenst should be initialized collapsed
    document.querySelectorAll(".sequence-header").forEach(header => {
        header.classList.add("sequence-collapsed");
        const toggle = header.querySelector(".sequence-toggle");
        if (toggle) {
            toggle.textContent = "▶";
        }
    });

    document.addEventListener("click", function(e) {
        if (e.target.classList.contains("not-editable")) {
            // keep track of the cell being edited and its original value
            vscode.postMessage({
                command: "prevent-edit"
            });
        }

        if (e.target.classList.contains("sequence-toggle")) {
            const sequenceTag = e.target.dataset.target;
            const sequenceRow = e.target.closest("tr");
            const childRows = document.querySelectorAll(`tr[data-parent="${sequenceTag}"]`);

            const isExpanded = sequenceRow.classList.contains("sequence-expanded");
            if (isExpanded) {
                // collapse the sequence
                childRows.forEach(row => {
                    row.classList.add("hidden");
                    row.classList.remove("visible");
                });
                sequenceRow.classList.remove("sequence-expanded");
                sequenceRow.classList.add("sequence-collapsed");
                e.target.textContent = "▶";
            } else {
                // expand
                childRows.forEach(row => {
                    row.classList.remove("hidden");
                    row.classList.add("visible");
                });
                sequenceRow.classList.remove("sequence-collapsed");
                sequenceRow.classList.add("sequence-expanded");
                e.target.textContent = "▼";
            }
        }
    });
});