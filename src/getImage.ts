import * as dicomParser from 'dicom-parser';
import * as fs from 'fs';
import * as jpeg from 'jpeg-js';
import * as jpegLossless from 'jpeg-lossless-decoder-js';
import { PNG } from 'pngjs';
import { getLogger, describeError } from './logger';

// Transfer syntaxes that carry raw, uncompressed pixel data.
const UNCOMPRESSED_TRANSFER_SYNTAXES = new Set([
    '1.2.840.10008.1.2',   // Implicit VR Little Endian
    '1.2.840.10008.1.2.1', // Explicit VR Little Endian
    '1.2.840.10008.1.2.2', // Explicit VR Big Endian (retired)
]);

// Compressed transfer syntaxes we can decode ourselves. RLE/JPEG Baseline/
// JPEG Lossless are pure JS (see the render functions below). JPEG-LS and
// JPEG 2000 use Cornerstone's WASM codecs (@cornerstonejs/codec-charls,
// -codec-openjpeg) — self-contained decode-only builds with the .wasm
// inlined as base64 in the JS glue, so no extra asset-copy build step is
// needed, but their module factories are async, which is why this function
// is async. An earlier pure-JS JPEG 2000 decoder was evaluated and rejected
// because it silently clamped output to 8 bits regardless of source
// precision; these WASM builds report true per-file bit depth via
// getFrameInfo() and don't have that problem.
// Anything still outside this set falls back to the read-only "compressed" path.
const RLE_TRANSFER_SYNTAX = '1.2.840.10008.1.2.5';
const JPEG_BASELINE_TRANSFER_SYNTAX = '1.2.840.10008.1.2.4.50'; // JPEG Baseline (Process 1), 8-bit only
// JPEG Extended (Process 2 & 4) can carry either 8-bit or 12-bit samples.
// jpeg-js (used for Baseline above) hardcodes 8-bit output — no 12-bit JPEG
// decoder exists in the npm ecosystem at all, confirmed by checking
// Cornerstone's own reference codec set (@cornerstonejs/dicom-codec), which
// only ships an "-8bit" libjpeg-turbo build. So this transfer syntax is only
// safe to decode when the embedded codestream (not just the DICOM header)
// says 8-bit; see readJpegPrecision() and its call site below. 12-bit files
// fall back to the read-only "compressed" path rather than being truncated.
const JPEG_EXTENDED_TRANSFER_SYNTAX = '1.2.840.10008.1.2.4.51';
const JPEG_LOSSLESS_TRANSFER_SYNTAXES = new Set([
    '1.2.840.10008.1.2.4.57', // JPEG Lossless, Non-Hierarchical (Process 14)
    '1.2.840.10008.1.2.4.70', // JPEG Lossless, Non-Hierarchical, First-Order Prediction (Process 14 [SV1])
]);
const JPEG_LS_TRANSFER_SYNTAXES = new Set([
    '1.2.840.10008.1.2.4.80', // JPEG-LS Lossless
    '1.2.840.10008.1.2.4.81', // JPEG-LS Lossy (Near-Lossless)
]);
const JPEG_2000_TRANSFER_SYNTAXES = new Set([
    '1.2.840.10008.1.2.4.90', // JPEG 2000 Lossless Only
    '1.2.840.10008.1.2.4.91', // JPEG 2000 (lossy allowed)
]);
const SUPPORTED_COMPRESSED_TRANSFER_SYNTAXES = new Set([
    RLE_TRANSFER_SYNTAX,
    JPEG_BASELINE_TRANSFER_SYNTAX,
    JPEG_EXTENDED_TRANSFER_SYNTAX,
    ...JPEG_LOSSLESS_TRANSFER_SYNTAXES,
    ...JPEG_LS_TRANSFER_SYNTAXES,
    ...JPEG_2000_TRANSFER_SYNTAXES,
]);

