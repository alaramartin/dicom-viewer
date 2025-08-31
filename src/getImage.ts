import * as dicomParser from 'dicom-parser';
import dicomDataDictionary from 'dicom-data-dictionary';
import * as fs from 'fs';
import { createCanvas } from 'canvas';
import { DicomMetaDictionary } from 'dcmjs';

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
    let metadata = [["Hex Tag", "Tag Name", "VR", "Value"]];
    try {
        const dicomFile = fs.readFileSync(filepath);
        const dataSet = dicomParser.parseDicom(dicomFile);

        for (const tag in dataSet.elements) {
            if (dataSet.elements.hasOwnProperty(tag)) {
                // get the info of the tag itself
                let tagName = 'Unknown';
                try {
                    const cleanTag = tag.replace('x', '');
                    
                    // manual mapping for DICOM tags
                    const commonTags: {[key: string]: string} = {
                        '00020000': 'File Meta Information Group Length',
                        '00020001': 'File Meta Information Version',
                        '00020002': 'Media Storage SOP Class UID',
                        '00020003': 'Media Storage SOP Instance UID',
                        '00020010': 'Transfer Syntax UID',
                        '00020012': 'Implementation Class UID',
                        '00020013': 'Implementation Version Name',
                        '00020016': 'Source Application Entity Title',
                        '00080005': 'Specific Character Set',
                        '00080008': 'Image Type',
                        '00080012': 'Instance Creation Date',
                        '00080013': 'Instance Creation Time',
                        '00080016': 'SOP Class UID',
                        '00080018': 'SOP Instance UID',
                        '00080020': 'Study Date',
                        '00080021': 'Series Date',
                        '00080022': 'Acquisition Date',
                        '00080023': 'Content Date',
                        '00080030': 'Study Time',
                        '00080031': 'Series Time',
                        '00080032': 'Acquisition Time',
                        '00080033': 'Content Time',
                        '00080050': 'Accession Number',
                        '00080060': 'Modality',
                        '00080070': 'Manufacturer',
                        '00080080': 'Institution Name',
                        '00080090': 'Referring Physician Name',
                        '00081010': 'Station Name',
                        '00081030': 'Study Description',
                        '0008103E': 'Series Description',
                        '00081040': 'Institutional Department Name',
                        '00081050': 'Performing Physician Name',
                        '00081090': 'Manufacturer Model Name',
                        '00100010': 'Patient Name',
                        '00100020': 'Patient ID',
                        '00100030': 'Patient Birth Date',
                        '00100040': 'Patient Sex',
                        '00101010': 'Patient Age',
                        '00101020': 'Patient Size',
                        '00101030': 'Patient Weight',
                        '00102160': 'Ethnic Group',
                        '00102180': 'Occupation',
                        '001021B0': 'Additional Patient History',
                        '00180015': 'Body Part Examined',
                        '00180050': 'Slice Thickness',
                        '00180060': 'KVP',
                        '00180088': 'Spacing Between Slices',
                        '00181000': 'Device Serial Number',
                        '00181020': 'Software Version',
                        '00181030': 'Protocol Name',
                        '00181151': 'X-Ray Tube Current',
                        '00181152': 'Exposure',
                        '00181210': 'Convolution Kernel',
                        '00200010': 'Study ID',
                        '00200011': 'Series Number',
                        '00200012': 'Acquisition Number',
                        '00200013': 'Instance Number',
                        '00200032': 'Image Position Patient',
                        '00200037': 'Image Orientation Patient',
                        '00200052': 'Frame of Reference UID',
                        '00200060': 'Laterality',
                        '00201002': 'Images in Acquisition',
                        '00280002': 'Samples per Pixel',
                        '00280004': 'Photometric Interpretation',
                        '00280008': 'Number of Frames',
                        '00280010': 'Rows',
                        '00280011': 'Columns',
                        '00280030': 'Pixel Spacing',
                        '00280100': 'Bits Allocated',
                        '00280101': 'Bits Stored',
                        '00280102': 'High Bit',
                        '00280103': 'Pixel Representation',
                        '00281050': 'Window Center',
                        '00281051': 'Window Width',
                        '00281052': 'Rescale Intercept',
                        '00281053': 'Rescale Slope',
                        '00281054': 'Rescale Type',
                        '7FE00010': 'Pixel Data'
                    };
                    tagName = commonTags[cleanTag] || `Unknown (${cleanTag})`;
                } catch (e) {
                    console.log(`Error getting tag name for ${tag}:`, e);
                    tagName = 'Unknown';
                }

                const element = dataSet.elements[tag];
                let value = '';
                
                // handle different vr types
                if (element.vr === 'SQ') {
                    value = '[Sequence]';
                } else if (element.vr === 'OB' || element.vr === 'OW' || element.vr === 'OF') {
                    value = '[Binary Data]';
                } else {
                    // get string representation for text/numeric VRs
                    try {
                        value = dataSet.string(tag) || '[Empty]';
                    } catch (e) {
                        value = '[Cannot display]';
                    }
                }
                metadata.push([tag, tagName, element.vr || 'UN', value]);
            }
        }
    } catch (ex) {
        console.error('Error parsing DICOM', ex);
    }
    return metadata;
}