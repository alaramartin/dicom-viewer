import * as vscode from 'vscode';
import { convertDicomToBase64, getMetadata } from './getImage';
import {  } from './editDicom';

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
		if (filepath.includes(".dcm")) {
			imagePanel.webview.options = {
				enableScripts: true,
			};
			// get the image in base64 and display in webview
			const base64Image = convertDicomToBase64(filepath);
			if (base64Image === "compressed") {
				imagePanel.webview.html = this.getImageFailedContent();
			}
			else {
				imagePanel.webview.html = this.getImageWebviewContent(base64Image);
			}
			
        	let metadataPanel: vscode.WebviewPanel | undefined;

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

				const metadata = getMetadata(filepath);
				const editScriptUri = vscode.Uri.file("editDicom.ts");
				metadataPanel.webview.html = this.getMetadataWebviewContent(metadata, editScriptUri);

				// todo: here, add metadataPanel.webview.ondidreceivemessage to handle when the webview sends a message to update the dicom
				// in this listener, call the functions in editDicom.ts
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
		}
	}

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: { backupId?: string },
		token: vscode.CancellationToken
	): Promise<vscode.CustomDocument> {
		return { uri, dispose: () => {} };
	}

	getImageFailedContent() {
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
				<h3>uh oh, something went wrong</h3>
			</body>
			</html>`;
		}
	}

	getMetadataWebviewContent(metadata: Array<any>, scriptUri:vscode.Uri) {
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
				<style>
					body {
						font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
						margin: 10px;
						background-color: var(--vscode-editor-background);
						color: var(--vscode-editor-foreground);
					}
					h3 {
						color: var(--vscode-editor-foreground);
						margin-bottom: 15px;
					}
					table {
						border-collapse: collapse;
						width: 100%;
						font-size: 12px;
					}
					th, td {
						border: 1px solid var(--vscode-panel-border);
						padding: 8px;
						text-align: left;
					}
					th {
						background-color: var(--vscode-editor-selectionBackground);
						font-weight: bold;
						position: sticky;
						top: 0;
					}
					tr:nth-child(even) {
						background-color: var(--vscode-list-hoverBackground);
					}
					tr:hover {
						background-color: var(--vscode-list-activeSelectionBackground);
					}
					td {
						word-break: break-word;
						max-width: 200px;
					}
					.editable-cell:focus {
						outline: 2px solid #007ACC;
						outline-offset: -1px;
						background-color: var(--vscode-input-background);
					}
				</style>
			</head>
			<body>
				<table>
					${tableRows}
				</table>
				<script>
					// script to handle the UI of editing dicom metadata
					// get vscode api
					const vscode = acquireVsCodeApi();
					let currentEditingCell = null;
					let ogValue = '';
					let buttonRow = null;

					document.addEventListener("DOMContentLoaded", function() {
						/* listen to when editable-cell is in focus. when in focus, create the extra row below it with the buttons
						 		save edits (blue), discard edits (grey), and remove row (red)
						 		(when out of focus, remove this row)
						*/

						// when editable cell is in focus
						document.addEventListener("focusin", function(e) {
							if (e.target.classList.contains("editable-cell")) {
								// keep track of the cell being edited and its original value
								currentEditingCell = e.target;
								ogValue = e.target.textContent;
								// create the row that allows user to save/discard/remove row
								createButtonsRow(e.target);
							}
						});

						// when cell goes out of focus, remove the editing buttons row
						document.addEventListener("focusout", function(e) {
							setTimeout(() => {
								if (!document.activeElement || !document.activeElement.classList.contains('action-button')) {
									currentEditingCell = null;
									removeButtonsRow();
								}
							}, 100);
						});

						// add listener for keys pressed
						document.addEventListener("keydown", function(e) {
							// escape button removes focus from that cell
							if (e.key == "Escape" && currentEditingCell) {
								currentEditingCell.textContent = ogValue;
								currentEditingCell.blur();
								currentEditingCell = null;
								removeButtonsRow();
							}
							// enter button has the same functionality as clicking save
							if (e.key == "Enter" && currentEditingCell) {
								console.log("entered");
								const newValue = currentEditingCell.textContent;
								// check if the value changed at all
								if (newValue !== ogValue) {
									// get the dicom tag of the currenteditingcell (first column)
									const row = currentEditingCell.closest('tr');
                    				const hexTag = row.cells[0].textContent.trim();
									vscode.postMessage({
										message: "save",
										tag: hexTag,
										value: newValue
									});
								}
								// remove focus from the cell and remove buttons row
								currentEditingCell.blur();
								currentEditingCell = null;
								removeButtonsRow();
							}
						});

						// listen to button presses (save/discard/remove row)
						document.addEventListener("click", function(e) {
							// check if the button was the save button
							if (e.target.classList.contains("save-edits")) {
								console.log("saved");
								const newValue = currentEditingCell.textContent;
								// check if the value changed at all
								if (newValue !== ogValue) {
									// get the dicom tag of the currenteditingcell (first column)
									const row = currentEditingCell.closest('tr');
                    				const hexTag = row.cells[0].textContent.trim();
									vscode.postMessage({
										message: "save",
										tag: hexTag,
										value: newValue
									});
								}
								// remove focus from the cell and remove buttons row
								console.log("removing");
								currentEditingCell = null;
								removeButtonsRow();
							}
							// check for "remove row" button
							else if (e.target.classList.contains("remove-row")) {
								// get the dicom tag of the currenteditingcell (first column)
									const row = currentEditingCell.closest('tr');
                    				const hexTag = row.cells[0].textContent.trim();
									vscode.postMessage({
										message: "remove",
										tag: hexTag
									});
									// remove focus from the cell and remove buttons row
									console.log("removing");
									currentEditingCell = null;
									removeButtonsRow();
							}
							// check for discard button which just cancels the change
							else if (e.target.classList.contains("discard")) {
								currentEditingCell.textContent = ogValue;
								currentEditingCell.blur();
								console.log("removing");
								currentEditingCell = null;
								removeButtonsRow();
							}
						});

						// add a row below the editing row that displays 3 button options
						function createButtonsRow(cell) {
							// remove button row if already existing
							removeButtonsRow();
							
							const row = cell.closest('tr');
							const newRow = document.createElement('tr');
							newRow.className = 'button-row';
							
							const buttonCell = document.createElement('td');
							buttonCell.colSpan = 4;
							buttonCell.style.textAlign = 'center';
							buttonCell.style.padding = '5px';
							
							buttonCell.innerHTML = 
    							'<button class="action-button save-edits" style="background: #007ACC; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Save</button>' +
    							'<button class="action-button discard" style="background: #666; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Discard</button>' +
    							'<button class="action-button remove-row" style="background: #E74C3C; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Remove Row</button>';
							
							newRow.appendChild(buttonCell);
							row.parentNode.insertBefore(newRow, row.nextSibling);
							buttonRow = newRow;
						}

						function removeButtonsRow() {
							if (buttonRow) {
								buttonRow.remove();
								buttonRow = null;
							}
						}
					});
				</script>
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