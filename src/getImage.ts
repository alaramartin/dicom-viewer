import * as dicomParser from 'dicom-parser';
import * as fs from 'fs';
import { PNG } from 'pngjs';

export function convertDicomToBase64(filepath: string): string {
    try {
        // get the dicom file and its metadata
        const dicomFile = fs.readFileSync(filepath);
        const dataSet = dicomParser.parseDicom(dicomFile);
        
        // getting various dicom attributes using their header tags
        const rows = dataSet.uint16('x00280010');
        const cols = dataSet.uint16('x00280011');
        const bitsAllocated = dataSet.uint16('x00280100') || 16;
        const bitsStored = dataSet.uint16('x00280101') || bitsAllocated;
        const pixelRepresentation = dataSet.uint16('x00280103') || 0;
        const samplesPerPixel = dataSet.uint16('x00280002') || 1;
        const photometricInterpretation = dataSet.string('x00280004') || 'MONOCHROME2';
        const pixelData = dataSet.elements.x7fe00010; // this is the pixel array
        const modality = dataSet.string('x00080060') || 'UNKNOWN';
        

        if (!pixelData || !rows || !cols) {
            throw new Error('Missing DICOM data');
        }

        let pixelArray;
        const bytesPerSample = Math.ceil(bitsAllocated / 8);
        const expectedLength = rows * cols * samplesPerPixel * bytesPerSample;
        
        if (expectedLength !== pixelData.length) {
            return "compressed";
        }

        // handle different bit depths
        if (bitsAllocated <= 8) {
            pixelArray = new Uint8Array(dicomFile.buffer, pixelData.dataOffset, Math.min(pixelData.length, expectedLength));
        } else if (bitsAllocated <= 16) {
            const length16 = Math.min(pixelData.length / 2, rows * cols * samplesPerPixel);
            if (pixelRepresentation === 1) {
                pixelArray = new Int16Array(dicomFile.buffer, pixelData.dataOffset, length16);
            } else {
                pixelArray = new Uint16Array(dicomFile.buffer, pixelData.dataOffset, length16);
            }
        } else {
            throw new Error(`Unsupported bit allocation: ${bitsAllocated}`);
        }

        // find min/max for windowing (like window/level, adjusting contrast to make it better visibility)
        let min = Number.MAX_SAFE_INTEGER;
        let max = Number.MIN_SAFE_INTEGER;
        const validPixelCount = Math.min(pixelArray.length, rows * cols);
        
        for (let i = 0; i < validPixelCount; i++) {
            const pixel = pixelArray[i];
            min = Math.min(min, pixel);
            max = Math.max(max, pixel);
        }

        // create PNG
        const png = new PNG({ width: cols, height: rows });

        // convert pixels with proper windowing
        for (let i = 0; i < validPixelCount; i++) {
            let pixel = pixelArray[i];
            
            // handle signed data
            if (pixelRepresentation === 1 && pixel < 0) {
                pixel = pixel + (1 << bitsStored);
            }
            
            // normalize to 0-255
            let normalizedPixel;
            if (max === min) {
                normalizedPixel = 0;
            } else {
                normalizedPixel = (pixel - min) / (max - min);
            }
            
            let gray = Math.floor(normalizedPixel * 255);
            
            // handle photometric interpretation
            if (photometricInterpretation === 'MONOCHROME1') {
                // invert for MONOCHROME1 (0 = white)
                gray = 255 - gray;
            }
            
            // clamp to valid range
            gray = Math.max(0, Math.min(255, gray)); 
            
            const idx = i * 4;
            if (idx + 3 < png.data.length) {
                png.data[idx] = gray;     // R
                png.data[idx + 1] = gray; // G  
                png.data[idx + 2] = gray; // B
                png.data[idx + 3] = 255;  // A
            }
        }

        // convert PNG to base64
        const buffer = PNG.sync.write(png);
        return 'data:image/png;base64,' + buffer.toString('base64');
        
    } catch (error: any) {
        console.error('DICOM conversion error:', error);
        throw new Error(`Failed to convert DICOM: ${error.message}`);
    }
}

// export function getMetadata(filepath: string): Array<any> {
//     let metadata = [["Hex Tag", "Tag Name", "VR", "Value"]];
//     const dictionary = require('@iwharris/dicom-data-dictionary');
//     try {
//         const dicomFile = fs.readFileSync(filepath);
//         const dataSet = dicomParser.parseDicom(dicomFile);

//         for (const tag in dataSet.elements) {
//             if (dataSet.elements.hasOwnProperty(tag)) {
//                 // get the info of the tag itself
//                 let tagName = 'Unknown';
//                 let vr = 'UN';
//                 let cleanTag = tag.replace('x', '').toUpperCase();
//                 const element = dataSet.elements[tag];

//                 try {
//                     const elem = dictionary.get_element(cleanTag);
//                     tagName = elem["name"];
//                     vr = elem["vr"];
//                 }
//                 catch {
//                     // ignore the error, it's just iwharris not finding the vr
//                 }
                
//                 // use the VR from the element if available, otherwise use our lookup
//                 let finalVr = element.vr || vr;
//                 finalVr = normalizeVR(finalVr);
                
//                 let value = '';

//                 // handle different vr types
//                 if (element.items && finalVr === 'SQ') {
//                     // add the sequence header row to the table
//                     metadata.push([tag, tagName, finalVr, `[Sequence - ${element.items.length} items]`, 'sequence-header']);

//                     // handle every item in the sequence
//                     element.items.forEach((item: any, itemIndex: number) => {
//                         metadata.push([
//                             `${tag}_item_${itemIndex}`,
//                             `Item #${itemIndex}`,
//                             `Length: ${item.length}$item.hadUndefinedLength ? ' (-1)' : ''`,
//                             'sequence-item-header',
//                             tag
//                         ]);

