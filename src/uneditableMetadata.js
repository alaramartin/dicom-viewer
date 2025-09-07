/* idea: have two separate .js files... editableMetadataWebview.js and uneditableMetadata.js
    insert the uneditable version if isCompressed.
    in uneditable version, whenever an editable cell is clicked, vscode.showingofmraiton("cannot edit compressed dicom")
        and don't even show the remove cell.
        if edits are made to the editable cell, revert it back to original as soon as focusout.
    editable versoin stays the same
*/

// script to handle the UI of when the image is compressed and therefore no edits can be made

window.addEventListener("message", function(e) {
    command = e.data.command;
    if (command === "reset") {
        resetChanges();
    }
});