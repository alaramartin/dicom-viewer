import fs from "fs";
import * as dcmjs from "dcmjs";

// Apply every pending edit and removal to a single dicomDict (read once from
// disk) and write the result once. Previously each edit was read/applied/
// written independently, so in "new" mode (which always writes to the same
// _edited.dcm path) each iteration started from the pristine original and
// clobbered the previous iteration's output — only the last edit survived.
export function saveDicomEdits(edits: any[], removals: any[], filepath: string, mode: string): { editErrors: unknown[]; removalErrors: unknown[] } {
    const dicomFile = fs.readFileSync(filepath);
    const arrayBuffer = dicomFile.buffer.slice(
        dicomFile.byteOffset,
        dicomFile.byteOffset + dicomFile.byteLength
    );
    const originalDicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
    const dicomDict = new dcmjs.data.DicomDict(originalDicomData.meta || {});
    dicomDict.dict = originalDicomData.dict;

    const editErrors: unknown[] = [];
    const removalErrors: unknown[] = [];

    for (const editData of edits) {
        try {
            applyDicomEdit(dicomDict, editData);
        } catch (e) {
            editErrors.push(e);
        }
    }

    for (const removeData of removals) {
        try {
            applyDicomRemoval(dicomDict, removeData);
        } catch (e) {
            removalErrors.push(e);
        }
    }

    saveToFile(dicomDict, filepath, mode, `Applied ${edits.length} edit(s) and ${removals.length} removal(s)`);

    return { editErrors, removalErrors };
}

function applyDicomEdit(dicomDict: any, editData: any) {
    // update the tag with the new value
        // ERR [Extension Host] Invalid vr type ox - using OW
        //      note: might have to ignore this one... seems like the code still executes
    if (editData.isSequenceElement) {
        updateSequenceElement(dicomDict, editData.sequenceTag, editData.itemIndex, editData.elementTag, editData.vr, editData.value);
    } else {
        const tag = editData.tag.replace(/^x/, "");
        dicomDict.upsertTag(tag, editData.vr, [String(editData.value)]);
    }
}

function applyDicomRemoval(dicomDict: any, removeData: any) {
    if (removeData.isSequenceElement) {
        removeSequenceElement(dicomDict, removeData.sequenceTag, removeData.itemIndex, removeData.elementTag);
    } else {
        const tag = removeData.tag.replace(/^x/, "");
        // check if the tag exists (it should) and delete
        if (dicomDict.dict[tag]) {
            delete dicomDict.dict[tag];
        }
    }
}

function updateSequenceElement(dicomDict: any, sequenceTag: string, itemIndex: number, elementTag: string, vr: string, newValue: string) {
    sequenceTag = sequenceTag.replace(/^x/, "");
    elementTag = elementTag.replace(/^x/, "");

    const sequence = dicomDict.dict[sequenceTag];
    if (!sequence || !sequence.Value || !Array.isArray(sequence.Value)) {
        console.warn(`Sequence ${sequenceTag} not found or invalid`);
        return;
    }

    if (itemIndex >= sequence.Value.length) {
        console.warn(`Item index ${itemIndex} out of range for sequence ${sequenceTag}`);
        return;
    }

    const item = sequence.Value[itemIndex];
    if (!item) {
        console.warn(`Item ${itemIndex} not found in sequence ${sequenceTag}`);
        return;
    }

    item[elementTag] = {
        vr: vr,
        Value: [String(newValue)]
    };
}

function removeSequenceElement(dicomDict: any, sequenceTag: string, itemIndex: number, elementTag: string) {
    sequenceTag = sequenceTag.replace(/^x/, "");
    elementTag = elementTag.replace(/^x/, "");

    const sequence = dicomDict.dict[sequenceTag];
    if (!sequence || !sequence.Value || !Array.isArray(sequence.Value)) {
        console.warn(`Sequence ${sequenceTag} not found or invalid`);
        return;
    }

    if (itemIndex >= sequence.Value.length) {
        console.warn(`Item index ${itemIndex} out of range for sequence ${sequenceTag}`);
        return;
    }

    const item = sequence.Value[itemIndex];
    if (!item || !item[elementTag]) {
        console.warn(`Element ${elementTag} not found in sequence ${sequenceTag}[${itemIndex}]`);
        return;
    }

    delete item[elementTag];
}

// depending on mode, save to new file or replace original file
function saveToFile(dicomDict: any, filepath: string, mode: string, logMessage: string) {
    let outputPath;
    if (mode === "new") {
        outputPath = filepath.replace(/\.dcm$/i, "_edited.dcm");
    } else {
        outputPath = filepath;
    }

    const newBuffer = Buffer.from(dicomDict.write());
    fs.writeFileSync(outputPath, newBuffer);
}
