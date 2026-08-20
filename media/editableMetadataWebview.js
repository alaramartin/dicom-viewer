// script to handle the UI of editing dicom metadata

// get vscode api
const vscode = acquireVsCodeApi();
let currentEditingCell = null;
let editable = true;
let edited = false;
let ogValue = '';
let buttonRow = null;

// track pending edits/removals
let pendingEdits = {};
let pendingRemovals = new Set();
let hasChanges = false;
let isDicomInvalid = false;

// the true original value of each editable tag, captured once when the
// panel loads — used to detect when an edit is reverted back to it
let originalValues = {};

// mirrors the raw-value normalization applied to pendingEdits (DA slashes
// stripped, "[Empty]" treated as ""), so a cell's current text can be
// compared apples-to-apples against its original value
function computeRawValue(cell) {
    const text = cell.textContent;
    if (text === "[Empty]") {
        return "";
    }
    const vr = getVR(cell);
    if (vr === "DA" && text.includes("/")) {
        return text.replace(/\//g, "");
    }
    return text;
}

// once something has been edited, buttons pop up to save or discard changes to the dicom
function showDicomActions(show) {
    const actions = document.getElementById('dicom-actions');
    actions.style.display = show ? 'flex' : 'none';
}

// mirror pendingEdits/pendingRemovals up to the extension host, so they
// survive this panel being disposed and recreated (e.g. switching away from
// the image tab and back — see PLAN.md "pending edits silently discarded on
// tab switch"). The webview itself is torn down on every such switch; the
// host is not.
function notifyPendingChanged() {
    vscode.postMessage({
        command: "pendingChanged",
        edits: pendingEdits,
        removals: Array.from(pendingRemovals)
    });
}

// find the value cell for a previously-recorded edit/removal, by the same
// identity it was recorded under (tag, or sequenceTag+itemIndex+elementTag)
function findTargetCell(editOrRemoval) {
    if (editOrRemoval.isSequenceElement) {
        const itemTag = `${editOrRemoval.sequenceTag}_item_${editOrRemoval.itemIndex}`;
        const rows = document.querySelectorAll(`tr[data-parent="${itemTag}"]`);
        for (const row of rows) {
            const rowTag = row.cells[0].textContent.trim().replace(/^x/, "");
            if (rowTag === editOrRemoval.elementTag) {
                return row.cells[row.cells.length - 1];
            }
        }
        return null;
    } else {
        const rows = document.querySelectorAll("tbody > tr");
        for (const row of rows) {
            if (row.hasAttribute("data-parent") || !row.cells.length) {
                continue;
            }
            if (row.cells[0].textContent.trim() === editOrRemoval.tag) {
                return row.cells[row.cells.length - 1];
            }
        }
        return null;
    }
}

// re-apply edits/removals the host remembers from before this panel was
// last torn down
function restorePendingEdits(edits, removals) {
    Object.entries(edits || {}).forEach(([hexTag, editData]) => {
        const cell = findTargetCell(editData);
        if (!cell) {
            return;
        }
        let displayValue = editData.value;
        if (editData.vr === "DA" && /^\d{8}$/.test(displayValue)) {
            displayValue = `${displayValue.slice(0, 4)}/${displayValue.slice(4, 6)}/${displayValue.slice(6, 8)}`;
        }
        cell.textContent = displayValue === "" ? "[Empty]" : displayValue;
        pendingEdits[hexTag] = editData;
    });

    (removals || []).forEach(removalData => {
        const cell = findTargetCell(removalData);
        if (cell) {
            cell.closest("tr").remove();
        }
        pendingRemovals.add(removalData);
    });

    if (Object.keys(pendingEdits).length > 0 || pendingRemovals.size > 0) {
        hasChanges = true;
        showDicomActions(true);
    }
}

window.addEventListener("message", event => {
    const message = event.data;
    if (message.command === "restorePendingEdits") {
        restorePendingEdits(message.edits, message.removals);
    }
});

// keep track of any changes made to the dicom
function markChanged(invalidated) {
    hasChanges = true;
    if (invalidated) {
        addInvalidatedWarnings();
        isDicomInvalid = true;
    }
    showDicomActions(true);
}

// recompute whether anything is still pending, now that an edit may have
// been dropped (reverted back to its original value). hides the action bar
// once both pending collections are empty again.
function updateActionBarState() {
    hasChanges = Object.keys(pendingEdits).length > 0 || pendingRemovals.size > 0;
    if (!hasChanges) {
        isDicomInvalid = false;
        removeInvalidatedWarnings();
    }
    showDicomActions(hasChanges);
}

// true if editing this tag back to rawValue would restore its original,
// pre-edit value
function isRevertedToOriginal(hexTag, rawValue) {
    return Object.prototype.hasOwnProperty.call(originalValues, hexTag) && originalValues[hexTag] === rawValue;
}

// when dicom is at risk of being invalidated, add a tooltip warning to the official save buttons
function addInvalidatedWarnings() {
    const actions = document.getElementById('dicom-actions');
    const saveBtn = actions.querySelector('.save');
    const replaceBtn = actions.querySelector('.replace');
    
    if (!saveBtn.classList.contains('has-tooltip')) {
        saveBtn.classList.add('has-tooltip');
        const saveTooltip = document.createElement('span');
        saveTooltip.className = 'warning-tooltip';
        saveTooltip.textContent = 'Warning: Changes may violate DICOM standard and invalidate the file.';
        // make sure the text fits into the tooltip lmao
        saveTooltip.style.whiteSpace = 'normal';
        saveTooltip.style.wordBreak = 'break-word';
        saveTooltip.style.maxWidth = '200px';
        saveBtn.appendChild(saveTooltip);
    }
    if (!replaceBtn.classList.contains('has-tooltip')) {
        replaceBtn.classList.add('has-tooltip');
        const replaceTooltip = document.createElement('span');
        replaceTooltip.className = 'warning-tooltip';
        replaceTooltip.textContent = 'Warning: Changes may violate DICOM standard and invalidate the file.';
        replaceTooltip.style.whiteSpace = 'normal';
        replaceTooltip.style.wordBreak = 'break-word';
        replaceTooltip.style.maxWidth = '200px';
        replaceBtn.appendChild(replaceTooltip);
    }
}

function removeInvalidatedWarnings() {
    const actions = document.getElementById('dicom-actions');
    const buttonsWithTooltips = actions.querySelectorAll('.has-tooltip');
    
    buttonsWithTooltips.forEach(button => {
        button.classList.remove('has-tooltip');
        const tooltip = button.querySelector('.warning-tooltip');
        if (tooltip) {
            tooltip.remove();
        }
    });
}

function removeButtonsRow() {
    if (buttonRow) {
        buttonRow.remove();
        buttonRow = null;
    }
}

function getHexTag(cell) {
    const row = cell.closest('tr');
    return row.cells[0].textContent.trim();
}

function getVR(cell) {
    const row = cell.closest('tr');
    return row.cells[2].textContent.trim();
}

function getSequenceInfo(cell) {
    const row = cell.closest('tr');
    const parentAttr = row.getAttribute('data-parent');

    // check if parent is a sequence item, which indicates hat the element is a sequence elemnt
    if (parentAttr && parentAttr.includes('_item_')) {
        const parts = parentAttr.match(/^(.+)_item_(\d+)$/);
        if (parts) {
            return {
                isSequenceElement: true,
                sequenceTag: parts[1],
                itemIndex: parseInt(parts[2]),
                elementTag: row.cells[0].textContent.replace(/^x/, '')
            };
        }
    }
    return { isSequenceElement: false };
}

function sendSaveMessage(command, mode) {
    const info = getSequenceInfo(currentEditingCell);

    if (info.isSequenceElement) {
        vscode.postMessage({
            command: command,
            isSequenceElement: true,
            sequenceTag: info.sequenceTag,
            itemIndex: info.itemIndex,
            elementTag: info.elementTag,
            vr: getVR(currentEditingCell),
            value: currentEditingCell.textContent,
            mode: mode
        });
    } else {
        vscode.postMessage({
            command: command,
            isSequenceElement: false,
            tag: currentEditingCell.parentNode.cells[0].textContent,
            vr: getVR(currentEditingCell),
            value: currentEditingCell.textContent,
            mode: mode
        });
    }
}

document.addEventListener("DOMContentLoaded", function() {
    /* listen to when editable-cell is in focus. when in focus, create the extra row below it with the buttons
            save edits (blue), cancel edits (grey), and remove row (red)
            (when out of focus, remove this row)
    */

    // snapshot every editable cell's original value before any edits happen
    document.querySelectorAll(".editable-cell").forEach(cell => {
        originalValues[getHexTag(cell)] = computeRawValue(cell);
    });

    // all sequence elemenst should be initialized collapsed
    document.querySelectorAll(".sequence-header").forEach(header => {
        header.classList.add("sequence-collapsed");
        const toggle = header.querySelector(".sequence-toggle");
        if (toggle) {
            toggle.textContent = "▶";
        }
    });

    // note: an empty cell displays as [Empty] in the UI. when focusin, change the contents to just empty for editing
    // when editable cell is in focus
    document.addEventListener("focusin", function(e) {
        if (e.target.classList.contains("editable-cell")) {
            editable = true;
            edited = false;
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
        const oldCell = currentEditingCell;
        if (!oldCell) {
            return;
        }

        const oldOgValue = ogValue;
        const wasEdited = edited; // capture the edited state at the time of focusout
        const isClickingSave = e.relatedTarget && e.relatedTarget.classList.contains("save-edits");

        setTimeout(() => {
            if (!document.body.contains(oldCell)) { return; }

            if (oldCell.textContent === "" && wasEdited) {
                // display empty cell as "[Empty]"
                oldCell.textContent = "[Empty]";
            }
            // if no changes were saved, then revert back to original when focused out
            else if (!wasEdited && !isClickingSave && oldCell && oldCell.textContent !== oldOgValue) {
                oldCell.textContent = oldOgValue;
            }
            // reformat dates
            if (oldCell && getVR(oldCell) === "DA") {
                const val = oldCell.textContent;
                // if it's a valid 8-digit date, format it
                if (val?.length === 8 && /^\d+$/.test(val)) {
                    oldCell.textContent = `${val.slice(0, 4)}/${val.slice(4, 6)}/${val.slice(6, 8)}`;
                }
                // if it's already formatted but was reverted to original, reformat the original
                else if (oldOgValue && oldOgValue.length === 8 && /^\d+$/.test(oldOgValue) && val === oldOgValue) {
                    oldCell.textContent = `${oldOgValue.slice(0, 4)}/${oldOgValue.slice(4, 6)}/${oldOgValue.slice(6, 8)}`;
                }
            }
            // if a new cell hasn't been clicked on
            if (currentEditingCell === oldCell) {
                currentEditingCell = null;
                editable = true;
                edited = false;
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
        if (e.key === "Enter" && currentEditingCell) {
            edited = true;
            const newValue = currentEditingCell.textContent;
            // check if the value changed at all
            if (newValue !== ogValue && editable) {
                // get the dicom tag of the currenteditingcell (first column)
                const hexTag = getHexTag(currentEditingCell);
                const VR = getVR(currentEditingCell);
                const info = getSequenceInfo(currentEditingCell);
                
                // store the raw value for DICOM, not the formatted display value
                let rawValue = newValue;
                if (VR === "DA" && newValue.includes("/")) {
                    // convert formatted date
                    rawValue = newValue.replace(/\//g, "");
                }

                if (isRevertedToOriginal(hexTag, rawValue)) {
                    // edited back to its original value — drop the pending
                    // edit instead of leaving the file marked dirty
                    delete pendingEdits[hexTag];
                    updateActionBarState();
                } else {
                    // store edit, don't send to extension yet
                    if (info.isSequenceElement) {
                        pendingEdits[hexTag] = {
                            vr: VR,
                            value: rawValue,
                            isSequenceElement: true,
                            sequenceTag: info.sequenceTag,
                            itemIndex: info.itemIndex,
                            elementTag: info.elementTag
                        };
                    } else {
                        pendingEdits[hexTag] = { vr: VR, value: rawValue, tag: hexTag, isSequenceElement: false };
                    }
                    // if the tag was required but still edited, mark as potentially invalidated
                    markChanged((isTagRequired(hexTag, currentEditingCell) === "require"));
                }
                notifyPendingChanged();
            }
            else if (!editable) {
                currentEditingCell.textContent = ogValue;
            }
            removeButtonsRow();
            currentEditingCell.blur();
        }
    });

    // listen to button presses (save/cancel/remove row, save dicoms)
    document.addEventListener("click", function(e) {
        if (e.target.classList.contains("save-edits")) {
            edited = true;
            const newValue = currentEditingCell.textContent;
            // check if the value changed at all
            if (newValue !== ogValue && editable) {
                // get the dicom tag of the currenteditingcell (first column)
                const hexTag = getHexTag(currentEditingCell);
                const VR = getVR(currentEditingCell);
                const info = getSequenceInfo(currentEditingCell);
                
                // store the raw value for DICOM, not the formatted display value
                let rawValue = newValue;
                if (VR === "DA" && newValue.includes("/")) {
                    // convert formatted date
                    rawValue = newValue.replace(/\//g, "");
                }

                if (isRevertedToOriginal(hexTag, rawValue)) {
                    // edited back to its original value — drop the pending
                    // edit instead of leaving the file marked dirty
                    delete pendingEdits[hexTag];
                    updateActionBarState();
                } else {
                    // store edit, don't send to extension yet
                    if (info.isSequenceElement) {
                        pendingEdits[hexTag] = {
                            vr: VR,
                            value: rawValue,
                            isSequenceElement: true,
                            sequenceTag: info.sequenceTag,
                            itemIndex: info.itemIndex,
                            elementTag: info.elementTag
                        };
                    } else {
                        pendingEdits[hexTag] = { vr: VR, value: rawValue, tag: hexTag, isSequenceElement: false };
                    }
                    // if the tag was required but still edited, mark as potentially invalidated
                    markChanged((isTagRequired(hexTag, currentEditingCell) === "require"));
                }
                notifyPendingChanged();
            }
            else if (!editable) {
                currentEditingCell.textContent = ogValue;
            }
            removeButtonsRow();
            currentEditingCell.blur();
        }
        // check for "remove row" button
        else if (e.target.classList.contains("remove-row")) {
            if (editable) {
                const row = currentEditingCell.closest('tr');
                const hexTag = getHexTag(currentEditingCell);
                const info = getSequenceInfo(currentEditingCell);

                // store deletion
                if (info.isSequenceElement) {
                    pendingRemovals.add({
                        tag: hexTag,
                        isSequenceElement: true,
                        sequenceTag: info.sequenceTag,
                        itemIndex: info.itemIndex,
                        elementTag: info.elementTag
                    });
                } else {
                    pendingRemovals.add({tag: hexTag, isSequenceElement: false});
                }
                
                // if the tag was required but still removed, mark as potentially invalidated
                markChanged((isTagRequired(hexTag, currentEditingCell) === "require"));
                notifyPendingChanged();
                row.remove();
            }
            else {
                currentEditingCell.textContent = ogValue;
            }
            // remove focus from the cell
            removeButtonsRow();
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

        if (e.target.classList.contains("sequence-toggle")) {
            const sequenceTag = e.target.dataset.target;
            const sequenceRow = e.target.closest("tr");
            const childRows = document.querySelectorAll(`tr[data-parent="${sequenceTag}"]`);
            const allDescendants = [];

            // get all sequence elements from the item header
            childRows.forEach(child => {
                allDescendants.push(child);

                const childTag = child.getAttribute("data-item-tag");
                if (childTag) {
                    const grandChildren = document.querySelectorAll(`tr[data-parent="${childTag}"]`);
                    grandChildren.forEach(grandChild => allDescendants.push(grandChild));
                }
            });

            const isExpanded = sequenceRow.classList.contains("sequence-expanded");
            if (isExpanded) {
                // collapse the sequence
                allDescendants.forEach(row => {
                    row.classList.add("hidden");
                    row.classList.remove("visible");
                });
                sequenceRow.classList.remove("sequence-expanded");
                sequenceRow.classList.add("sequence-collapsed");
                e.target.textContent = "▶";
            } else {
                // expand
                allDescendants.forEach(row => {
                    row.classList.remove("hidden");
                    row.classList.add("visible");
                });
                sequenceRow.classList.remove("sequence-collapsed");
                sequenceRow.classList.add("sequence-expanded");
                e.target.textContent = "▼";
            }
        }
    });

    // add a row below the editing row that displays 3 button options
    function createButtonsRow(cell) {
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
        const tagRequired = isTagRequired(hexTag, cell);

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
        }
        else if (tagRequired === "binary") {
            saveButtonHTML =
                '<div class="tooltip">' +
                    '<button class="action-button save-edits" style="background: #a2aec1ff; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; pointer-events: none;">Save</button>' +
                    '<span class="tooltiptext">Binary data cannot be edited.</span>' +
                '</div>';
            removeButtonHTML = '<button class="action-button remove-row" style="background: #E74C3C; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Remove Row</button>';
            editable = false;
        }
        else if (tagRequired === "ok") {
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

    // required tags list from https://www.pclviewer.com/help/required_dicom_tags.htm
    // type 1: cannot be removed or empty
    // type 2: cannot be empty
    // type 3: optional
    // 	note: when making edits to the cell, if it is empty, warning popup when hover over save
    function isTagRequired(tag, cell) {
        tag = tag.replace(/^x/, "").toUpperCase();

        // tags required for getImage() to work (CANNOT delete or modify)
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
        
        // tags that should be warned before removal because will probably invalidate
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

        const vr = getVR(cell);
        if (imageRequiredTags.includes(tag)) {
            return "image";
        }
        else if (requiredTags.includes(tag)) {
            return "require";
        }
        else if (vr === 'OB' || vr === 'OW' || vr === 'OF' || vr === 'OD') {
            return "binary";
        }
        else {
            return "ok";
        }
    }

    function resetChanges() {
        pendingEdits = {};
        pendingRemovals = new Set();
        hasChanges = false;
        removeInvalidatedWarnings();
        showDicomActions(false);
    }
});