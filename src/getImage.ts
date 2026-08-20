import * as dicomParser from 'dicom-parser';
import * as fs from 'fs';
import { PNG } from 'pngjs';
import { getLogger, describeError } from './logger';

// Transfer syntaxes that carry raw, uncompressed pixel data. Anything else
// (JPEG baseline/lossless, JPEG-LS, JPEG 2000, RLE, etc.) is compressed and
// needs a codec we don't have yet — see Phase 2 in PLAN.md.
const UNCOMPRESSED_TRANSFER_SYNTAXES = new Set([
    '1.2.840.10008.1.2',   // Implicit VR Little Endian
    '1.2.840.10008.1.2.1', // Explicit VR Little Endian
    '1.2.840.10008.1.2.2', // Explicit VR Big Endian (retired)
]);

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
        const photometricInterpretation = (dataSet.string('x00280004') || 'MONOCHROME2').toUpperCase();
        const planarConfiguration = dataSet.uint16('x00280006') || 0;
        const pixelData = dataSet.elements.x7fe00010; // this is the pixel array
        const transferSyntaxUID = dataSet.string('x00020010');
        const numberOfFrames = dataSet.intString('x00280008') || 1;

        if (!pixelData || !rows || !cols) {
            throw new Error('Missing DICOM data');
        }

        // detect compression from the transfer syntax itself, not from a pixel
        // data length mismatch — a multi-frame uncompressed file has
        // pixelData.length = singleFrameLength * NumberOfFrames, which used to
        // fail the length check and get mislabeled "compressed".
        if (transferSyntaxUID && !UNCOMPRESSED_TRANSFER_SYNTAXES.has(transferSyntaxUID)) {
            return "compressed";
        }

        const isPalette = samplesPerPixel === 1 && photometricInterpretation === 'PALETTE COLOR';
        // YBR_FULL_422 chroma-subsamples: every 2 pixels share one Cb/Cr pair,
        // so it only takes 2 bytes/pixel on average instead of 3 (PS3.5 8.2.1).
        const isSubsampled422 = samplesPerPixel === 3 && photometricInterpretation === 'YBR_FULL_422';
        const isFullColor = samplesPerPixel === 3 && !isSubsampled422; // RGB, YBR_FULL, etc.

        const bytesPerSample = Math.ceil(bitsAllocated / 8);
        const bytesPerPixel = isSubsampled422 ? 2 * bytesPerSample : samplesPerPixel * bytesPerSample;
        const singleFrameLength = rows * cols * bytesPerPixel;
        const expectedLength = singleFrameLength * numberOfFrames;

        if (expectedLength !== pixelData.length) {
            // transfer syntax says uncompressed, but the header doesn't
            // describe the data we actually got — a real problem, not
            // something to silently paper over as "compressed".
            throw new Error(`Pixel data length mismatch: expected ${expectedLength} bytes, got ${pixelData.length}`);
        }

        if (bitsAllocated > 16) {
            throw new Error(`Unsupported bit allocation: ${bitsAllocated}`);
        }

        // only the first frame is decoded for now; multi-frame navigation is
        // a Phase 2 feature
        const frameByteLength = Math.min(pixelData.length, singleFrameLength);
        const frameBytes: Uint8Array | Uint16Array | Int16Array = bitsAllocated <= 8
            ? new Uint8Array(dicomFile.buffer, dicomFile.byteOffset + pixelData.dataOffset, frameByteLength)
            : pixelRepresentation === 1
                ? new Int16Array(dicomFile.buffer, dicomFile.byteOffset + pixelData.dataOffset, Math.floor(frameByteLength / 2))
                : new Uint16Array(dicomFile.buffer, dicomFile.byteOffset + pixelData.dataOffset, Math.floor(frameByteLength / 2));

        // create PNG
        const png = new PNG({ width: cols, height: rows });
        const pixelCount = rows * cols;

        if (isPalette) {
            renderPaletteColor(png, dataSet, dicomFile, frameBytes, pixelCount);
        } else if (isFullColor) {
            renderFullColor(png, frameBytes as Uint8Array, pixelCount, samplesPerPixel, planarConfiguration, photometricInterpretation);
        } else if (isSubsampled422) {
            renderSubsampled422(png, frameBytes as Uint8Array, rows, cols);
        } else {
            renderGrayscale(png, frameBytes, pixelCount, pixelRepresentation, bitsStored, photometricInterpretation);
        }

        // convert PNG to base64
        const buffer = PNG.sync.write(png);
        return 'data:image/png;base64,' + buffer.toString('base64');

    } catch (error: unknown) {
        // never log the error object itself — dicom-parser errors can embed tag values.
        // dicom-parser sometimes throws plain strings rather than Error objects.
        const { type, message } = describeError(error);
        getLogger().error(`DICOM image conversion failed (${type})`);
        throw new Error(`Failed to convert DICOM: ${message}`);
    }
}

