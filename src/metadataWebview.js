// script to handle the UI of editing dicom metadata

// get vscode api
const vscode = acquireVsCodeApi();
let currentEditingCell = null;
// only non-binary data is editable
let editable = true;
let edited = false;
let ogValue = '';
let buttonRow = null;

// track pending edits/removals
let pendingEdits = {};
let pendingRemovals = new Set();
let hasChanges = false;
// todo: let stillValid = true;

// once something has been edited, buttons pop up to save or discard changes to the dicom
function showDicomActions(show) {
    const actions = document.getElementById('dicom-actions');
    actions.style.display = show ? 'flex' : 'none';
}

// keep track of any changes made to the dicom
function markChanged(/*fixme: add check for whether or not it potentially invalidates dicom*/) {
    hasChanges = true;
    // todo: stillValid = stillValid && !invalidated;
    showDicomActions(true);
}

function getHexTag(cell) {
    const row = cell.closest('tr');
    return row.cells[0].textContent.trim();
}

function getVR(cell) {
    const row = currentEditingCell.closest('tr');
    return row.cells[2].textContent.trim();
}

// fixme: make the dicomactoins row look nicer/be nicer location
document.addEventListener("DOMContentLoaded", function() {
    /* listen to when editable-cell is in focus. when in focus, create the extra row below it with the buttons
            save edits (blue), cancel edits (grey), and remove row (red)
            (when out of focus, remove this row)
    */

    // note: an empty cell displays as [Empty] in the UI. when focusin, change the contents to just empty for editing
    // when editable cell is in focus
    document.addEventListener("focusin", function(e) {
        if (e.target.classList.contains("editable-cell")) {
            // keep track of the cell being edited and its original value
            currentEditingCell = e.target;
            ogValue = e.target.textContent;
            // make an empty cell be empty when editing it
            if (ogValue === "[Empty]") {
                e.target.textContent = "";
                ogValue = e.target.textContent;
            }
            else if (ogValue === "[Binary Data]") {
                editable = false;
            }
            // if the VR is a DATE vr, remove the slashes in the string if editing
            else if (getVR(currentEditingCell) === "DA") {
                // remove all of the slashes to be consistent with the actual content of the tag
                e.target.textContent = ogValue.replace(/\//g, "");
                ogValue = e.target.textContent;
            }
            // create the row that allows user to save/cancel/remove row
            editable = createButtonsRow(e.target) && editable;
        }
    });

    // when cell goes out of focus, remove the editing buttons row
    document.addEventListener("focusout", function(e) {
        setTimeout(() => {
            if (currentEditingCell?.textContent === "" && edited) {
                // display empty cell as "[Empty]"
                currentEditingCell.textContent = "[Empty]";
            }
            // if no changes were saved, then revert back to original when focused out
            else if (!edited) {
                currentEditingCell.textContent = ogValue;
            }
            // reformat dates
            if (currentEditingCell && getVR(currentEditingCell) === "DA") {
                const val = currentEditingCell.textContent;
                console.log(val);
                // if it's a valid 8-digit date, format it
                if (val.length === 8 && /^\d+$/.test(val)) {
                    currentEditingCell.textContent = `${val.slice(0, 4)}/${val.slice(4, 6)}/${val.slice(6, 8)}`;
                }
                // if it's already formatted but was reverted to original, reformat the original
                else if (ogValue.length === 8 && /^\d+$/.test(ogValue) && val === ogValue) {
                    currentEditingCell.textContent = `${ogValue.slice(0, 4)}/${ogValue.slice(4, 6)}/${ogValue.slice(6, 8)}`;
                }
            }
            
            currentEditingCell = null;
            editable = true;
            edited = false;
            removeButtonsRow();
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
                const hexTag = getHexTag(currentEditingCell);
                const VR = getVR(currentEditingCell);
                // store edit, don't send to extension yet
                pendingEdits[hexTag] = { vr: VR, value: newValue };
                markChanged();
                edited = true;
            }
            else if (!editable) {
                currentEditingCell.textContent = ogValue;
                console.log("cannot edit binary data");
            }
            // remove focus from the cell
             currentEditingCell.blur();
        }
    });

    // listen to button presses (save/cancel/remove row, save dicoms)
    document.addEventListener("click", function(e) {
        if (e.target.classList.contains("save-edits")) {
            const newValue = currentEditingCell.textContent;
            if (newValue !== ogValue && editable) {
                const hexTag = getHexTag(currentEditingCell);
                const VR = getVR(currentEditingCell);
                pendingEdits[hexTag] = { vr: VR, value: newValue };
                markChanged();
                edited = true;
            }
            // fixme: distinguish between editable and removable (ex. binary data cannot be edited)
            else if (!editable) {
                currentEditingCell.textContent = ogValue;
                console.log("cannot edit");
                // remove focus from the cell and remove buttons row
                currentEditingCell.blur();
                removeButtonsRow();
            }
            // remove focus from the cell
            currentEditingCell.blur();
        }
        // check for "remove row" button
        else if (e.target.classList.contains("remove-row")) {
            if (editable) {
                const row = currentEditingCell.closest('tr');
                const hexTag = getHexTag(currentEditingCell);
                pendingRemovals.add(hexTag);
                markChanged();
                row.remove();
            }
            else {
                currentEditingCell.textContent = ogValue;
                console.log("cannot remove");
            }
            // remove focus from the cell
            currentEditingCell.blur();
        }
        // check for cancel button which just cancels the change
        else if (e.target.classList.contains("cancel")) {
            currentEditingCell.textContent = ogValue;
            currentEditingCell.blur();
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
        const hexTag = getHexTag(cell);
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
            saveButtonHTML = 
                '<div class="tooltip">' +
                    '<button class="action-button save-edits" style="background: #007ACC; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Save</button>' +
                    '<span class="tooltiptext">Warning: Editing this tag may invalidate the DICOM. Be sure to check DICOM standard guidelines before saving changes.</span>' +
                '</div>';
            // add tooltip (popup that shows up when hovering) for removal of tags that are required
            removeButtonHTML = 
                '<div class="tooltip">' +
                    '<button class="action-button remove-row" style="background: #E74C3C; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Remove Row</button>' +
                    '<span class="tooltiptext">Warning: Deleting this tag will invalidate the DICOM.</span>' +
                '</div>';
        }
        // block removal of anything used in getimage()
        if (tagRequired === "image") {
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
        } else if (tagRequired === "ok") {
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
    // 	note: when making edits to the cell, if it is empty, warning popup when hover over save
    function isTagRequired(tag) {
        tag = tag.replace(/^x/, "").toUpperCase();

        // tags required for getImage() to work (CANNOT delete or modify)
        // todo: add binary things and other stuff that just shouldn't be modified here
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
        // todo: check if these are correct and fully inclusive
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