// The WASM codec module factories (from the packages' "/decode" subpath
// exports) are plain CJS functions with no shipped types, same story as
// jpeg-lossless-decoder-js — loaded via require() rather than import, and
// instantiated (async) once per extension host lifetime, then reused, since
// each instantiation compiles a WASM module.
let openjpegModulePromise: Promise<any> | undefined;
function getOpenJpegModule(): Promise<any> {
    if (!openjpegModulePromise) {
        const factory = require('@cornerstonejs/codec-openjpeg/decode');
        openjpegModulePromise = factory();
    }
    return openjpegModulePromise as Promise<any>;
}

let charlsModulePromise: Promise<any> | undefined;
function getCharlsModule(): Promise<any> {
    if (!charlsModulePromise) {
        const factory = require('@cornerstonejs/codec-charls/decode');
        charlsModulePromise = factory();
    }
    return charlsModulePromise as Promise<any>;
}

export async function convertDicomToBase64(filepath: string): Promise<string> {
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
        const isUncompressed = !transferSyntaxUID || UNCOMPRESSED_TRANSFER_SYNTAXES.has(transferSyntaxUID);
        const isSupportedCompressed = !!transferSyntaxUID && SUPPORTED_COMPRESSED_TRANSFER_SYNTAXES.has(transferSyntaxUID);
        if (!isUncompressed && !isSupportedCompressed) {
            return "compressed";
        }

        let png: any;

        if (isSupportedCompressed) {
            // only the first frame is decoded for now; multi-frame
            // navigation is a separate Phase 2 feature
            const compressedFrame = getEncapsulatedFrameBytes(dataSet, pixelData, 0);
            if (transferSyntaxUID === JPEG_BASELINE_TRANSFER_SYNTAX) {
                png = renderJpegBaselineFrame(compressedFrame, samplesPerPixel);
            } else if (transferSyntaxUID === JPEG_EXTENDED_TRANSFER_SYNTAX) {
                // only 8-bit JPEG Extended is decodable (see the constant's
                // comment above) — bail out to the same "compressed" fallback
                // used for genuinely unsupported syntaxes rather than risk
                // truncating a 12-bit file.
                if (readJpegPrecision(compressedFrame) !== 8) {
                    return "compressed";
                }
                png = renderJpegBaselineFrame(compressedFrame, samplesPerPixel);
            } else if (transferSyntaxUID && JPEG_LOSSLESS_TRANSFER_SYNTAXES.has(transferSyntaxUID)) {
                png = renderJpegLosslessFrame(compressedFrame, pixelRepresentation, photometricInterpretation);
            } else if (transferSyntaxUID && JPEG_LS_TRANSFER_SYNTAXES.has(transferSyntaxUID)) {
                png = await renderJpegLSFrame(compressedFrame, pixelRepresentation);
            } else if (transferSyntaxUID && JPEG_2000_TRANSFER_SYNTAXES.has(transferSyntaxUID)) {
                png = await renderJpeg2000Frame(compressedFrame, pixelRepresentation);
            } else {
                png = renderRleFrame(compressedFrame, dataSet, dicomFile, rows, cols, samplesPerPixel, bitsAllocated, bitsStored, pixelRepresentation, photometricInterpretation);
            }
        } else {
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
            png = new PNG({ width: cols, height: rows });
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

// Pulls the compressed bytes for one frame out of encapsulated pixel data
// (fragments framed by DICOM item tags, per PS3.5 A.4). Most encoders write
// a Basic Offset Table mapping frame index -> fragment, which dicom-parser
// already parses during parseDicom(); a few omit it (it's optional), in
// which case we fall back to treating every fragment as belonging to the
// single frame — correct for single-frame files, which covers the common
// case since multi-frame decoding isn't implemented yet regardless.
function getEncapsulatedFrameBytes(dataSet: dicomParser.DataSet, pixelDataElement: any, frameIndex: number): Uint8Array {
    const basicOffsetTable: number[] | undefined = pixelDataElement.basicOffsetTable;
    const fragments: Array<{ offset: number; position: number; length: number }> | undefined = pixelDataElement.fragments;

    if (!fragments || fragments.length === 0) {
        throw new Error('Encapsulated pixel data has no fragments');
    }

    if (basicOffsetTable && basicOffsetTable.length > 0) {
        return dicomParser.readEncapsulatedImageFrame(dataSet, pixelDataElement, frameIndex);
    }

    if (frameIndex === 0) {
        return dicomParser.readEncapsulatedPixelDataFromFragments(dataSet, pixelDataElement, 0, fragments.length, fragments);
    }

    throw new Error('Encapsulated pixel data has no Basic Offset Table and more than one frame — cannot locate frame boundaries');
}

// Reads the sample precision straight out of a raw JPEG codestream's
// Start-Of-Frame marker (SOF0-SOF15, except the DHT/JPG/DAC marker codes
// that share the 0xC0-0xCF range), without doing a full JPEG parse. Used to
// gate JPEG Extended decoding to the 8-bit case jpeg-js can actually handle
// correctly — see JPEG_EXTENDED_TRANSFER_SYNTAX's comment above.
function readJpegPrecision(bytes: Uint8Array): number | undefined {
    if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
        return undefined; // missing Start Of Image marker — not a JPEG stream
    }

    let i = 2;
    while (i + 4 <= bytes.length) {
        if (bytes[i] !== 0xFF) {
            i++;
            continue;
        }
        const marker = bytes[i + 1];
        // markers with no length/payload — skip past just the marker itself
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) {
            i += 2;
            continue;
        }
        const length = (bytes[i + 2] << 8) | bytes[i + 3];
        const isSofMarker = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
        if (isSofMarker) {
            return i + 4 < bytes.length ? bytes[i + 4] : undefined; // precision byte follows the length field
        }
        if (marker === 0xDA) {
            return undefined; // hit Start Of Scan without finding a SOF marker
        }
        i += 2 + length;
    }
    return undefined;
}

