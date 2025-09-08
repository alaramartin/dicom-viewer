// script to handle the UI of when the image is compressed (and therefore no edits can be made)
const vscode = acquireVsCodeApi();

document.addEventListener("DOMContentLoaded", function() {
    // remove contenteditable from all editable cells
    document.querySelectorAll(".editable-cell").forEach(cell => {
        cell.removeAttribute("contenteditable");
        cell.classList.add("not-editable");
    });
    document.addEventListener("click", function(e) {
        if (e.target.classList.contains("not-editable")) {
            // keep track of the cell being edited and its original value
            vscode.postMessage({
                command: "prevent-edit"
            });
        }
    });
});