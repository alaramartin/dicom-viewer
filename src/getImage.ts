import * as dicomParser from 'dicom-parser';
import * as fs from 'fs';

export function convertDicomToBase64(filepath: string): string {
    try {
        const dicomFile = fs.readFileSync(filepath);
        const dataSet = dicomParser.parseDicom(dicomFile);
        
        // get pixel data
        const pixelData = dataSet.elements.x7fe00010; // pixel data dicom header tag
        if (pixelData) {
            // get pixel data and convert to base64
            const pixelBytes = dicomFile.slice(pixelData.dataOffset, pixelData.dataOffset + pixelData.length);
            const base64Image = Buffer.from(pixelBytes).toString('base64');
            return base64Image;
        } else {
            throw new Error('no pixel data');
        }
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`failed ${error.message}`);
        } else {
            throw new Error('failed');
        }
    }
}