// MONOCHROME1/MONOCHROME2 — normalize to the actual min/max of the pixel
// data (Phase 2 will honor WindowCenter/WindowWidth instead).
function renderGrayscale(png: any, pixelArray: Uint8Array | Uint16Array | Int16Array, pixelCount: number, pixelRepresentation: number, bitsStored: number, photometricInterpretation: string) {
    let min = Number.MAX_SAFE_INTEGER;
    let max = Number.MIN_SAFE_INTEGER;
    const validPixelCount = Math.min(pixelArray.length, pixelCount);

    for (let i = 0; i < validPixelCount; i++) {
        const pixel = pixelArray[i];
        min = Math.min(min, pixel);
        max = Math.max(max, pixel);
    }

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
}

// RGB and YBR_FULL (non-subsampled) — one sample triplet per pixel, either
// interleaved (PlanarConfiguration 0, the default) or planar (1).
function renderFullColor(png: any, bytes: Uint8Array, pixelCount: number, samplesPerPixel: number, planarConfiguration: number, photometricInterpretation: string) {
    const isYbr = photometricInterpretation.startsWith('YBR');
    const validPixelCount = Math.min(pixelCount, Math.floor(bytes.length / samplesPerPixel));

    for (let i = 0; i < validPixelCount; i++) {
        let s0: number, s1: number, s2: number;
        if (planarConfiguration === 1) {
            // color-by-plane: all of sample 0, then all of sample 1, then sample 2
            s0 = bytes[i];
            s1 = bytes[pixelCount + i];
            s2 = bytes[2 * pixelCount + i];
        } else {
            // color-by-pixel (interleaved) — the default
            s0 = bytes[i * 3];
            s1 = bytes[i * 3 + 1];
            s2 = bytes[i * 3 + 2];
        }

        const [r, g, b] = isYbr ? ybrToRgb(s0, s1, s2) : [s0, s1, s2];
        writeRgbPixel(png, i, r, g, b);
    }
}

// YBR_FULL_422 — chroma-subsampled: every 2 horizontally adjacent pixels
// share one Cb/Cr pair, encoded as 4 bytes per pair: Y1, Y2, Cb, Cr
// (PS3.5 8.2.1). Always color-by-pixel; PlanarConfiguration doesn't apply.
function renderSubsampled422(png: any, bytes: Uint8Array, rows: number, cols: number) {
    const pairCols = Math.floor(cols / 2);
    for (let row = 0; row < rows; row++) {
        for (let pair = 0; pair < pairCols; pair++) {
            const byteIdx = (row * pairCols + pair) * 4;
            if (byteIdx + 3 >= bytes.length) {
                break;
            }
            const y1 = bytes[byteIdx];
            const y2 = bytes[byteIdx + 1];
            const cb = bytes[byteIdx + 2];
            const cr = bytes[byteIdx + 3];

            const col1 = pair * 2;
            const col2 = col1 + 1;
            const [r1, g1, b1] = ybrToRgb(y1, cb, cr);
            writeRgbPixel(png, row * cols + col1, r1, g1, b1);
            if (col2 < cols) {
                const [r2, g2, b2] = ybrToRgb(y2, cb, cr);
                writeRgbPixel(png, row * cols + col2, r2, g2, b2);
            }
        }
    }
}

