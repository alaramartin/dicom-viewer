import * as assert from "assert";
import * as vscode from "vscode";

import {
    markReviewPromptSession,
    notifyDicomFileOpened,
} from "../reviewPrompt";

// The thresholds the prompt actually ships with. Mirrored here on purpose:
// they aren't exported, and a test that reads them from the module under
// test can't notice if someone leaves a debugging value behind.
const FILES_OPENED_THRESHOLD = 10;
const SESSION_COUNT_THRESHOLD = 3;

const REVIEW_URL =
    "https://marketplace.visualstudio.com/items?itemName=alarm.dicom-viewer&ssr=false#review-details";

class FakeMemento implements vscode.Memento {
    private store = new Map<string, unknown>();

    keys(): readonly string[] {
        return [...this.store.keys()];
    }

    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
    }

    async update(key: string, value: unknown): Promise<void> {
        this.store.set(key, value);
    }

    setKeysForSync(): void {
        /* no-op */
    }
}

// Only globalState is ever touched, so a bare object is enough context.
function fakeContext(): vscode.ExtensionContext {
    return {
        globalState: new FakeMemento(),
    } as unknown as vscode.ExtensionContext;
}

// Captures every toast the code under test raises, and answers each one with
// `reply` (undefined models the user dismissing it with the X).
function stubToast(reply: string | undefined) {
    const shown: string[] = [];
    const original = vscode.window.showInformationMessage;
    (vscode.window as any).showInformationMessage = (
        message: string,
        ..._items: string[]
    ) => {
        shown.push(message);
        return Promise.resolve(reply);
    };
    return {
        shown,
        restore: () => {
            (vscode.window as any).showInformationMessage = original;
        },
    };
}

// vscode.env.openExternal is a plain property on the namespace object, but
// treat it as possibly read-only so a hardened runtime doesn't fail the run.
function stubOpenExternal() {
    const opened: string[] = [];
    const original = vscode.env.openExternal;
    let patched = true;
    try {
        (vscode.env as any).openExternal = (uri: vscode.Uri) => {
            // toString(true) — the default toString() percent-encodes "=" and
            // "&" in the query, which is a property of Uri's serializer, not
            // of the value handed to openExternal. Assert on the URL the code
            // actually asked for.
            opened.push(uri.toString(true));
            return Promise.resolve(true);
        };
    } catch {
        patched = false;
    }
    return {
        opened,
        patched,
        restore: () => {
            if (patched) {
                (vscode.env as any).openExternal = original;
            }
        },
    };
}

async function openFiles(
    context: vscode.ExtensionContext,
    count: number,
): Promise<void> {
    for (let i = 0; i < count; i++) {
        await notifyDicomFileOpened(context);
    }
}

async function runSessions(
    context: vscode.ExtensionContext,
    count: number,
): Promise<void> {
    for (let i = 0; i < count; i++) {
        await markReviewPromptSession(context);
    }
}

suite("review prompt", () => {
    test("stays quiet below the file threshold", async () => {
        const toast = stubToast("No thanks");
        try {
            const context = fakeContext();
            await runSessions(context, SESSION_COUNT_THRESHOLD + 5);
            await openFiles(context, FILES_OPENED_THRESHOLD - 1);
            assert.deepStrictEqual(toast.shown, []);
        } finally {
            toast.restore();
        }
    });

    test("stays quiet below the session threshold", async () => {
        const toast = stubToast("No thanks");
        try {
            const context = fakeContext();
            await runSessions(context, SESSION_COUNT_THRESHOLD - 1);
            await openFiles(context, FILES_OPENED_THRESHOLD + 5);
            assert.deepStrictEqual(toast.shown, []);
        } finally {
            toast.restore();
        }
    });

    test("fires on the file open that crosses both thresholds", async () => {
        const toast = stubToast("No thanks");
        try {
            const context = fakeContext();
            await runSessions(context, SESSION_COUNT_THRESHOLD);
            await openFiles(context, FILES_OPENED_THRESHOLD - 1);
            assert.deepStrictEqual(toast.shown, [], "fired one file early");

            await notifyDicomFileOpened(context);
            assert.strictEqual(toast.shown.length, 1);
            assert.match(toast.shown[0], /Enjoying DICOM Viewer/);
        } finally {
            toast.restore();
        }
    });

    test("never fires a second time, however many files follow", async () => {
        const toast = stubToast("No thanks");
        try {
            const context = fakeContext();
            await runSessions(context, SESSION_COUNT_THRESHOLD);
            await openFiles(context, FILES_OPENED_THRESHOLD + 25);
            assert.strictEqual(toast.shown.length, 1);
        } finally {
            toast.restore();
        }
    });

    test("dismissing with the X still burns the one-time flag", async () => {
        const toast = stubToast(undefined);
        try {
            const context = fakeContext();
            await runSessions(context, SESSION_COUNT_THRESHOLD);
            await openFiles(context, FILES_OPENED_THRESHOLD);
            assert.strictEqual(toast.shown.length, 1);

            // a later "session" plus more files must not re-arm it
            await runSessions(context, 5);
            await openFiles(context, FILES_OPENED_THRESHOLD);
            assert.strictEqual(toast.shown.length, 1);
        } finally {
            toast.restore();
        }
    });

    test("counters survive across simulated window reloads", async () => {
        const toast = stubToast("No thanks");
        try {
            // one shared globalState, three activations, files split across them
            const context = fakeContext();
            await markReviewPromptSession(context);
            await openFiles(context, 4);
            await markReviewPromptSession(context);
            await openFiles(context, 4);
            assert.deepStrictEqual(toast.shown, [], "fired on session 2");

            await markReviewPromptSession(context);
            await openFiles(context, 1);
            assert.deepStrictEqual(toast.shown, [], "fired at 9 files");

            await notifyDicomFileOpened(context);
            assert.strictEqual(toast.shown.length, 1);
        } finally {
            toast.restore();
        }
    });

    test("\"Rate it\" opens the marketplace review page", async function () {
        const toast = stubToast("Rate it");
        const external = stubOpenExternal();
        try {
            if (!external.patched) {
                this.skip();
            }
            const context = fakeContext();
            await runSessions(context, SESSION_COUNT_THRESHOLD);
            await openFiles(context, FILES_OPENED_THRESHOLD);
            assert.deepStrictEqual(external.opened, [REVIEW_URL]);
        } finally {
            external.restore();
            toast.restore();
        }
    });

    test("\"No thanks\" opens nothing", async function () {
        const toast = stubToast("No thanks");
        const external = stubOpenExternal();
        try {
            if (!external.patched) {
                this.skip();
            }
            const context = fakeContext();
            await runSessions(context, SESSION_COUNT_THRESHOLD);
            await openFiles(context, FILES_OPENED_THRESHOLD);
            assert.deepStrictEqual(external.opened, []);
        } finally {
            external.restore();
            toast.restore();
        }
    });

    test("session counter stops growing once the prompt has fired", async () => {
        const toast = stubToast("No thanks");
        try {
            const context = fakeContext();
            await runSessions(context, SESSION_COUNT_THRESHOLD);
            await openFiles(context, FILES_OPENED_THRESHOLD);
            const after = context.globalState.get<number>(
                "dicomViewer.reviewPrompt.sessionCount",
                0,
            );
            await runSessions(context, 10);
            assert.strictEqual(
                context.globalState.get<number>(
                    "dicomViewer.reviewPrompt.sessionCount",
                    0,
                ),
                after,
            );
        } finally {
            toast.restore();
        }
    });
});
