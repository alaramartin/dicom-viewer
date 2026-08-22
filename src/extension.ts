import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { getMetadata, getNumberOfFrames } from "./getImage";
import { ImageDecodeWorker } from "./imageDecodeWorker";
import { saveDicomEdits } from "./editDicom";
import { getLogger, describeError } from "./logger";

// State the Command Palette commands below need for whichever DICOM editor
// tab is currently focused. One entry per open document, added when its
// image panel is created and removed when that panel is disposed (see
// resolveCustomEditor). Kept as a Map (not a single "current" variable)
// since more than one DICOM file can be open in different tabs at once —
// commands always act on whichever one is actually active right now.
interface DocumentState {
    filepath: string;
    imagePanel: vscode.WebviewPanel;
    getMetadata: () => Array<any>;
    toggleMetadataPanel: () => void;
}

// escape a value for safe interpolation into HTML text/attribute content.
// DICOM tag values come from the file itself and are not trustworthy input.
function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function getNonce(): string {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let nonce = "";
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}

class DICOMEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
    public static register(
        context: vscode.ExtensionContext,
    ): { provider: DICOMEditorProvider; disposable: vscode.Disposable } {
        const provider = new DICOMEditorProvider(context);
        const disposable = vscode.window.registerCustomEditorProvider(
            DICOMEditorProvider.viewType,
            provider,
            {
                supportsMultipleEditorsPerDocument: false,
            },
        );
        return { provider, disposable };
    }

    private static readonly viewType = "dicomViewer.dcm";

    // keyed by document.uri.toString() — see DocumentState above.
    private readonly documents = new Map<string, DocumentState>();

    // the Command Palette commands act on whichever DICOM editor tab is
    // actually focused right now, not just "the most recently opened one".
    // WebviewPanel#active reflects real-time focus, so this needs no
    // separate bookkeeping to stay correct as the user switches tabs.
    private getActiveDocument(): DocumentState | undefined {
        for (const state of this.documents.values()) {
            if (state.imagePanel.active) {
                return state;
            }
        }
        return undefined;
    }

    // Path to the bundled worker_thread script (see src/imageWorker.ts and
    // build/esbuild.mjs, which produces this alongside dist/extension.js).
    // Node's Worker constructor needs a real filesystem path, not a webview
    // URI, so this uses .fsPath rather than webview.asWebviewUri().
    private readonly workerScriptPath: string;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.workerScriptPath = vscode.Uri.joinPath(
            context.extensionUri,
            "dist",
            "imageWorker.js",
        ).fsPath;
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        imagePanel: vscode.WebviewPanel,
        token: vscode.CancellationToken,
    ): Promise<void> {
        let filepath = document.uri.fsPath;
        let isCompressed = false;
        if (filepath.includes(".dcm")) {
            imagePanel.webview.options = {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, "media"),
                ],
            };

            // all pixel decoding (parsing, per-pixel color/windowing loops,
            // and the JPEG/RLE/WASM codecs for compressed syntaxes) runs in
            // this worker_thread rather than on the extension host's main
            // thread — a large CT/MR file used to freeze the whole VS Code
            // window for the duration of the decode. One worker per open
            // document, terminated when its tab closes (see onDidDispose
            // below).
            const decodeWorker = new ImageDecodeWorker(this.workerScriptPath);

            // get the image in base64 and display in webview
            let base64Image: string;
            try {
                base64Image = await decodeWorker.convertDicomToBase64(filepath);
            } catch (e) {
                // never log the error object itself — it can embed tag values
                getLogger().error(
                    `DICOM image conversion failed (${describeError(e).type})`,
                );
                // an uncaught throw here rejects resolveCustomEditor's promise
                // and crashes the editor tab, so fall through to the
                // "something went wrong" page instead.
                base64Image = "";
            }
            if (base64Image === "compressed") {
                imagePanel.webview.html = this.getCompressedImageFailedContent(
                    imagePanel.webview,
                );
                isCompressed = true;
            } else if (base64Image === "no-image") {
                // not a decode failure — this file genuinely has no
                // PixelData/Rows/Columns at all (e.g. a metadata-only OT/SR
                // object). isCompressed deliberately stays false: there's no
                // compressed-transfer-syntax reason to block editing the
                // metadata, which is likely the whole point of a file like this.
                imagePanel.webview.html = this.getNoImageContent(
                    imagePanel.webview,
                );
            } else {
                const imageScriptUri = imagePanel.webview.asWebviewUri(
                    vscode.Uri.joinPath(
                        this.context.extensionUri,
                        "media",
                        "imageWebview.js",
                    ),
                );
                imagePanel.webview.html = this.getImageWebviewContent(
                    imagePanel.webview,
                    base64Image,
                    imageScriptUri,
                );

                // kicks off in parallel with the metadata panel setup below —
                // interactive window/level is an enhancement on top of the
                // static image above, not a blocker for showing it. Only
                // eligible grayscale files (see getGrayscaleImageData) get
                // anything back; everything else keeps the static image.
                if (base64Image) {
                    // header-only read, cheap — decides whether the webview
                    // gets frame-navigation UI at all (files with a single
                    // frame, the overwhelming majority, get none).
                    const numberOfFrames = getNumberOfFrames(filepath);
                    const grayscaleDataPromise =
                        decodeWorker.getGrayscaleImageData(filepath, 0);
                    imagePanel.webview.onDidReceiveMessage(
                        async (message) => {
                            if (message.command === "ready") {
                                imagePanel.webview.postMessage({
                                    command: "init",
                                    numberOfFrames,
                                });
                                const grayscaleData =
                                    await grayscaleDataPromise;
                                if (grayscaleData) {
                                    imagePanel.webview.postMessage({
                                        command: "grayscaleImageData",
                                        width: grayscaleData.width,
                                        height: grayscaleData.height,
                                        pixels: Array.from(
                                            grayscaleData.pixels,
                                        ),
                                        invert: grayscaleData.invert,
                                        defaultWindowCenter:
                                            grayscaleData.defaultWindowCenter,
                                        defaultWindowWidth:
                                            grayscaleData.defaultWindowWidth,
                                    });
                                }
                            } else if (
                                message.command === "changeFrame" &&
                                numberOfFrames > 1
                            ) {
                                const frameIndex = Math.max(
                                    0,
                                    Math.min(
                                        numberOfFrames - 1,
                                        message.frameIndex,
                                    ),
                                );
                                try {
                                    const frameBase64 =
                                        await decodeWorker.convertDicomToBase64(
                                            filepath,
                                            frameIndex,
                                        );
                                    if (
                                        !frameBase64 ||
                                        frameBase64 === "compressed"
                                    ) {
                                        throw new Error("Frame unavailable");
                                    }
                                    // if the file is grayscale-eligible, the webview is
                                    // already showing the canvas (not the <img>), so send
                                    // pixel data to redraw with the user's current
                                    // window/level rather than a fresh PNG at the file's
                                    // default window — deliberately doesn't reset W/L
                                    // per frame, matching how real viewers behave.
                                    const frameGrayscaleData =
                                        await decodeWorker.getGrayscaleImageData(
                                            filepath,
                                            frameIndex,
                                        );
                                    imagePanel.webview.postMessage({
                                        command: "frameImageData",
                                        frameIndex,
                                        base64Image: frameGrayscaleData
                                            ? null
                                            : frameBase64,
                                        grayscaleData: frameGrayscaleData
                                            ? {
                                                  width: frameGrayscaleData.width,
                                                  height: frameGrayscaleData.height,
                                                  pixels: Array.from(
                                                      frameGrayscaleData.pixels,
                                                  ),
                                                  invert: frameGrayscaleData.invert,
                                                  defaultWindowCenter:
                                                      frameGrayscaleData.defaultWindowCenter,
                                                  defaultWindowWidth:
                                                      frameGrayscaleData.defaultWindowWidth,
                                              }
                                            : null,
                                    });
                                } catch (e) {
                                    // never log the error object itself — see the
                                    // logging note elsewhere in this file
                                    getLogger().error(
                                        `DICOM frame change failed (${describeError(e).type})`,
                                    );
                                    imagePanel.webview.postMessage({
                                        command: "frameChangeError",
                                        frameIndex,
                                    });
                                }
                            }
                        },
                        undefined,
                        this.context.subscriptions,
                    );
                }
            }

            let metadataPanel: vscode.WebviewPanel | undefined;
            const originalMetadata = getMetadata(filepath);
            let metadata = originalMetadata;

            // pending edits/removals live in the webview's JS, but the webview
            // itself is disposed and recreated every time the user switches away
            // from the image tab and back (see onDidChangeViewState below) — so
            // mirror them here, in the extension host, which outlives that cycle,
            // and hand them back to each freshly created panel.
            let hostPendingEdits: Record<string, any> = {};
            let hostPendingRemovals: any[] = [];

            // set once the user explicitly hides the metadata panel via the
            // "Toggle Metadata Panel" command, so switching away from and
            // back to the image tab (see onDidChangeViewState below) doesn't
            // just reopen it out from under them.
            let metadataPanelUserHidden = false;

            // create the side-by-side view of metadata
            const createMetadataPanel = () => {
                metadataPanel = vscode.window.createWebviewPanel(
                    DICOMEditorProvider.viewType,
                    "DICOM Metadata",
                    {
                        viewColumn: vscode.ViewColumn.Beside,
                        preserveFocus: true,
                    },
                    {
                        enableScripts: true,
                        localResourceRoots: [
                            vscode.Uri.joinPath(
                                this.context.extensionUri,
                                "media",
                            ),
                        ],
                    },
                );

                const cssUri = metadataPanel.webview.asWebviewUri(
                    vscode.Uri.joinPath(
                        this.context.extensionUri,
                        "media",
                        "metadataWebview.css",
                    ),
                );
                let scriptUri;
                if (isCompressed) {
                    scriptUri = metadataPanel.webview.asWebviewUri(
                        vscode.Uri.joinPath(
                            this.context.extensionUri,
                            "media",
                            "uneditableMetadata.js",
                        ),
                    );
                } else {
                    scriptUri = metadataPanel.webview.asWebviewUri(
                        vscode.Uri.joinPath(
                            this.context.extensionUri,
                            "media",
                            "editableMetadataWebview.js",
                        ),
                    );
                }
                // search/filter is the same behavior whether the file is
                // editable or not, so it's a separate script loaded
                // alongside whichever of the two above applies
                const searchScriptUri = metadataPanel.webview.asWebviewUri(
                    vscode.Uri.joinPath(
                        this.context.extensionUri,
                        "media",
                        "metadataSearch.js",
                    ),
                );
                // same story as searchScriptUri — right-click-to-copy works
                // the same whether or not the file is editable
                const copyScriptUri = metadataPanel.webview.asWebviewUri(
                    vscode.Uri.joinPath(
                        this.context.extensionUri,
                        "media",
                        "metadataCopy.js",
                    ),
                );
                // always initialize with original metadata
                metadataPanel.webview.html = this.getMetadataWebviewContent(
                    metadataPanel.webview,
                    metadata,
                    cssUri,
                    scriptUri,
                    searchScriptUri,
                    copyScriptUri,
                );
                if (!isCompressed) {
                    // hand back whatever was pending before this panel was last
                    // torn down (e.g. on tab switch) so it doesn't look discarded
                    metadataPanel.webview.postMessage({
                        command: "restorePendingEdits",
                        edits: hostPendingEdits,
                        removals: hostPendingRemovals,
                    });
                }

                // handle messages from the webview
                metadataPanel.webview.onDidReceiveMessage(
                    (message) => {
                        if (isCompressed) {
                            // don't let it do anything, just say cannot edit compressed dicom and reset
                            vscode.window.showInformationMessage(
                                "Cannot modify this DICOM — its compressed transfer syntax isn't supported yet.",
                            );
                        } else {
                            // update the dicom according to accumulated saves and removals
                            switch (message.command) {
                                // should be caught by the above conditional but just in case
                                case "prevent-edit":
                                    vscode.window.showInformationMessage(
                                        "Cannot modify this DICOM — its compressed transfer syntax isn't supported yet.",
                                    );
                                    break;
                                case "saveAll": {
                                    // read the file once, apply every pending edit and removal to a
                                    // single dicomDict, and write once — applying them one at a time
                                    // (each doing its own read+write) meant every iteration after the
                                    // first clobbered the previous one's output.
                                    const edits = Object.values(message.edits);
                                    const { editErrors, removalErrors } =
                                        saveDicomEdits(
                                            edits,
                                            message.removals,
                                            filepath,
                                            message.mode,
                                        );
                                    if (
                                        editErrors.length > 0 ||
                                        removalErrors.length > 0
                                    ) {
                                        vscode.window.showInformationMessage(
                                            'There is something preventing DICOM from saving (may be invalid). View the "DICOM Viewer" output channel for more detail.',
                                        );
                                        for (const e of [
                                            ...editErrors,
                                            ...removalErrors,
                                        ]) {
                                            // never log the error object itself — it can embed tag values
                                            getLogger().error(
                                                `DICOM save failed (${describeError(e).type})`,
                                            );
                                        }
                                        // reset the webview html and the pending changes
                                        hostPendingEdits = {};
                                        hostPendingRemovals = [];
                                        resetMetadataPanel();
                                    }
                                    if (message.mode === "new") {
                                        // reset the original
                                        hostPendingEdits = {};
                                        hostPendingRemovals = [];
                                        resetMetadataPanel();
                                    } else if (message.mode === "replace") {
                                        // reload metadata from the updated file
                                        const updatedMetadata =
                                            getMetadata(filepath);
                                        metadata = updatedMetadata;
                                        hostPendingEdits = {};
                                        hostPendingRemovals = [];
                                        if (metadataPanel) {
                                            metadataPanel.webview.html =
                                                this.getMetadataWebviewContent(
                                                    metadataPanel.webview,
                                                    metadata,
                                                    cssUri,
                                                    scriptUri,
                                                    searchScriptUri,
                                                    copyScriptUri,
                                                );
                                        }
                                    }
                                    break;
                                }
                                case "reload":
                                    hostPendingEdits = {};
                                    hostPendingRemovals = [];
                                    resetMetadataPanel();
                                    break;
                                case "pendingChanged":
                                    // mirror the webview's in-progress edits so they survive
                                    // this panel being disposed/recreated (tab switch)
                                    hostPendingEdits = message.edits || {};
                                    hostPendingRemovals =
                                        message.removals || [];
                                    break;
                            }
                        }
                    },
                    undefined,
                    this.context.subscriptions,
                );
            };

            const disposeMetadataPanel = () => {
                if (metadataPanel) {
                    metadataPanel.dispose();
                    metadataPanel = undefined;
                }
            };

            createMetadataPanel();

            // backs the "Toggle Metadata Panel" command — see DocumentState.
            const toggleMetadataPanel = () => {
                if (metadataPanel) {
                    metadataPanelUserHidden = true;
                    disposeMetadataPanel();
                } else {
                    metadataPanelUserHidden = false;
                    createMetadataPanel();
                }
            };

            this.documents.set(document.uri.toString(), {
                filepath,
                imagePanel,
                getMetadata: () => metadata,
                toggleMetadataPanel,
            });

            // if closed the image panel, also close the corresponding metadata
            // panel and terminate this document's decode worker
            imagePanel.onDidDispose(() => {
                disposeMetadataPanel();
                decodeWorker.dispose();
                this.documents.delete(document.uri.toString());
            });

            // if focus is switched away from the image panel, also close the metadata panel
            // if focus switches back to the image panel, recreate the metadata panel
            // (unless the user explicitly hid it via the toggle command)
            imagePanel.onDidChangeViewState((e) => {
                if (!e.webviewPanel.visible) {
                    disposeMetadataPanel();
                } else if (
                    e.webviewPanel.visible &&
                    !metadataPanel &&
                    !metadataPanelUserHidden
                ) {
                    createMetadataPanel();
                }
            });

            // reload the metadata panel with original content
            const resetMetadataPanel = () => {
                if (metadataPanel) {
                    metadataPanel.dispose();
                    createMetadataPanel();
                }
            };
        }
    }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: { backupId?: string },
        token: vscode.CancellationToken,
    ): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => {} };
    }

    getCompressedImageFailedContent(webview: vscode.Webview) {
        const csp = `default-src 'none'; style-src 'unsafe-inline';`;
        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="${csp}">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Image</title>
			</head>
			<body>
				<h3>This DICOM's compressed transfer syntax isn't supported yet</h3>
				<p>RLE Lossless, JPEG Baseline, JPEG Extended (8-bit), JPEG Lossless, JPEG-LS, and JPEG 2000 are supported, and this file uses a different transfer syntax.</p>
			</body>
			</html>`;
    }

    getNoImageContent(webview: vscode.Webview) {
        const csp = `default-src 'none'; style-src 'unsafe-inline';`;
        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="${csp}">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Image</title>
			</head>
			<body>
				<h3>This DICOM has no image data</h3>
				<p>It has no PixelData, so there's nothing to display here, but its metadata is still shown and editable in the panel beside this one.</p>
			</body>
			</html>`;
    }

    getImageWebviewContent(
        webview: vscode.Webview,
        base64Image: string,
        scriptUri: vscode.Uri,
    ) {
        if (base64Image) {
            const nonce = getNonce();
            const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
            return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="${csp}">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Image</title>
				<style>
					.dicom-image { width: 80%; border: 1px solid #ccc; }
					.window-level-hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
					.frame-nav { display: flex; align-items: center; gap: 8px; margin-top: 8px; max-width: 80%; }
					.frame-nav input[type="range"] { flex: 1; }
					.frame-nav button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 10px; cursor: pointer; border-radius: 2px; }
					.frame-nav button:hover { background: var(--vscode-button-hoverBackground); }
					.frame-nav button:disabled { opacity: 0.5; cursor: default; }
					.frame-nav .frame-label { color: var(--vscode-descriptionForeground); font-size: 0.9em; white-space: nowrap; }
				</style>
			</head>
			<body>
				<img class="dicom-image" src="${escapeHtml(base64Image)}" />
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
        } else {
            const csp = `default-src 'none'; style-src 'unsafe-inline';`;
            return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="${csp}">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Image</title>
			</head>
			<body>
				<h3>Uh oh, something went wrong while displaying this image</h3>
			</body>
			</html>`;
        }
    }

    getMetadataWebviewContent(
        webview: vscode.Webview,
        metadata: Array<any>,
        cssUri: vscode.Uri,
        scriptUri: vscode.Uri,
        searchScriptUri: vscode.Uri,
        copyScriptUri: vscode.Uri,
    ) {
        if (metadata.length === 1) {
            const csp = `default-src 'none'; style-src 'unsafe-inline';`;
            return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="${csp}">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Metadata</title>
			</head>
			<body>
				<h3>DICOM contains no metadata</h3>
			</body>
			</html>`;
        } else {
            // convert 2D array to HTML table
            let tableRows = "";

            metadata.forEach((row, index) => {
                if (index === 0) {
                    // header row
                    tableRows += "<thead><tr>";
                    row.forEach((cell: any) => {
                        tableRows += `<th>${escapeHtml(cell)}</th>`;
                    });
                    tableRows += "</tr></thead><tbody>";
                } else {
                    // handle different row types (sequence/not sequence) differently
                    const rowType = row[4] || "normal";
                    const parentTag = row[5] || "";

                    if (rowType === "sequence-header") {
                        tableRows += `<tr class="sequence-header" data-sequence-tag="${escapeHtml(row[0])}">`;
                        tableRows += `<td><button class="sequence-toggle" data-target="${escapeHtml(row[0])}">▼</button> ${escapeHtml(row[0])}</td>`;
                        tableRows += `<td>${escapeHtml(row[1])}</td>`;
                        tableRows += `<td>${escapeHtml(row[2])}</td>`;
                        tableRows += `<td>${escapeHtml(row[3])}</td>`;
                        tableRows += `</tr>`;
                    } else if (rowType === "sequence-item-header") {
                        tableRows += `<tr class="sequence-item-header sequence-child" data-parent="${escapeHtml(parentTag)}" data-item-tag="${escapeHtml(row[0])}" style="display: none;">`;
                        tableRows += `<td style="padding-left: 20px;">${escapeHtml(row[1])}</td>`;
                        tableRows += `<td></td>`;
                        tableRows += `<td></td>`;
                        tableRows += `<td></td>`;
                        tableRows += `</tr>`;
                    } else if (rowType === "sequence-element") {
                        tableRows += `<tr class="sequence-element sequence-child" data-parent="${escapeHtml(parentTag)}" style="display: none;">`;
                        tableRows += `<td style="padding-left: 40px;">${escapeHtml(row[0])}</td>`;
                        tableRows += `<td>${escapeHtml(row[1])}</td>`;
                        tableRows += `<td>${escapeHtml(row[2])}</td>`;
                        // check if editable
                        if (
                            row[2] !== "SQ" &&
                            !["[Binary Data]", "[Sequence]"].includes(row[3])
                        ) {
                            tableRows += `<td contenteditable="true" class="editable-cell">${escapeHtml(row[3])}</td>`;
                        } else {
                            tableRows += `<td>${escapeHtml(row[3])}</td>`;
                        }
                        tableRows += `</tr>`;
                    } else {
                        // non-sequence
                        tableRows += "<tr>";
                        row.forEach((cell: any, cellIndex: number) => {
                            if (cellIndex > 3) {
                                // skip irrelevant sequence-related tags
                                return;
                            }
                            // make the value column editable
                            if (
                                cellIndex === 3 &&
                                row[2] !== "SQ" &&
                                !["[Binary Data]", "[Sequence]"].includes(cell)
                            ) {
                                tableRows += `<td contenteditable="true" class="editable-cell">${escapeHtml(cell)}</td>`;
                            } else {
                                tableRows += `<td>${escapeHtml(cell)}</td>`;
                            }
                        });
                        tableRows += "</tr>";
                    }
                }
            });
            tableRows += "</tbody>";

            const nonce = getNonce();
            const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
            return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="${csp}">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Metadata</title>
				<link href="${cssUri}" rel="stylesheet" />
			</head>
			<body>
				<div id="metadata-search-container">
					<input type="text" id="metadata-search" placeholder="Search by tag, name, or value…" autocomplete="off" />
					<span id="metadata-search-count"></span>
				</div>
				<table>
					${tableRows}
				</table>
				<div id="dicom-actions">
					<button class="dicom-action-btn save" title="Save as new DICOM">Save New DICOM</button>
					<button class="dicom-action-btn replace" title="Replace original DICOM">Replace DICOM</button>
					<button class="dicom-action-btn discard" title="Discard all changes">Discard Changes</button>
				</div>
				<script nonce="${nonce}" src="${scriptUri}"></script>
				<script nonce="${nonce}" src="${searchScriptUri}"></script>
				<script nonce="${nonce}" src="${copyScriptUri}"></script>
			</body>
			</html>`;
        }
    }

    // --- Command Palette commands (contributes.commands in package.json) ---

    async openDicomCommand(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: "Open DICOM",
            filters: { "DICOM files": ["dcm"] },
        });
        if (!uris || uris.length === 0) {
            return;
        }
        await vscode.commands.executeCommand(
            "vscode.openWith",
            uris[0],
            DICOMEditorProvider.viewType,
        );
    }

    async exportMetadataCommand(): Promise<void> {
        const state = this.getActiveDocument();
        if (!state) {
            vscode.window.showInformationMessage(
                "Open a DICOM file to export its metadata.",
            );
            return;
        }

        const format = await vscode.window.showQuickPick(["JSON", "CSV"], {
            placeHolder: "Export metadata as…",
        });
        if (!format) {
            return;
        }

        const baseName = path.basename(state.filepath).replace(/\.dcm$/i, "");
        const ext = format === "JSON" ? "json" : "csv";
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(
                path.join(
                    path.dirname(state.filepath),
                    `${baseName}_metadata.${ext}`,
                ),
            ),
            filters: format === "JSON" ? { JSON: ["json"] } : { CSV: ["csv"] },
        });
        if (!saveUri) {
            return;
        }

        // metadata is [header, ...rows]; each row is [tag, name, vr, value, ...].
        // structural rows (sequence headers/items) carry the same shape, so
        // this flattens sequences into the export too rather than skipping them.
        const rows = state
            .getMetadata()
            .slice(1)
            .map((row: any[]) => ({
                tag: row[0] ?? "",
                name: row[1] ?? "",
                vr: row[2] ?? "",
                value: row[3] ?? "",
            }));

        let content: string;
        if (format === "JSON") {
            content = JSON.stringify(rows, null, 2);
        } else {
            const escapeCsvField = (value: unknown) => {
                const s = String(value ?? "");
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const lines = rows.map((row) =>
                [row.tag, row.name, row.vr, row.value]
                    .map(escapeCsvField)
                    .join(","),
            );
            content = ["Tag,Name,VR,Value", ...lines].join("\n");
        }

        try {
            await vscode.workspace.fs.writeFile(
                saveUri,
                Buffer.from(content, "utf8"),
            );
            vscode.window.showInformationMessage(
                `Metadata exported to ${path.basename(saveUri.fsPath)}`,
            );
        } catch (e) {
            // never log the error object itself — it can embed tag values
            getLogger().error(
                `Metadata export failed (${describeError(e).type})`,
            );
            vscode.window.showErrorMessage(
                'Failed to export metadata. View the "DICOM Viewer" output channel for more detail.',
            );
        }
    }

    resetWindowLevelCommand(): void {
        const state = this.getActiveDocument();
        if (!state) {
            vscode.window.showInformationMessage(
                "Open a DICOM file to reset its window/level.",
            );
            return;
        }
        // a no-op if this file's image isn't interactive (color, JPEG
        // Baseline/Extended, etc.) — imageWebview.js only registers a
        // listener for this once it actually has windowable pixel data.
        state.imagePanel.webview.postMessage({ command: "resetWindowLevel" });
    }

    toggleMetadataPanelCommand(): void {
        const state = this.getActiveDocument();
        if (!state) {
            vscode.window.showInformationMessage(
                "Open a DICOM file to toggle its metadata panel.",
            );
            return;
        }
        state.toggleMetadataPanel();
    }

    async sendFeedbackCommand(): Promise<void> {
        // pre-fill the environment details a bug report would need anyway,
        // so reporting one doesn't start with "what version are you on?"
        // back-and-forth. None of this is PHI or user data — extension/VS
        // Code version and OS platform/release/arch only.
        const extensionVersion: string =
            this.context.extension.packageJSON.version;
        const body = [
            "<!-- Please describe the issue or feature request. The environment details below are filled in for you. -->",
            "",
            "---",
            "",
            "**Environment**",
            `- DICOM Viewer: ${extensionVersion}`,
            `- VS Code: ${vscode.version}`,
            `- OS: ${process.platform} ${os.release()} (${process.arch})`,
        ].join("\n");

        const url =
            "https://github.com/alaramartin/dicom-viewer/issues/new" +
            `?labels=feedback&title=&body=${encodeURIComponent(body)}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }
}

export function activate(context: vscode.ExtensionContext) {
    // register custom editor provider
    const { provider, disposable } = DICOMEditorProvider.register(context);
    context.subscriptions.push(disposable);

    context.subscriptions.push(
        vscode.commands.registerCommand("dicomViewer.openDicom", () =>
            provider.openDicomCommand(),
        ),
        vscode.commands.registerCommand("dicomViewer.exportMetadata", () =>
            provider.exportMetadataCommand(),
        ),
        vscode.commands.registerCommand("dicomViewer.resetWindowLevel", () =>
            provider.resetWindowLevelCommand(),
        ),
        vscode.commands.registerCommand(
            "dicomViewer.toggleMetadataPanel",
            () => provider.toggleMetadataPanelCommand(),
        ),
        vscode.commands.registerCommand("dicomViewer.sendFeedback", () =>
            provider.sendFeedbackCommand(),
        ),
    );
}

// called when extension is deactivated
export function deactivate() {}
