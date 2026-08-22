// Extension-host-side handle to one src/imageWorker.ts worker_thread. One
// instance is spawned per open DICOM document (see extension.ts) and
// terminated when that document's tab closes — bounded lifetime, no shared
// pool to reason about, and a crash in one file's decode can't affect
// another open file.
import { Worker } from 'worker_threads';
import type { GrayscaleImageData } from './pixelDecode';

interface PendingCall {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

export class ImageDecodeWorker {
    private worker: Worker;
    private nextId = 1;
    private pending = new Map<number, PendingCall>();
    private disposed = false;

    constructor(workerScriptPath: string) {
        this.worker = new Worker(workerScriptPath);

        this.worker.on('message', (message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
            const call = this.pending.get(message.id);
            if (!call) {
                return;
            }
            this.pending.delete(message.id);
            if (message.ok) {
                call.resolve(message.result);
            } else {
                call.reject(new Error(message.error || 'Image decode failed'));
            }
        });

        // a crash inside the worker (as opposed to a caught decode error,
        // which arrives as a normal { ok: false } message above) — reject
        // everything still in flight rather than hanging forever.
        this.worker.on('error', (error) => {
            for (const call of this.pending.values()) {
                call.reject(error);
            }
            this.pending.clear();
        });
    }

    private call<T>(task: string, filepath: string, frameIndex: number): Promise<T> {
        if (this.disposed) {
            return Promise.reject(new Error('Image decode worker has been disposed'));
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
            this.worker.postMessage({ id, task, filepath, frameIndex });
        });
    }

    convertDicomToBase64(filepath: string, frameIndex: number = 0): Promise<string> {
        return this.call('convertDicomToBase64', filepath, frameIndex);
    }

    getGrayscaleImageData(filepath: string, frameIndex: number = 0): Promise<GrayscaleImageData | null> {
        return this.call('getGrayscaleImageData', filepath, frameIndex);
    }

    dispose(): void {
        this.disposed = true;
        for (const call of this.pending.values()) {
            call.reject(new Error('Image decode worker was disposed'));
        }
        this.pending.clear();
        void this.worker.terminate();
    }
}
