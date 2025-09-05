import fs from "fs";
import * as dcmjs from "dcmjs";

export function saveDicomEdit(tag:string, vr:string, newValue:string, filepath:string, mode:string) {
    // load dicom file and get data
    tag = tag.replace(/^x/, "");
    const dicomFile = fs.readFileSync(filepath);
    const originalDicomData = dcmjs.data.DicomMessage.readFile(dicomFile.buffer);
    const dicomDict = new dcmjs.data.DicomDict(originalDicomData.meta || {});
    dicomDict.dict = originalDicomData.dict;
    
    // update the tag with the new value
    dicomDict.upsertTag(tag, vr, [String(newValue)]);
    
    // re-encode and save to either a new file or the same file, depending on user choice
    let outputPath;
    if (mode === "new") {
        outputPath = filepath.replace(/\.dcm$/i, "_edited.dcm");
    }
    else {
        outputPath = filepath;
    }
    const newBuffer = Buffer.from(dicomDict.write());
    fs.writeFileSync(outputPath, newBuffer);

    console.log(`Tag ${tag} updated to "${newValue}" (VR=${vr}) → ${outputPath}`);
}

export function removeDicomTag(tag:string, filepath:string, mode:string) {
    // load dicom file and get data
    tag = tag.replace(/^x/, "");
    const dicomFile = fs.readFileSync(filepath);
    const originalDicomData = dcmjs.data.DicomMessage.readFile(dicomFile.buffer);
    const dicomDict = new dcmjs.data.DicomDict(originalDicomData.meta || {});
    dicomDict.dict = originalDicomData.dict;

    // check if the tag exists (it should) and delete
    if (dicomDict.dict[tag]) {
        delete dicomDict.dict[tag];
        console.log(`tag ${tag} removed from ${filepath}`);
    } else {
        console.warn(`tag ${tag} not found in ${filepath}`);
    }

    // re-encode and save to either a new file or the same file, depending on user choice
    let outputPath;
    if (mode === "new") {
        outputPath = filepath.replace(/\.dcm$/i, "_edited.dcm");
    }
    else {
        outputPath = filepath;
    }
    const newBuffer = Buffer.from(dicomDict.write());
    fs.writeFileSync(outputPath, newBuffer);

    console.log(`Saved new DICOM with tag ${tag} removed to ${outputPath}`);
}
