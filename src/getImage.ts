import * as dicomParser from 'dicom-parser';
import * as fs from 'fs';
import { createCanvas } from 'canvas';

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
        
        console.log(`DICOM info: ${modality}, ${cols}x${rows}, ${bitsAllocated}/${bitsStored} bits, samples: ${samplesPerPixel}, photometric: ${photometricInterpretation}`);

        if (!pixelData || !rows || !cols) {
            throw new Error('Missing DICOM data');
        }

        let pixelArray;
        const bytesPerSample = Math.ceil(bitsAllocated / 8);
        const expectedLength = rows * cols * samplesPerPixel * bytesPerSample;
        
        console.log(`Expected pixel data length: ${expectedLength}, actual: ${pixelData.length}`);
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

        console.log(`Pixel range: ${min} - ${max}, valid pixels: ${validPixelCount}`);

        // create the canvas to convert pixel data to an image
        const canvas = createCanvas(cols, rows);
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(cols, rows);

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
            if (idx + 3 < imageData.data.length) {
                imageData.data[idx] = gray;     // R
                imageData.data[idx + 1] = gray; // G  
                imageData.data[idx + 2] = gray; // B
                imageData.data[idx + 3] = 255;  // A
            }
        }

        ctx.putImageData(imageData, 0, 0);
        return canvas.toDataURL('image/png');
        
    } catch (error:any) {
        console.error('DICOM conversion error:', error);
        throw new Error(`Failed to convert DICOM: ${error.message}`);
    }
}

export function getMetadata(filepath: string): Array<any> {
    // return all metadata of the dicom that is present and isn't binary
    let metadata = [["Tag", "VR", "Value"]];
    try {
        // get the dicom
        const dicomFile = fs.readFileSync(filepath);
        const dataSet = dicomParser.parseDicom(dicomFile);

        // iterate over all metadata elements in the dataSet
        for (const tag in dataSet.elements) {
            // check if tag exists in dicom
            if (dataSet.elements.hasOwnProperty(tag)) {
                const element = dataSet.elements[tag];
                
                // dicom VR = value representation, have to deal with different VRs differently (data types)



                // Get the value of the element using the appropriate helper function
                // For string elements:
                if (element.vr === 'AE' || element.vr === 'CS' || element.vr === 'LO' /* etc. */) {
                    const value = dataSet.string(tag);
                    console.log(`Tag: ${tag}, VR: ${element.vr}, Value: ${value}`);
                    metadata.push([tag, element.vr, value ?? '']);
                }
                // For sequence elements, you need to iterate further
                else if (element.vr === 'SQ') {
                    console.log(`Tag: ${tag}, VR: ${element.vr}, Is a Sequence`);
                    const sequenceItems = element.items;
                    if (sequenceItems) {
                        // Iterate through each item in the sequence
                        sequenceItems.forEach((item, index) => {
                            console.log(`  Item #${index + 1}`);
                            // Recursively call a function to process the nested dataSet
                            // For a simple print, you can iterate its elements property
                            for (const subTag in item.dataSet?.elements) {
                                const subElement = item.dataSet.elements[subTag];
                                const subValue = item.dataSet.string(subTag);
                                console.log(`    Tag: ${subTag}, VR: ${subElement.vr}, Value: ${subValue}`);
                                // fixme: how to mark if it's a SQ vr?
                                metadata.push([subTag, subElement.vr ?? '', subValue ?? '']);
                            }
                        });
                    }
                }
                // You can add more conditions for other VR types like `PN`, `DA`, `TM`, etc.
                // or simply use `dataSet.string()` or other helpers where appropriate.
            }
        }
    } catch (ex) {
        console.error('Error parsing byte stream', ex);
    }

    return metadata;
}