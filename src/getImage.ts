// Metadata-table logic plus the cheap NumberOfFrames header read. This
// stays lightweight on purpose — it's imported directly by extension.ts (and
// so bundled into dist/extension.js), unlike the heavy pixel-decoding logic
// in src/pixelDecode.ts, which only runs inside the worker_thread in
// src/imageWorker.ts. See pixelDecode.ts's file header for the full reasoning.
import * as dicomParser from 'dicom-parser';
import * as fs from 'fs';
import { getLogger, describeError } from './logger';

// Cheap header-only read of NumberOfFrames (0028,0008) — used by the
// extension host to decide whether to show frame-navigation UI at all,
// without paying for a full pixel decode.
export function getNumberOfFrames(filepath: string): number {
    try {
        const dicomFile = fs.readFileSync(filepath);
        const dataSet = dicomParser.parseDicom(dicomFile);
        return dataSet.intString('x00280008') || 1;
    } catch {
        return 1;
    }
}

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