// PALETTE COLOR — one sample per pixel, indexing into three 1:1 LUTs
// (0028,1101-1103 descriptors + 0028,1201-1203 data) to get RGB.
function renderPaletteColor(png: any, dataSet: dicomParser.DataSet, dicomFile: Buffer, indices: Uint8Array | Uint16Array | Int16Array, pixelCount: number) {
    const redLut = readPaletteLut(dataSet, dicomFile, 'x00281101', 'x00281201');
    const greenLut = readPaletteLut(dataSet, dicomFile, 'x00281102', 'x00281202');
    const blueLut = readPaletteLut(dataSet, dicomFile, 'x00281103', 'x00281203');

    if (!redLut || !greenLut || !blueLut) {
        throw new Error('PALETTE COLOR image is missing one or more LUT tables');
    }

    const firstInputValue = dataSet.uint16('x00281101', 1) || 0;
    const validPixelCount = Math.min(pixelCount, indices.length);

    for (let i = 0; i < validPixelCount; i++) {
        let lutIndex = indices[i] - firstInputValue;
        lutIndex = Math.max(0, Math.min(redLut.length - 1, lutIndex));

        const r = lutEntryToByte(redLut, lutIndex);
        const g = lutEntryToByte(greenLut, lutIndex);
        const b = lutEntryToByte(blueLut, lutIndex);
        writeRgbPixel(png, i, r, g, b);
    }
}

function readPaletteLut(dataSet: dicomParser.DataSet, dicomFile: Buffer, descriptorTag: string, dataTag: string): Uint8Array | Uint16Array | null {
    const descriptorElement = dataSet.elements[descriptorTag];
    const dataElement = dataSet.elements[dataTag];
    if (!descriptorElement || !dataElement) {
        return null;
    }

    // Descriptor is 3 values: [numberOfEntries, firstInputValue, bitsPerEntry].
    // numberOfEntries of 0 means 65536, per the DICOM standard.
    let numberOfEntries = dataSet.uint16(descriptorTag, 0) || 0;
    const bitsPerEntry = dataSet.uint16(descriptorTag, 2) || 8;
    if (numberOfEntries === 0) {
        numberOfEntries = 65536;
    }

    if (bitsPerEntry === 8) {
        return new Uint8Array(dicomFile.buffer, dicomFile.byteOffset + dataElement.dataOffset, Math.min(dataElement.length, numberOfEntries));
    } else {
        const count = Math.min(Math.floor(dataElement.length / 2), numberOfEntries);
        return new Uint16Array(dicomFile.buffer, dicomFile.byteOffset + dataElement.dataOffset, count);
    }
}

function lutEntryToByte(lut: Uint8Array | Uint16Array, index: number): number {
    // 16-bit LUT entries carry the significant value in the high byte
    return lut instanceof Uint8Array ? lut[index] : (lut[index] >> 8) & 0xff;
}

function writeRgbPixel(png: any, pixelIndex: number, r: number, g: number, b: number) {
    const idx = pixelIndex * 4;
    if (idx + 3 < png.data.length) {
        png.data[idx] = r;
        png.data[idx + 1] = g;
        png.data[idx + 2] = b;
        png.data[idx + 3] = 255;
    }
}

// ITU-R BT.601 full-range YCbCr -> RGB (DICOM PS3.5 uses this transform for
// YBR_FULL / YBR_FULL_422).
function ybrToRgb(y: number, cb: number, cr: number): [number, number, number] {
    const r = y + 1.402 * (cr - 128);
    const g = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
    const b = y + 1.772 * (cb - 128);
    return [clamp8(r), clamp8(g), clamp8(b)];
}

