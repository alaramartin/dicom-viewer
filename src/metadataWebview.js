// script to handle the UI of editing dicom metadata
// get vscode api
const vscode = acquireVsCodeApi();
let currentEditingCell = null;
// only non-binary data is editable
let editable = true;
let ogValue = '';
let buttonRow = null;

// track pending edits/removals
let pendingEdits = {};
let pendingRemovals = new Set();
let hasChanges = false;

function showDicomActions(show) {
    const actions = document.getElementById('dicom-actions');
    actions.style.display = show ? 'flex' : 'none';
}

function markChanged() {
    hasChanges = true;
    showDicomActions(true);
}
// fixme: make the dicomactoins row look nicer/be nicer location
document.addEventListener("DOMContentLoaded", function() {
    /* listen to when editable-cell is in focus. when in focus, create the extra row below it with the buttons
            save edits (blue), cancel edits (grey), and remove row (red)
            (when out of focus, remove this row)
    */

    // note: an empty cell displays as [Empty] in the UI. when focusin, change the contents to just empty if it is [Empty]. if user clears it then saves, display [Empty] but change dicom data to empty
    // when editable cell is in focus
    document.addEventListener("focusin", function(e) {
        if (e.target.classList.contains("editable-cell")) {
            // keep track of the cell being edited and its original value
            currentEditingCell = e.target;
            ogValue = e.target.textContent;
            // make an empty cell be empty when editing it
            if (ogValue === "[Empty]") {
                e.target.textContent = "";
            }
            else if (ogValue === "[Binary Data]") {
                editable = false;
            }
            // create the row that allows user to save/cancel/remove row
            editable = createButtonsRow(e.target) && editable;
        }
    });

    // when cell goes out of focus, remove the editing buttons row
    document.addEventListener("focusout", function(e) {
        setTimeout(() => {
            if (!document.activeElement || !document.activeElement.classList.contains('action-button')) {
                if (currentEditingCell?.textContent === "") {
                    // display empty cell as "[Empty]"
                    currentEditingCell.textContent = "[Empty]";
                }
                currentEditingCell = null;
                editable = true;
                removeButtonsRow();
            }
        }, 100);
    });

    // add listener for keys pressed
    document.addEventListener("keydown", function(e) {
        // escape button removes focus from that cell
        if (e.key === "Escape" && currentEditingCell) {
            currentEditingCell.textContent = ogValue;
            currentEditingCell.blur();
            currentEditingCell = null;
            removeButtonsRow();
        }
        // enter button has the same functionality as clicking save
        if (e.key === "Enter" && currentEditingCell) {
            const newValue = currentEditingCell.textContent;
            // check if the value changed at all
            if (newValue !== ogValue && editable) {
                // get the dicom tag of the currenteditingcell (first column)
                const row = currentEditingCell.closest('tr');
                const hexTag = row.cells[0].textContent.trim();
                const VR = row.cells[2].textContent.trim();
                // store edit, don't send to extension yet
                pendingEdits[hexTag] = { vr: VR, value: newValue };
                markChanged();
            }
            else if (!editable) {
                currentEditingCell.textContent = ogValue;
                console.log("cannot edit binary data");
            }
            // remove focus from the cell and remove buttons row
            currentEditingCell.blur();
            currentEditingCell = null;
            removeButtonsRow();
        }
    });

    // listen to button presses (save/cancel/remove row, save dicoms)
    document.addEventListener("click", function(e) {
        if (e.target.classList.contains("save-edits")) {
            const newValue = currentEditingCell.textContent;
            if (newValue !== ogValue && editable) {
                const row = currentEditingCell.closest('tr');
                const hexTag = row.cells[0].textContent.trim();
                const VR = row.cells[2].textContent.trim();
                pendingEdits[hexTag] = { vr: VR, value: newValue };
                markChanged();
            }
            // fixme: distinguish between editable and removable
            else if (!editable) {
                currentEditingCell.textContent = ogValue;
                console.log("cannot edit");
                // remove focus from the cell and remove buttons row
                removeButtonsRow();
            }
            // remove focus from the cell and remove buttons row
            currentEditingCell.blur();
            currentEditingCell = null;
            removeButtonsRow();
        }
        // check for "remove row" button
        else if (e.target.classList.contains("remove-row")) {
            if (editable) {
                const row = currentEditingCell.closest('tr');
                const hexTag = row.cells[0].textContent.trim();
                pendingRemovals.add(hexTag);
                markChanged();
                row.remove();
            }
            else {
                currentEditingCell.textContent = ogValue;
                console.log("cannot remove");
            }
            // remove focus from the cell and remove buttons row
            currentEditingCell.blur();
            currentEditingCell = null;
            removeButtonsRow();
        }
        // check for cancel button which just cancels the change
        else if (e.target.classList.contains("cancel")) {
            currentEditingCell.textContent = ogValue;
            currentEditingCell.blur();
            currentEditingCell = null;
            removeButtonsRow();
        }
        // DICOM action buttons (save/replace/cancel)
        else if (e.target.classList.contains("dicom-action-btn")) {
            if (e.target.classList.contains("save")) {
                vscode.postMessage({
                    command: "saveAll",
                    mode: "new",
                    edits: pendingEdits,
                    removals: Array.from(pendingRemovals)
                });
                resetChanges();
            }
            else if (e.target.classList.contains("replace")) {
                vscode.postMessage({
                    command: "saveAll",
                    mode: "replace",
                    edits: pendingEdits,
                    removals: Array.from(pendingRemovals)
                });
                resetChanges();
            }
            else if (e.target.classList.contains("discard")) {
                // tell the extension to reload the metadata panel with original content
                vscode.postMessage({
                    command: "reload"
                });
                resetChanges();
            }
        }
    });

    // add a listener to remove the currenteditingrow if dicom editing was successful
    window.addEventListener("message", function(e) {
        const message = e.data;
        if (message.removed === "removed") {
            const rows = document.querySelectorAll('tbody tr');
            rows.forEach(row => {
                const tagCell = row.cells[0];
                if (tagCell && tagCell.textContent.trim() === message.tag) {
                    row.remove();
                    console.log("row removed for tag:", message.tag);
                }
            });
            // remove the buttons row
            currentEditingCell = null;
            removeButtonsRow();
        }
    });

    // add a row below the editing row that displays 3 button options
    function createButtonsRow(cell) {
        console.log("create");
        // remove button row if already existing
        removeButtonsRow();

        const row = cell.closest('tr');
        const hexTag = row.cells[0].textContent.trim();
        const newRow = document.createElement('tr');
        newRow.className = 'button-row';

        const buttonCell = document.createElement('td');
        buttonCell.colSpan = 4;
        buttonCell.style.textAlign = 'center';
        buttonCell.style.padding = '5px';

        // check if tag is required for dicom validity
        const tagRequired = isTagRequired(hexTag);

        let removeButtonHTML;
        let saveButtonHTML;
        let editable = true;
        if (tagRequired === "require") {
            saveButtonHTML = '<button class="action-button save-edits" style="background: #007ACC; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Save</button>';
            // add tooltip (popup that shows up when hovering) for removal of tags that are required
            removeButtonHTML = 
                '<div class="tooltip">' +
                    '<button class="action-button remove-row" style="background: #E74C3C; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Remove Row</button>' +
                    '<span class="tooltiptext">Warning: Deleting this tag will invalidate the DICOM</span>' +
                '</div>';
        }
        // block removal of anything used in getimage()
        else if (tagRequired === "image") {
            saveButtonHTML =
                '<div class="tooltip">' +
                    '<button class="action-button save-edits" style="background: #a2aec1ff; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; pointer-events: none;">Save</button>' +
                    '<span class="tooltiptext">Image data cannot be edited.</span>' +
                '</div>';
            removeButtonHTML = 
                '<div class="tooltip">' +
                    '<button class="action-button remove-row" style="background: #c1a3a2ff; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; pointer-events: none;">Remove Row</button>' +
                    '<span class="tooltiptext">Image data cannot be removed.</span>' +
                '</div>';
            editable = false;
        } else {
            // regular remove and save button for non-required tags
            saveButtonHTML = '<button class="action-button save-edits" style="background: #007ACC; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Save</button>';
            removeButtonHTML = '<button class="action-button remove-row" style="background: #E74C3C; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Remove Row</button>';
        }

        buttonCell.innerHTML = 
            saveButtonHTML +
            '<button class="action-button cancel" style="background: #666; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Cancel</button>' +
            removeButtonHTML;

        newRow.appendChild(buttonCell);
        row.parentNode.insertBefore(newRow, row.nextSibling);
        buttonRow = newRow;
        return editable;
    }						

    function removeButtonsRow() {
        if (buttonRow) {
            buttonRow.remove();
            buttonRow = null;
        }
    }

    // required tags list from https://www.pclviewer.com/help/required_dicom_tags.htm
    // type 1: cannot be removed or empty
    // type 2: cannot be empty
    // type 3: optional
    // fixme: also add checking for when it is edited/saved, type 1 requireds cannot be empty https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_7.4.html
    // 	note: when making edits to the cell, if it is empty, warning popup when hover over save
    function isTagRequired(tag) {
        tag = tag.replace(/^x/, "").toUpperCase();

        // tags required for getImage() to work (CANNOT delete or // fixme: modify)
        const imageRequiredTags = [
            "00280010", // rows
            "00280011", // cols
            "00280100", // bitsallocated
            "00280101", // bitsstored
            "00280103", // pixelrepresentation
            "00280002", // samplesperrepresentation
            "00280004", // photometricinterpretation
            "7FE00010", // pixeldata
        ];
        
        // Critical DICOM tags that should not be removed (Type 1 required tags)
        const requiredTags = [
            "00080016", // SOPClassUID
            "00080018", // SOPInstanceUID  
            "00100010", // PatientName
            "00100020", // PatientID
            "00100030", // PatientBirthDate
            "00100040", // PatientSex
            "00200010", // StudyID
            "0020000D", // StudyInstanceUID
            "0020000E", // SeriesInstanceUID
            "00200011", // SeriesNumber
            "00200013", // InstanceNumber
            "00080020", // StudyDate
            "00080030", // StudyTime
            "00080060", // Modality
            "00280102" // HighBit
        ];

        if (imageRequiredTags.includes(tag)) {
            return "image";
        }
        else if (requiredTags.includes(tag)) {
            return "require";
        }
        else {
            return "ok";
        }
    }

    function resetChanges() {
        pendingEdits = {};
        pendingRemovals = new Set();
        hasChanges = false;
        showDicomActions(false);
        console.log("reset changes");
    }
});