// JPEG Baseline (Process 1, transfer syntax 1.2.840.10008.1.2.4.50) — 8-bit
// only. jpeg-js performs the YCbCr->RGB color transform internally as part
// of standard JPEG decoding, so its output is already RGB regardless of
// what PhotometricInterpretation claims about the pre-compression source
// data (e.g. YBR_FULL_422) — that tag describes the encoder's input, not
// the decoder's output.
function renderJpegBaselineFrame(compressedFrame: Uint8Array, samplesPerPixel: number): any {
    let decoded;
    try {
        decoded = jpeg.decode(compressedFrame, { useTArray: true, formatAsRGBA: false, tolerantDecoding: true });
    } catch {
        throw new Error('Failed to decode JPEG Baseline pixel data');
    }

    const { width, height, data } = decoded; // always 3 interleaved bytes/pixel (formatAsRGBA: false)
    const png = new PNG({ width, height });
    const pixelCount = width * height;

    if (samplesPerPixel === 1) {
        // grayscale JPEG: jpeg-js replicates the single luma component into
        // R/G/B, so any channel already holds the correct 0-255 gray value
        for (let i = 0; i < pixelCount; i++) {
            const gray = data[i * 3];
            writeRgbPixel(png, i, gray, gray, gray);
        }
    } else {
        for (let i = 0; i < pixelCount; i++) {
            const idx = i * 3;
            writeRgbPixel(png, i, data[idx], data[idx + 1], data[idx + 2]);
        }
    }

    return png;
}

