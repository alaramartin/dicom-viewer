// Runs inside a worker_thread (spawned by src/imageDecodeWorker.ts on the
// extension host) so the actual pixel decode — parsing the file, running
// per-pixel color/windowing loops, and (for compressed syntaxes) the
// JPEG/RLE/WASM codecs — never blocks the extension host's main thread.
// Before this, a large CT/MR file could freeze the whole VS Code window for
// the duration of the decode.
//
// Deliberately thin: just bridges postMessage calls to the same
// convertDicomToBase64()/getGrayscaleImageData() functions the extension
// host used to call directly, so there's exactly one implementation of the
// actual decode logic, not two.
import { parentPort } from 'worker_threads';
import { convertDicomToBase64, getGrayscaleImageData } from './pixelDecode';
import { describeError } from './logger';

interface DecodeRequest {
    id: number;
    task: 'convertDicomToBase64' | 'getGrayscaleImageData';
    filepath: string;
    frameIndex: number;
}

if (!parentPort) {
    throw new Error('imageWorker must be run as a worker_thread, not required directly');
}

const port = parentPort;

port.on('message', async (message: DecodeRequest) => {
    try {
        let result: unknown;
        if (message.task === 'convertDicomToBase64') {
            result = await convertDicomToBase64(message.filepath, message.frameIndex);
        } else if (message.task === 'getGrayscaleImageData') {
            result = await getGrayscaleImageData(message.filepath, message.frameIndex);
        } else {
            throw new Error(`Unknown image decode task: ${message.task}`);
        }
        port.postMessage({ id: message.id, ok: true, result });
    } catch (error: unknown) {
        // never send the raw error object across — dicom-parser errors can
        // embed tag values, same rule as everywhere else this is handled.
        port.postMessage({ id: message.id, ok: false, error: describeError(error).message });
    }
});