function clamp8(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value)));
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
    } catch (ex: unknown) {
        // never log the error object itself — dicom-parser errors can embed tag values
        getLogger().error(`DICOM metadata parse failed (${describeError(ex).type})`);
    }
    return metadata;
}

// @iwharris/dicom-data-dictionary stores some tag names pre-escaped as HTML
// (e.g. the literal string "Referring Physician&#x27;s Name" instead of
// "Referring Physician's Name" — likely scraped from an HTML source table).
// Our own HTML escaping then correctly escapes that stray "&", so the
// browser renders it back as literal "&#x27;" text instead of decoding it.
// Decode entities out of the name once here, at the source, so escapeHtml()
// only ever sees the real apostrophe.
const NAMED_HTML_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
};

function decodeHtmlEntities(text: string): string {
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity) => {
        if (entity[0] === '#') {
            const codePoint = entity[1] === 'x' || entity[1] === 'X'
                ? parseInt(entity.slice(2), 16)
                : parseInt(entity.slice(1), 10);
            return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
        }
        return NAMED_HTML_ENTITIES[entity] ?? match;
    });
}

function getTagInfo(tag: string, element: any, dictionary: any) {
    // get the info of the tag itself
    let tagName = 'Unknown';
    let vr = 'UN';
    let cleanTag = tag.replace('x', '').toUpperCase();

    try {
        const elem = dictionary.get_element(cleanTag);
        tagName = decodeHtmlEntities(elem["name"]);
        vr = elem["vr"];
    }
    catch {
        // ignore the error, it's just iwharris not finding the vr
    }

    // use the VR from the element if available, otherwise use our lookup
    const finalVr = normalizeVR(element.vr || vr);

    return {tagName, finalVr};
}

// binary numeric VRs — dataSet.string() doesn't work on these (they're not
// text), so reading them that way silently returns "[Empty]" or garbage.
// Each entry gives the per-value byte size and the dicom-parser accessor.
const NUMERIC_VR_READERS: Record<string, { size: number; read: (dataSet: dicomParser.DataSet, tag: string, index: number) => number | undefined }> = {
    US: { size: 2, read: (ds, tag, i) => ds.uint16(tag, i) },
    SS: { size: 2, read: (ds, tag, i) => ds.int16(tag, i) },
    UL: { size: 4, read: (ds, tag, i) => ds.uint32(tag, i) },
    SL: { size: 4, read: (ds, tag, i) => ds.int32(tag, i) },
    FL: { size: 4, read: (ds, tag, i) => ds.float(tag, i) },
    FD: { size: 8, read: (ds, tag, i) => ds.double(tag, i) },
};

function getNumericTagValue(dataSet: dicomParser.DataSet, tag: string, vr: string): string | undefined {
    if (vr === 'AT') {
        // dicom-parser's attributeTag() only reads a single value, no index
        return dataSet.attributeTag(tag);
    }

    const reader = NUMERIC_VR_READERS[vr];
    const element = dataSet.elements[tag];
    if (!reader || !element || !element.length) {
        return undefined;
    }

    const count = Math.max(1, Math.floor(element.length / reader.size));
    const values: string[] = [];
    for (let i = 0; i < count; i++) {
        const value = reader.read(dataSet, tag, i);
        if (value === undefined) {
            break;
        }
        values.push(String(value));
    }
    return values.length ? values.join('\\') : undefined;
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
    } else if (vr in NUMERIC_VR_READERS || vr === 'AT') {
        const numericValue = getNumericTagValue(dataSet, tag, vr);
        return numericValue !== undefined ? numericValue : '[Empty]';
    } else {
        // get string representation for text/numeric-string VRs (IS, DS, etc.)
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