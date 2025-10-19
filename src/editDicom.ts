import fs from "fs";
import * as dcmjs from "dcmjs";

export function saveDicomEdit(editData: any, filepath: string, mode: string) {
    // load dicom file and get data
    const dicomFile = fs.readFileSync(filepath);
    const arrayBuffer = dicomFile.buffer.slice(
        dicomFile.byteOffset,
        dicomFile.byteOffset + dicomFile.byteLength
    );
    const originalDicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
    const dicomDict = new dcmjs.data.DicomDict(originalDicomData.meta || {});
    dicomDict.dict = originalDicomData.dict;
    
    // update the tag with the new value
        // ERR [Extension Host] Invalid vr type ox - using OW
        //      note: might have to ignore this one... seems like the code still executes
    if (editData.isSequenceElement) {
        updateSequenceElement(dicomDict, editData.sequenceTag, editData.itemIndex, editData.elementTag, editData.vr, editData.value);
    } else {
        const tag = editData.tag.replace(/^x/, "");
        dicomDict.upsertTag(tag, editData.vr, [String(editData.value)]);
    }

    saveToFile(dicomDict, filepath, mode, `Tag updated`);
}

export function removeDicomTag(removeData: any, filepath: string, mode: string) {
    const dicomFile = fs.readFileSync(filepath);
    const arrayBuffer = dicomFile.buffer.slice(
        dicomFile.byteOffset,
        dicomFile.byteOffset + dicomFile.byteLength
    );
    const originalDicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
    const dicomDict = new dcmjs.data.DicomDict(originalDicomData.meta || {});
    dicomDict.dict = originalDicomData.dict;

    if (removeData.isSequenceElement) {
        removeSequenceElement(dicomDict, removeData.sequenceTag, removeData.itemIndex, removeData.elementTag);
    } else {
        const tag = removeData.tag.replace(/^x/, "");
        // check if the tag exists (it should) and delete
        if (dicomDict.dict[tag]) {
            delete dicomDict.dict[tag];
        }
    }

    saveToFile(dicomDict, filepath, mode, `Tag removed`);
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
    console.log(`Removed sequence element ${sequenceTag}[${itemIndex}].${elementTag}`);
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
    
    console.log(`${logMessage} → ${outputPath}`);
}