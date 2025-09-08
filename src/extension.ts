import * as vscode from 'vscode';
import { convertDicomToBase64, getMetadata } from './getImage';
import { saveDicomEdit, removeDicomTag } from './editDicom';

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
			};
			// get the image in base64 and display in webview
			const base64Image = convertDicomToBase64(filepath);
			if (base64Image === "compressed") {
				imagePanel.webview.html = this.getCompressedImageFailedContent();
				isCompressed = true;
			}
			else {
				imagePanel.webview.html = this.getImageWebviewContent(base64Image);
			}
			
        	let metadataPanel: vscode.WebviewPanel | undefined;
			const originalMetadata = getMetadata(filepath);
			let metadata = originalMetadata;

			// create the side-by-side view of metadata
			const createMetadataPanel = () => {
				metadataPanel = vscode.window.createWebviewPanel(
					DICOMEditorProvider.viewType,
					'DICOM Metadata',
					{	viewColumn: vscode.ViewColumn.Beside,
						preserveFocus: true
					},
					{ enableScripts: true }
				);

				const cssUri = metadataPanel.webview.asWebviewUri(
					vscode.Uri.joinPath(this.context.extensionUri, 'src', 'metadataWebview.css')
				);
				let scriptUri;
				if (isCompressed) {
					scriptUri = metadataPanel.webview.asWebviewUri(
						vscode.Uri.joinPath(this.context.extensionUri, 'src', 'uneditableMetadata.js')
					);
				}
				else {
					scriptUri = metadataPanel.webview.asWebviewUri(
						vscode.Uri.joinPath(this.context.extensionUri, 'src', 'editableMetadataWebview.js')
					);
				}
				// always initialize with original metadata
				metadataPanel.webview.html = this.getMetadataWebviewContent(metadata, cssUri, scriptUri);
				

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
								case "saveAll":
									for (const [key, value] of Object.entries(message.edits)) {
										if (typeof value === 'object' && value !== null && 'vr' in value && 'value' in value) {
											const { vr, value: val } = value as { vr:string, value:any };
											try {
												saveDicomEdit(key, vr, val, filepath, message.mode);
											} catch (e) {
												vscode.window.showInformationMessage("There is something preventing DICOM from saving (may be invalid). View console for more detailed error log.");
												console.log(e);
												// reset the webview html and the pending changes
												resetMetadataPanel();
												break;
											}
										}
									}
									for (const tag of message.removals) {
										try {
											removeDicomTag(tag, filepath, "new");
										} catch (e) {
											vscode.window.showInformationMessage("There is something preventing DICOM from saving (may be invalid). View console for more detailed error log.");
											console.log(e);
											// reset the webview html and the pending changes
											resetMetadataPanel();
										}
									}
									if (message.mode === "new") {
										// reset the original
										resetMetadataPanel();
									} else if (message.mode === "replace") {
										// reload metadata from the updated file
										const updatedMetadata = getMetadata(filepath);
										metadata = updatedMetadata;
										if (metadataPanel) {
											metadataPanel.webview.html = this.getMetadataWebviewContent(metadata, cssUri, scriptUri);
										}
									}
									break;
								case "reload":
									resetMetadataPanel();
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

	getCompressedImageFailedContent() {
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Image</title>
			</head>
			<body>
				<h3>Compressed DICOM images currently not supported</h3>
			</body>
			</html>`;
	}

	getImageWebviewContent(base64Image:string) {
		if (base64Image) {
			return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Image</title>
			</head>
			<body>
				<img src="${base64Image}" width="80%" style="border: 1px solid #ccc;" />
			</body>
			</html>`;
		}
		else {
			return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Image</title>
			</head>
			<body>
				<h3>Uh oh, something went wrong while displaying this image</h3>
			</body>
			</html>`;
		}
	}

	getMetadataWebviewContent(metadata: Array<any>, cssUri:vscode.Uri, scriptUri:vscode.Uri) {
		if (metadata.length === 1) {
			return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
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
						tableRows += `<th>${cell}</th>`;
					});
					tableRows += '</tr></thead><tbody>';
				} else {
					// data rows
					tableRows += '<tr>';
					row.forEach((cell: any, cellIndex: number) => {
						// make the value column editable
						if (cellIndex === 3) {
							tableRows += `<td contenteditable="true" class="editable-cell">${cell}</td>`;
						} else {
							tableRows += `<td>${cell}</td>`;
						}
					});
					tableRows += '</tr>';
				}
			});
			tableRows += '</tbody>';

			return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
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
				<script src="${scriptUri}"></script>
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