import * as dicomParser from 'dicom-parser';
import * as fs from 'fs';
import { normalize } from 'path';
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

export function getMetadata(filepath: string): Array<any> {
    let metadata = [["Hex Tag", "Tag Name", "VR", "Value"]];
    try {
        const dicomFile = fs.readFileSync(filepath);
        const dataSet = dicomParser.parseDicom(dicomFile);

        for (const tag in dataSet.elements) {
            if (dataSet.elements.hasOwnProperty(tag)) {
                // get the info of the tag itself
                let tagName = 'Unknown';
                let vr = 'UN';
                let cleanTag = tag.replace('x', '').toUpperCase();
                const element = dataSet.elements[tag];

                try {
                    const dictionary = require('@iwharris/dicom-data-dictionary');
                    const elem = dictionary.get_element(cleanTag);
                    tagName = elem["name"];
                    vr = elem["vr"];
                }
                catch (e) {
                    console.log("iwharris", e);
                }
                
                // use the VR from the element if available, otherwise use our lookup
                let finalVr = element.vr || vr;
                finalVr = normalizeVR(finalVr);
                
                let value = '';
                
                // handle different vr types
                if (finalVr === 'SQ') {
                    value = '[Sequence]';
                    // todo: make it a dropdown/collapsible sequence element with each element within
                } else if (finalVr === 'OB' || finalVr === 'OW' || finalVr === 'OF') {
                    value = '[Binary Data]';
                } else if (finalVr === 'DA') {
                    // if the VR is a date, make it more readable format (YYYY/MM/DD)
                    const dateStr = dataSet.string(tag);
                    if (dateStr && dateStr.length === 8) {
                        // DICOM DA format is YYYYMMDD
                        value = `${dateStr.slice(0, 4)}/${dateStr.slice(4, 6)}/${dateStr.slice(6, 8)}`;
                    } else if (dateStr) {
                        value = dateStr;
                    } else {
                        value = '[Empty]';
                    }
                } else {
                    // get string representation for text/numeric VRs
                    try {
                        value = dataSet.string(tag) || '[Empty]';
                    } catch (e) {
                        value = '[Cannot display]';
                    }
                }
                metadata.push([tag, tagName, finalVr, value]);
            }
        }
    } catch (ex) {
        console.error('Error parsing DICOM', ex);
    }
    return metadata;
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