//                         if (item.dataSet) { 
//                             const itemMetadata = processElement(item.dataSet, dictionary, `${tag}_item_${itemIndex}`);
//                             metadata = metadata.concat(itemMetadata);
//                         }
//                     });
//                     continue;
//                 } else {
//                     value = getTagValue(dataSet, tag, finalVr);
//                 }
//                 metadata.push([tag, tagName, finalVr, value]);
//             }
//         }
//     } catch (ex) {
//         console.error('Error parsing DICOM', ex);
//     }
//     return metadata;
// }

export function getMetadata(filepath: string): Array<any> {
    let metadata = [["Hex Tag", "Tag Name", "VR", "Value"]];
    const dictionary = require('@iwharris/dicom-data-dictionary');
    try {
        const dicomFile = fs.readFileSync(filepath);
        const dataSet = dicomParser.parseDicom(dicomFile);

        const processedMetadata = processDataSet(dataSet, dictionary);
        metadata = metadata.concat(processedMetadata);
    } catch (ex) {
        console.error('Error parsing DICOM', ex);
    }
    return metadata;
}

function getTagInfo(tag: string, element: any, dictionary: any) {
    // get the info of the tag itself
    let tagName = 'Unknown';
    let vr = 'UN';
    let cleanTag = tag.replace('x', '').toUpperCase();

    try {
        const elem = dictionary.get_element(cleanTag);
        tagName = elem["name"];
        vr = elem["vr"];
    }
    catch {
        // ignore the error, it's just iwharris not finding the vr
    }
    
    // use the VR from the element if available, otherwise use our lookup
    const finalVr = normalizeVR(element.vr || vr);

    return {tagName, finalVr};
}

function getTagValue(dataSet: dicomParser.DataSet, tag: string, vr: string): string {
    if (vr === 'SQ') {
        return '[Sequence]';
    } else if (vr === 'OB' || vr === 'OW' || vr === 'OF' || vr === 'OD' || tag.toLowerCase() === 'x7fe00010') {
        return '[Binary Data]';
    } else if (vr === 'DA') {
        // if the VR is a date, make it more readable format (YYYY/MM/DD)
        const dateStr = dataSet.string(tag);
        return formatDate(dateStr);
    } else {
        // get string representation for text/numeric VRs
        try {
            return dataSet.string(tag) || '[Empty]';
        } catch (e) {
            return '[Cannot display]';
        }
    }
}

// fixes invalid VRs
function normalizeVR(vr:string) {
    // full list of every valid VR
    const validVrList = [
        "AE", "AS", "AT", "CS", "DA", "DS", "DT", "FL", "FD", "IS", "LO", "LT", 
        "OB", "OD", "OF", "OW", "PN", "SH", "SL", "SQ", "SS", "ST", "TM", "UI",
        "UL", "UN", "US", "UT"
    ];
    // dict of some common invalid -> valid VR mappings
    const commonMappings: { [key:string]:string } = {
        "XS": "US",
        "OX": "OW"
    };

    if (!validVrList.includes(vr)) {
        return commonMappings[vr] ?? "UN";
    }
    else {
        return vr;
    }
}

function formatDate(dateStr?: string): string {
    if (dateStr && dateStr.length === 8) {
        // DICOM DA format is YYYYMMDD
        return `${dateStr.slice(0, 4)}/${dateStr.slice(4, 6)}/${dateStr.slice(6, 8)}`;
    } else if (dateStr) {
        return dateStr;
    } else {
        return '[Empty]';
    }
}
function processSequence(tag: string, tagInfo: any, element: any, dictionary: any, parentTag?: string): Array<any> {
    const metadata: Array<any> = [];

    // add the sequence header row to the table
    const headerRow = [tag, tagInfo.tagName, tagInfo.finalVr, `[Sequence - ${element.items.length} item(s)]`, 'sequence-header'];
    if (parentTag) {
        headerRow.push(parentTag);
    }
    metadata.push(headerRow);

    // handle every item in the sequence
    element.items.forEach((item: any, itemIndex: number) => {
        const itemRow = [
            `${tag}_item_${itemIndex}`,
            `Item #${itemIndex}`,
            'ITEM',
            `Length: ${item.length}${item.hadUndefinedLength ? ' (-1)' : ''}`,
            'sequence-item-header',
            tag
        ];
        metadata.push(itemRow);

        if (item.dataSet) { 
            const itemMetadata = processDataSet(item.dataSet, dictionary, `${tag}_item_${itemIndex}`);
            console.log(`Generated ${itemMetadata.length} child elements for item ${itemIndex}`); // Debug log
            metadata.push(...itemMetadata);
        }
    });

    return metadata;
}

// recursively handle an element dataset
function processDataSet(dataSet: dicomParser.DataSet, dictionary: any, parentTag?: string): Array<any> {
    const metadata: Array<any> = [];
    
    for (const tag in dataSet.elements) {
        if (dataSet.elements.hasOwnProperty(tag)) {
            const element = dataSet.elements[tag];

            const tagInfo = getTagInfo(tag, element, dictionary);
            const rowType = parentTag ? 'sequence-element' : 'normal';

            if (element.items && tagInfo.finalVr === 'SQ') {
                metadata.push(...processSequence(tag, tagInfo, element, dictionary, parentTag));
            } else {
                const value = getTagValue(dataSet, tag, tagInfo.finalVr);
                const row = [tag, tagInfo.tagName, tagInfo.finalVr, value, rowType];
                if (parentTag) {
                    row.push(parentTag);
                }
                metadata.push(row);
            }
        }
    }
    return metadata;
}