// JPEG Lossless, Process 14 / Process 14 SV1 (transfer syntaxes ...4.57 /
// ...4.70). Predictive coding, not DCT-based — no color transform, and no
// quantization, so (unlike JPEG Baseline/JPEG 2000) samples decode back to
// their exact original values at whatever bit depth the file used, up to
// 16-bit. jpeg-lossless-decoder-js derives width/height/component count/bit
// depth from the JPEG stream itself, same trust-the-codestream approach as
// the Baseline path above.
function renderJpegLosslessFrame(compressedFrame: Uint8Array, pixelRepresentation: number, photometricInterpretation: string): any {
    const decoder = new jpegLossless.Decoder();
    const arrayBuffer = compressedFrame.buffer.slice(compressedFrame.byteOffset, compressedFrame.byteOffset + compressedFrame.length);

    let outputData: Uint8Array | Uint16Array;
    try {
        outputData = decoder.decode(arrayBuffer, 0, arrayBuffer.byteLength);
    } catch {
        throw new Error('Failed to decode JPEG Lossless pixel data');
    }

    const { xDim: width, yDim: height, numComp, precision } = decoder;
    if (precision > 16) {
        throw new Error(`Unsupported JPEG Lossless precision: ${precision}`);
    }

    const png = new PNG({ width, height });
    const pixelCount = width * height;

    if (numComp === 3) {
        // interleaved RGB (index*3 + component) — see setValueRGB in the
        // decoder. A reversible color transform is possible in principle,
        // so still respect PhotometricInterpretation the same way the
        // uncompressed path does.
        const isYbr = photometricInterpretation.startsWith('YBR');
        for (let i = 0; i < pixelCount; i++) {
            const idx = i * 3;
            const s0 = outputData[idx], s1 = outputData[idx + 1], s2 = outputData[idx + 2];
            const [r, g, b] = isYbr ? ybrToRgb(s0, s1, s2) : [s0, s1, s2];
            writeRgbPixel(png, i, r, g, b);
        }
    } else {
        let pixels: Uint8Array | Uint16Array | Int16Array = outputData;
        if (pixelRepresentation === 1 && outputData instanceof Uint16Array) {
            const signed = new Int16Array(pixelCount);
            for (let i = 0; i < pixelCount; i++) {
                signed[i] = (outputData[i] << 16) >> 16; // sign-extend from 16 bits
            }
            pixels = signed;
        }
        renderGrayscale(png, pixels, pixelCount, pixelRepresentation, precision, photometricInterpretation);
    }

    return png;
}

// Shared decode step for both WASM codecs below — they expose the same
// embind API shape (getEncodedBuffer/decode/getFrameInfo/getDecodedBuffer),
// just under different class names. getDecodedBuffer() returns a
// Uint8ClampedArray, but that's just a generic byte view into the WASM
// heap — frameInfo.bitsPerSample tells us the *actual* sample width, so
// >8-bit output is reinterpreted into a proper Uint16Array below rather
// than truncated.
interface DecodedFrame {
    width: number;
    height: number;
    componentCount: number;
    bitsPerSample: number;
    isSigned?: boolean;
    pixels: Uint8Array | Uint16Array;
}

function decodeWithEmbindCodec(module: any, DecoderCtor: new () => any, compressedFrame: Uint8Array): DecodedFrame {
    const decoder = new DecoderCtor();
    try {
        const encodedBuffer = decoder.getEncodedBuffer(compressedFrame.length);
        encodedBuffer.set(compressedFrame);
        decoder.decode();

        const frameInfo = decoder.getFrameInfo();
        const decoded: Uint8Array = decoder.getDecodedBuffer();
        const pixelCount = frameInfo.width * frameInfo.height * frameInfo.componentCount;

        const pixels = frameInfo.bitsPerSample > 8
            ? new Uint16Array(decoded.buffer, decoded.byteOffset, pixelCount)
            : new Uint8Array(decoded.buffer, decoded.byteOffset, pixelCount);

        return {
            width: frameInfo.width,
            height: frameInfo.height,
            componentCount: frameInfo.componentCount,
            bitsPerSample: frameInfo.bitsPerSample,
            isSigned: frameInfo.isSigned,
            pixels,
        };
    } finally {
        // embind instances hold WASM heap memory (RAII) — must be released
        // explicitly, JS garbage collection won't do it.
        decoder.delete?.();
    }
}

// Writes a decoded WASM-codec frame (grayscale or interleaved-RGB, already
// resolved to the right typed array width) into a PNG, reusing the same
// renderers the other compressed paths use.
function renderDecodedFrame(frame: DecodedFrame, pixelRepresentation: number, photometricInterpretation: string): any {
    const png = new PNG({ width: frame.width, height: frame.height });
    const pixelCount = frame.width * frame.height;

    if (frame.componentCount === 3) {
        for (let i = 0; i < pixelCount; i++) {
            const idx = i * 3;
            writeRgbPixel(png, i, frame.pixels[idx], frame.pixels[idx + 1], frame.pixels[idx + 2]);
        }
        return png;
    }

    // grayscale — the codec's own isSigned (when it reports one) takes
    // priority over the DICOM header's PixelRepresentation, since it
    // reflects what's actually embedded in the codestream.
    const isSigned = frame.isSigned ?? (pixelRepresentation === 1);
    let pixels: Uint8Array | Uint16Array | Int16Array = frame.pixels;
    if (isSigned && frame.pixels instanceof Uint16Array) {
        const signed = new Int16Array(pixelCount);
        for (let i = 0; i < pixelCount; i++) {
            signed[i] = (frame.pixels[i] << 16) >> 16; // sign-extend from 16 bits
        }
        pixels = signed;
    }
    renderGrayscale(png, pixels, pixelCount, isSigned ? 1 : 0, frame.bitsPerSample, photometricInterpretation);
    return png;
}

