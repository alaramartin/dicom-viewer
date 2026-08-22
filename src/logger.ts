// Single shared output channel for the extension. DICOM parse/save errors can
// embed tag values, which can be patient data — callers must log error
// *type* and tag *number* only, never tag values, filenames, or paths.
//
// This module is also loaded inside the worker_thread that does the heavy
// pixel-decoding work (see src/imageWorker.ts) — getImage.ts's internal
// error handling calls getLogger() regardless of which thread it's running
// on. 'vscode' only resolves in the real extension host, so the require
// below is lazy and falls back to a no-op logger when it fails, rather than
// throwing and taking down the decode. Nothing here is more than a
// best-effort diagnostic; the extension host's own catch blocks (in
// extension.ts) do the real user-facing logging for anything that crosses
// back over the worker boundary.
interface Logger {
    error(message: string): void;
}

let channel: Logger | undefined;

export function getLogger(): Logger {
    if (!channel) {
        let created: Logger;
        try {
            const vscode = require('vscode');
            created = vscode.window.createOutputChannel('DICOM Viewer', { log: true });
        } catch {
            created = { error: () => {} };
        }
        channel = created;
    }
    return channel;
}

// dicom-parser (and other deps) sometimes throw plain strings instead of
// Error objects, so `error.message` can be `undefined`. Normalize either
// shape into a safe {type, message} pair for logging/rethrowing.
export function describeError(error: unknown): { type: string; message: string } {
    if (error instanceof Error) {
        return { type: error.name || 'Error', message: error.message || 'Unknown error' };
    }
    return { type: typeof error, message: String(error) };
}
