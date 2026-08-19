import * as vscode from 'vscode';

// Single shared output channel for the extension. DICOM parse/save errors can
// embed tag values, which can be patient data — callers must log error
// *type* and tag *number* only, never tag values, filenames, or paths.
let channel: vscode.LogOutputChannel | undefined;

export function getLogger(): vscode.LogOutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('DICOM Viewer', { log: true });
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