// JPEG 2000 (transfer syntaxes ...4.90 lossless-only / ...4.91 lossy-allowed)
// via @cornerstonejs/codec-openjpeg's WASM build of OpenJPEG.
async function renderJpeg2000Frame(compressedFrame: Uint8Array, pixelRepresentation: number): Promise<any> {
    let openjpeg;
    try {
        openjpeg = await getOpenJpegModule();
    } catch {
        throw new Error('Failed to load the JPEG 2000 decoder');
    }

    let frame: DecodedFrame;
    try {
        frame = decodeWithEmbindCodec(openjpeg, openjpeg.J2KDecoder, compressedFrame);
    } catch {
        throw new Error('Failed to decode JPEG 2000 pixel data');
    }

    // J2K's internal color transform (when present) is applied by the
    // decoder itself, so 3-component output is already RGB — no separate
    // YCbCr conversion needed here, same as the JPEG Baseline path.
    return renderDecodedFrame(frame, pixelRepresentation, 'RGB');
}

// JPEG-LS (transfer syntaxes ...4.80 lossless / ...4.81 near-lossless) via
// @cornerstonejs/codec-charls's WASM build of CharLS.
async function renderJpegLSFrame(compressedFrame: Uint8Array, pixelRepresentation: number): Promise<any> {
    let charls;
    try {
        charls = await getCharlsModule();
    } catch {
        throw new Error('Failed to load the JPEG-LS decoder');
    }

    let frame: DecodedFrame;
    try {
        frame = decodeWithEmbindCodec(charls, charls.JpegLSDecoder, compressedFrame);
    } catch {
        throw new Error('Failed to decode JPEG-LS pixel data');
    }

    return renderDecodedFrame(frame, pixelRepresentation, 'RGB');
}

// RLE Lossless (transfer syntax 1.2.840.10008.1.2.5, PS3.5 Annex G). The
// frame is split into up to 15 byte-plane "segments" (one per sample per
// byte, most-significant byte first for >8-bit samples), each independently
// run-length encoded, preceded by a 64-byte header of 4-byte LE offsets.
function renderRleFrame(compressedFrame: Uint8Array, dataSet: dicomParser.DataSet, dicomFile: Buffer, rows: number, cols: number, samplesPerPixel: number, bitsAllocated: number, bitsStored: number, pixelRepresentation: number, photometricInterpretation: string): any {
    if (bitsAllocated > 16) {
        throw new Error(`Unsupported bit allocation for RLE: ${bitsAllocated}`);
    }

    const bytesPerSample = Math.ceil(bitsAllocated / 8);
    const pixelCount = rows * cols;
    const expectedSegments = samplesPerPixel * bytesPerSample;
    const segments = decodeRLESegments(compressedFrame, pixelCount);

    if (segments.length < expectedSegments) {
        throw new Error(`RLE frame has ${segments.length} segment(s), expected ${expectedSegments} for ${samplesPerPixel} sample(s) at ${bitsAllocated}-bit`);
    }

    const png = new PNG({ width: cols, height: rows });
    const isPalette = samplesPerPixel === 1 && photometricInterpretation.toUpperCase() === 'PALETTE COLOR';

    if (isPalette) {
        const indices = combineRleSampleBytes(segments, 0, bytesPerSample, pixelCount, 0, bitsStored);
        renderPaletteColor(png, dataSet, dicomFile, indices, pixelCount);
    } else if (samplesPerPixel === 1) {
        const pixels = combineRleSampleBytes(segments, 0, bytesPerSample, pixelCount, pixelRepresentation, bitsStored);
        renderGrayscale(png, pixels, pixelCount, pixelRepresentation, bitsStored, photometricInterpretation);
    } else if (samplesPerPixel === 3 && bytesPerSample === 1) {
        // RLE decompression is always planar-by-sample, regardless of the
        // file's PlanarConfiguration tag — reuse renderFullColor's planar
        // path (all of sample 0, then sample 1, then sample 2).
        const bytes = new Uint8Array(pixelCount * 3);
        bytes.set(segments[0], 0);
        bytes.set(segments[1], pixelCount);
        bytes.set(segments[2], pixelCount * 2);
        renderFullColor(png, bytes, pixelCount, 3, 1, photometricInterpretation);
    } else {
        throw new Error(`Unsupported RLE pixel layout: ${samplesPerPixel} sample(s) at ${bitsAllocated}-bit`);
    }

    return png;
}

