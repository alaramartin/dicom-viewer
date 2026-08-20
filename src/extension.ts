import * as vscode from 'vscode';
import { convertDicomToBase64, getMetadata } from './getImage';
import { saveDicomEdits } from './editDicom';
import { getLogger, describeError } from './logger';

// escape a value for safe interpolation into HTML text/attribute content.
// DICOM tag values come from the file itself and are not trustworthy input.
function escapeHtml(value: unknown): string {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}

class DICOMEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new DICOMEditorProvider(context);
		const providerRegistration = vscode.window.registerCustomEditorProvider(DICOMEditorProvider.viewType, provider, {
			supportsMultipleEditorsPerDocument: false
		});
		return providerRegistration;
	}

	private static readonly viewType = 'dicomViewer.dcm';

	constructor(
		private readonly context: vscode.ExtensionContext
	) { }

	async resolveCustomEditor(
		document:vscode.CustomDocument,
		imagePanel:vscode.WebviewPanel,
		token:vscode.CancellationToken
	): Promise<void> {
		let filepath = document.uri.fsPath;
		let isCompressed = false;
		if (filepath.includes(".dcm")) {
			imagePanel.webview.options = {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
			};
			// get the image in base64 and display in webview
			let base64Image: string;
			try {
				base64Image = convertDicomToBase64(filepath);
			} catch (e) {
				// convertDicomToBase64 already logged the error type; an uncaught
				// throw here rejects resolveCustomEditor's promise and crashes the
				// editor tab, so fall through to the "something went wrong" page.
				base64Image = "";
			}
			if (base64Image === "compressed") {
				imagePanel.webview.html = this.getCompressedImageFailedContent(imagePanel.webview);
				isCompressed = true;
			}
			else {
				imagePanel.webview.html = this.getImageWebviewContent(imagePanel.webview, base64Image);
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

			// create the side-by-side view of metadata
			const createMetadataPanel = () => {
				metadataPanel = vscode.window.createWebviewPanel(
					DICOMEditorProvider.viewType,
					'DICOM Metadata',
					{	viewColumn: vscode.ViewColumn.Beside,
						preserveFocus: true
					},
					{
						enableScripts: true,
						localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
					}
				);

				const cssUri = metadataPanel.webview.asWebviewUri(
					vscode.Uri.joinPath(this.context.extensionUri, 'media', 'metadataWebview.css')
				);
				let scriptUri;
				if (isCompressed) {
					scriptUri = metadataPanel.webview.asWebviewUri(
						vscode.Uri.joinPath(this.context.extensionUri, 'media', 'uneditableMetadata.js')
					);
				}
				else {
					scriptUri = metadataPanel.webview.asWebviewUri(
						vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editableMetadataWebview.js')
					);
				}
				// always initialize with original metadata
				metadataPanel.webview.html = this.getMetadataWebviewContent(metadataPanel.webview, metadata, cssUri, scriptUri);
				if (!isCompressed) {
					// hand back whatever was pending before this panel was last
					// torn down (e.g. on tab switch) so it doesn't look discarded
					metadataPanel.webview.postMessage({
						command: "restorePendingEdits",
						edits: hostPendingEdits,
						removals: hostPendingRemovals
					});
				}

				// handle messages from the webview
				metadataPanel.webview.onDidReceiveMessage(
					message => {
						if (isCompressed) {
							// don't let it do anything, just say cannot edit compressed dicom and reset
							vscode.window.showInformationMessage("Cannot modify a compressed DICOM.");
						}
						else {
							// update the dicom according to accumulated saves and removals
							switch (message.command) {
								// should be caught by the above conditional but just in case
								case "prevent-edit":
									vscode.window.showInformationMessage("Cannot modify a compressed DICOM.");
									break;
								case "saveAll": {
									// read the file once, apply every pending edit and removal to a
									// single dicomDict, and write once — applying them one at a time
									// (each doing its own read+write) meant every iteration after the
									// first clobbered the previous one's output.
									const edits = Object.values(message.edits);
									const { editErrors, removalErrors } = saveDicomEdits(edits, message.removals, filepath, message.mode);
									if (editErrors.length > 0 || removalErrors.length > 0) {
										vscode.window.showInformationMessage("There is something preventing DICOM from saving (may be invalid). View the \"DICOM Viewer\" output channel for more detail.");
										for (const e of [...editErrors, ...removalErrors]) {
											// never log the error object itself — it can embed tag values
											getLogger().error(`DICOM save failed (${describeError(e).type})`);
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
										const updatedMetadata = getMetadata(filepath);
										metadata = updatedMetadata;
										hostPendingEdits = {};
										hostPendingRemovals = [];
										if (metadataPanel) {
											metadataPanel.webview.html = this.getMetadataWebviewContent(metadataPanel.webview, metadata, cssUri, scriptUri);
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
									hostPendingRemovals = message.removals || [];
									break;
							}
						}
					},
					undefined,
					this.context.subscriptions
				);
			};

			const disposeMetadataPanel = () => {
				if (metadataPanel) {
					metadataPanel.dispose();
					metadataPanel = undefined;
				}
			};

			createMetadataPanel();
			
			// if closed the image panel, also close the corresponding metadata panel
			imagePanel.onDidDispose(() => {
				disposeMetadataPanel();
			});

			// if focus is switched away from the image panel, also close the metadata panel
			// if focus switches back to the image panel, recreate the metadata panel
			imagePanel.onDidChangeViewState(e => {
				if (!e.webviewPanel.visible) {
					disposeMetadataPanel();
				}
				else if (e.webviewPanel.visible && !metadataPanel) {
					if (!metadataPanel) {
						createMetadataPanel();
					}
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
		token: vscode.CancellationToken
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
				<h3>Compressed DICOM images currently not supported</h3>
			</body>
			</html>`;
	}

	getImageWebviewContent(webview: vscode.Webview, base64Image:string) {
		const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline';`;
		if (base64Image) {
			return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="${csp}">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Image</title>
			</head>
			<body>
				<img src="${escapeHtml(base64Image)}" width="80%" style="border: 1px solid #ccc;" />
			</body>
			</html>`;
		}
		else {
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

	getMetadataWebviewContent(webview: vscode.Webview, metadata: Array<any>, cssUri:vscode.Uri, scriptUri:vscode.Uri) {
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
		}
		else {
			// convert 2D array to HTML table
			let tableRows = '';

			metadata.forEach((row, index) => {
				if (index === 0) {
					// header row
					tableRows += '<thead><tr>';
					row.forEach((cell: any) => {
						tableRows += `<th>${escapeHtml(cell)}</th>`;
					});
					tableRows += '</tr></thead><tbody>';
				} else {
					// handle different row types (sequence/not sequence) differently
					const rowType = row[4] || 'normal';
					const parentTag = row[5] || '';

					if (rowType === 'sequence-header') {
						tableRows += `<tr class="sequence-header" data-sequence-tag="${escapeHtml(row[0])}">`;
						tableRows += `<td><button class="sequence-toggle" data-target="${escapeHtml(row[0])}">▼</button> ${escapeHtml(row[0])}</td>`;
						tableRows += `<td>${escapeHtml(row[1])}</td>`;
						tableRows += `<td>${escapeHtml(row[2])}</td>`;
						tableRows += `<td>${escapeHtml(row[3])}</td>`;
						tableRows += `</tr>`;
					} else if (rowType === 'sequence-item-header') {
						tableRows += `<tr class="sequence-item-header sequence-child" data-parent="${escapeHtml(parentTag)}" data-item-tag="${escapeHtml(row[0])}" style="display: none;">`;
						tableRows += `<td style="padding-left: 20px;">${escapeHtml(row[1])}</td>`;
						tableRows += `<td></td>`;
						tableRows += `<td></td>`;
						tableRows += `<td></td>`;
						tableRows += `</tr>`;
					} else if (rowType === 'sequence-element') {
						tableRows += `<tr class="sequence-element sequence-child" data-parent="${escapeHtml(parentTag)}" style="display: none;">`;
						tableRows += `<td style="padding-left: 40px;">${escapeHtml(row[0])}</td>`;
						tableRows += `<td>${escapeHtml(row[1])}</td>`;
						tableRows += `<td>${escapeHtml(row[2])}</td>`;
						// check if editable
						if (row[2] !== 'SQ' && !['[Binary Data]', '[Sequence]'].includes(row[3])) {
							tableRows += `<td contenteditable="true" class="editable-cell">${escapeHtml(row[3])}</td>`;
						} else {
							tableRows += `<td>${escapeHtml(row[3])}</td>`;
						}
						tableRows += `</tr>`;
					} else {
						// non-sequence
						tableRows += '<tr>';
						row.forEach((cell: any, cellIndex: number) => {
							if (cellIndex > 3) {
								// skip irrelevant sequence-related tags
								return;
							}
							// make the value column editable
							if (cellIndex === 3 && row[2] !== 'SQ' && !['[Binary Data]', '[Sequence]'].includes(cell)) {
								tableRows += `<td contenteditable="true" class="editable-cell">${escapeHtml(cell)}</td>`;
							} else {
								tableRows += `<td>${escapeHtml(cell)}</td>`;
							}
						});
						tableRows += '</tr>';
					}
				}
			});
			tableRows += '</tbody>';

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
				<table>
					${tableRows}
				</table>
				<div id="dicom-actions">
					<button class="dicom-action-btn save" title="Save as new DICOM">Save New DICOM</button>
					<button class="dicom-action-btn replace" title="Replace original DICOM">Replace DICOM</button>
					<button class="dicom-action-btn discard" title="Discard all changes">Discard Changes</button>
				</div>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	// register custom editor provider
	context.subscriptions.push(DICOMEditorProvider.register(context));
}

// called when extension is deactivated
export function deactivate() {}