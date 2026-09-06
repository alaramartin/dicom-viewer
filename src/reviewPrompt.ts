import * as vscode from "vscode";

// A one-time-ever "enjoying this?" nudge. Fires once, after the user has
// opened a meaningful number of files across a meaningful number of
// sessions -- not on first use, which would just be annoying. Once shown
// (regardless of which button the user picks, or whether they ignore it
// entirely), it never fires again. All state lives in globalState, since
// this needs to persist across VS Code restarts and the extension
// currently has nowhere else it keeps state at all.

const FILES_OPENED_KEY = "dicomViewer.reviewPrompt.filesOpened";
const SESSION_COUNT_KEY = "dicomViewer.reviewPrompt.sessionCount";
const PROMPTED_KEY = "dicomViewer.reviewPrompt.prompted";

const FILES_OPENED_THRESHOLD = 10;
const SESSION_COUNT_THRESHOLD = 3;

const REVIEW_URL =
    "https://marketplace.visualstudio.com/items?itemName=alarm.dicom-viewer&ssr=false#review-details";

// Call once per activation (one per VS Code window/reload). Counts a
// "session" toward the ≥3-sessions requirement. Skipped once the prompt has
// already fired, since there's no reason to keep incrementing state nobody
// will ever read again.
export async function markReviewPromptSession(
    context: vscode.ExtensionContext,
): Promise<void> {
    if (context.globalState.get<boolean>(PROMPTED_KEY, false)) {
        return;
    }
    const count = context.globalState.get<number>(SESSION_COUNT_KEY, 0);
    await context.globalState.update(SESSION_COUNT_KEY, count + 1);
}

// Call once per DICOM file the user successfully opens (i.e. the file
// parsed -- not the "something went wrong" error path). Never awaited by
// its caller; this is a best-effort side channel and must never affect
// whether or how a file actually opens.
export async function notifyDicomFileOpened(
    context: vscode.ExtensionContext,
): Promise<void> {
    if (context.globalState.get<boolean>(PROMPTED_KEY, false)) {
        return;
    }

    const filesOpened =
        context.globalState.get<number>(FILES_OPENED_KEY, 0) + 1;
    await context.globalState.update(FILES_OPENED_KEY, filesOpened);

    const sessionCount = context.globalState.get<number>(
        SESSION_COUNT_KEY,
        0,
    );
    if (
        filesOpened < FILES_OPENED_THRESHOLD ||
        sessionCount < SESSION_COUNT_THRESHOLD
    ) {
        return;
    }

    // Mark as prompted *before* showing the message, not after the user
    // responds -- this is a once-ever trigger, so it must not re-arm just
    // because the user dismissed the toast without clicking a button.
    await context.globalState.update(PROMPTED_KEY, true);

    const choice = await vscode.window.showInformationMessage(
        "Enjoying DICOM Viewer & Editor? A quick rating helps a lot.",
        "Rate it",
        "No thanks",
    );
    if (choice === "Rate it") {
        await vscode.env.openExternal(vscode.Uri.parse(REVIEW_URL));
    }
}