// Combines the 1 or 2 byte-plane segments for one sample into a pixel array,
// matching the typed-array conventions renderGrayscale/renderPaletteColor
// already expect from the uncompressed path.
function combineRleSampleBytes(segments: Uint8Array[], sampleIndex: number, bytesPerSample: number, pixelCount: number, pixelRepresentation: number, bitsStored: number): Uint8Array | Uint16Array | Int16Array {
    if (bytesPerSample === 1) {
        return segments[sampleIndex];
    }

    // 16-bit: segment[2n] is the most-significant byte plane, segment[2n+1]
    // is the least-significant byte plane (PS3.5 G.2).
    const msb = segments[sampleIndex * 2];
    const lsb = segments[sampleIndex * 2 + 1];

    if (pixelRepresentation === 1) {
        const out = new Int16Array(pixelCount);
        for (let i = 0; i < pixelCount; i++) {
            const combined = (msb[i] << 8) | lsb[i];
            out[i] = (combined << 16) >> 16; // sign-extend from 16 bits
        }
        return out;
    }

    const out = new Uint16Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
        out[i] = (msb[i] << 8) | lsb[i];
    }
    return out;
}

function decodeRLESegments(compressed: Uint8Array, expectedSegmentLength: number): Uint8Array[] {
    if (compressed.length < 64) {
        throw new Error('RLE frame is too short to contain a segment header');
    }

    const view = new DataView(compressed.buffer, compressed.byteOffset, compressed.length);
    const numSegments = view.getUint32(0, true);
    if (numSegments < 1 || numSegments > 15) {
        throw new Error(`RLE segment header declares an invalid segment count: ${numSegments}`);
    }

    const offsets: number[] = [];
    for (let i = 0; i < numSegments; i++) {
        offsets.push(view.getUint32((i + 1) * 4, true));
    }

    const segments: Uint8Array[] = [];
    for (let s = 0; s < numSegments; s++) {
        const start = offsets[s];
        const end = s + 1 < numSegments ? offsets[s + 1] : compressed.length;
        if (start > end || end > compressed.length) {
            throw new Error(`RLE segment ${s} has an invalid offset`);
        }
        segments.push(decodeRLESegment(compressed.subarray(start, end), expectedSegmentLength));
    }
    return segments;
}

// PS3.5 Annex G control-byte scheme: 0..127 -> copy (n+1) literal bytes;
// 129..255 -> repeat the next byte (257-n) times; 128 -> no-op.
function decodeRLESegment(encoded: Uint8Array, expectedLength: number): Uint8Array {
    const out = new Uint8Array(expectedLength);
    let outPos = 0;
    let i = 0;

    while (i < encoded.length && outPos < expectedLength) {
        const control = encoded[i++];
        if (control <= 127) {
            const count = control + 1;
            for (let n = 0; n < count && i < encoded.length && outPos < expectedLength; n++) {
                out[outPos++] = encoded[i++];
            }
        } else if (control > 128) {
            const count = 257 - control;
            if (i < encoded.length) {
                const value = encoded[i++];
                for (let n = 0; n < count && outPos < expectedLength; n++) {
                    out[outPos++] = value;
                }
            }
        }
        // control === 128 is defined as a no-op
    }

    return out;
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