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
		if (filepath.includes(".dcm")) {
			imagePanel.webview.options = {
				enableScripts: true,
			};
			// get the image in base64 and display in webview
			const base64Image = convertDicomToBase64(filepath);
			if (base64Image === "compressed") {
				imagePanel.webview.html = this.getCompressedImageFailedContent();
			}
			else {
				imagePanel.webview.html = this.getImageWebviewContent(base64Image);
			}
			
        	let metadataPanel: vscode.WebviewPanel | undefined;
			const metadata = getMetadata(filepath);
			const originalMetadataHTML = this.getMetadataWebviewContent(metadata);

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

				metadataPanel.webview.html = originalMetadataHTML;

				let toRemove = {};
				let toEdit = {};

				// handle messages from the webview - call functions from editDicom for appropriate commands
				metadataPanel.webview.onDidReceiveMessage(
					message => {
						// fixme: instead of immediately updating, collect a list of tags to change/remove until user clicks "save dicom" button, then loop through the edits and removals
						// 		idea: have dict like {tag : [vr, newValue]}
						switch (message.command) {
							case 'save':
								console.log(`save message received with ${message.tag} and ${message.value} and ${message.vr}`);
								// it doesn't make sense for binary or sequence data to be editable, so block the user from editing these VRs
								// fixme: deal with whatever is going on with sequence data because you might just have to unpack it or something
								// 		note: sequence data SHOULD be editable... just needs to not be displayed as [Sequence]
								if (message.vr === 'OB' || message.vr === 'OF' || message.vr === 'OW' || message.vr === 'SQ') {
									vscode.window.showInformationMessage(`DICOM tag of VR ${message.vr} is not editable.`);
								}
								else {
									// fixme: ALSO, if the VR is a DATE vr, remove the slashes in the string before passing into function, and add the slashes back if appropriate?
									// call appropriate editDicom.ts function
									saveDicomEdit(message.tag, message.vr, message.value, filepath);
								}
								break;
							case 'remove':
								console.log(`remove message received with ${message.tag} and ${message.vr}`);
								// call appropriate editDicom.ts function
								removeDicomTag(message.tag, filepath);
								metadataPanel?.webview.postMessage({
									removed: "removed",
									tag: message.tag
								});
								break;
							case 'reload':
								// reload the metadata panel with original content
								if (metadataPanel) {
									metadataPanel.dispose();
        							createMetadataPanel();
									console.log("reset DOM");
								}
								break;
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
				<h3>uh oh, something went wrong</h3>
			</body>
			</html>`;
		}
	}

	getMetadataWebviewContent(metadata: Array<any>) {
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
					.tooltip {  
						position: relative;  
						display: inline-block;
					}  

					.tooltip .tooltiptext {  
						visibility: hidden;  
						width: 200px;  
						background-color: #333;  
						color: #fff;  
						text-align: center;  
						border-radius: 6px;  
						padding: 5px;  
						position: absolute;  
						z-index: 1000;  
						bottom: 125%;  
						left: 50%;  
						margin-left: -100px;
						font-size: 12px;
						box-shadow: 0 2px 8px rgba(0,0,0,0.3);
					}  

					.tooltip:hover .tooltiptext {  
						visibility: visible;  
					}
					
					.tooltip .tooltiptext::after {
						content: "";
						position: absolute;
						top: 100%;
						left: 50%;
						margin-left: -5px;
						border-width: 5px;
						border-style: solid;
						border-color: #333 transparent transparent transparent;
					}
					#dicom-actions {
						position: fixed;
						top: 20px;
						right: 30px;
						z-index: 2000;
						display: none;
						gap: 8px;
					}
					.dicom-action-btn {
						background: #007ACC;
						color: white;
						border: none;
						padding: 6px 14px;
						margin: 0 2px;
						border-radius: 3px;
						cursor: pointer;
						font-size: 13px;
						box-shadow: 0 1px 4px rgba(0,0,0,0.08);
					}
					.dicom-action-btn.discard {
						background: #E74C3C;
					}
					.dicom-action-btn.replace {
						background: #666;
					}
				</style>
			</head>
			<body>
				<div id="dicom-actions">
					<button class="dicom-action-btn save" title="Save as new DICOM">Save New DICOM</button>
					<button class="dicom-action-btn replace" title="Replace original DICOM">Replace DICOM</button>
					<button class="dicom-action-btn discard" title="Discard all changes">Discard Changes</button>
				</div>
				<table>
					${tableRows}
				</table>
				<script>
					// script to handle the UI of editing dicom metadata
					// get vscode api
					const vscode = acquireVsCodeApi();
					let currentEditingCell = null;
					// only non-binary data is editable
					let editable = true;
					let ogValue = '';
					let buttonRow = null;

					// track pending edits/removals
					let pendingEdits = {};
					let pendingRemovals = new Set();
					let hasChanges = false;
					// save the original form of the document in case the user discards changes
					const originalDoc = document.documentElement.outerHTML;

					function showDicomActions(show) {
						const actions = document.getElementById('dicom-actions');
						actions.style.display = show ? 'flex' : 'none';
					}

					function markChanged() {
						hasChanges = true;
						showDicomActions(true);
					}
					// fixme: make the dicomactoins row look nicer/be nicer location
					document.addEventListener("DOMContentLoaded", function() {
						/* listen to when editable-cell is in focus. when in focus, create the extra row below it with the buttons
						 		save edits (blue), cancel edits (grey), and remove row (red)
						 		(when out of focus, remove this row)
						*/

						// note: an empty cell displays as [Empty] in the UI. when focusin, change the contents to just empty if it is [Empty]. if user clears it then saves, display [Empty] but change dicom data to empty
						// when editable cell is in focus
						document.addEventListener("focusin", function(e) {
							if (e.target.classList.contains("editable-cell")) {
								// keep track of the cell being edited and its original value
								currentEditingCell = e.target;
								ogValue = e.target.textContent;
								// make an empty cell be empty when editing it
								if (ogValue === "[Empty]") {
									e.target.textContent = "";
								}
								else if (ogValue === "[Binary Data]") {
									editable = false;
								}
								// create the row that allows user to save/cancel/remove row
								editable = createButtonsRow(e.target) && editable;
							}
						});

						// when cell goes out of focus, remove the editing buttons row
						document.addEventListener("focusout", function(e) {
							setTimeout(() => {
								if (!document.activeElement || !document.activeElement.classList.contains('action-button')) {
									if (currentEditingCell?.textContent === "") {
										// display empty cell as "[Empty]"
										currentEditingCell.textContent = "[Empty]";
									}
									currentEditingCell = null;
									editable = true;
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
								const newValue = currentEditingCell.textContent;
								// check if the value changed at all
								if (newValue !== ogValue && editable) {
									// get the dicom tag of the currenteditingcell (first column)
									const row = currentEditingCell.closest('tr');
									const hexTag = row.cells[0].textContent.trim();
									const VR = row.cells[2].textContent.trim();
									// store edit, don't send to extension yet
									pendingEdits[hexTag] = { vr: VR, value: newValue };
									markChanged();
								}
								else if (!editable) {
									currentEditingCell.textContent = ogValue;
									console.log("cannot edit binary data");
								}
								// remove focus from the cell and remove buttons row
								currentEditingCell.blur();
								currentEditingCell = null;
								removeButtonsRow();
							}
						});

						// listen to button presses (save/cancel/remove row, save dicoms)
						document.addEventListener("click", function(e) {
							if (e.target.classList.contains("save-edits")) {
								const newValue = currentEditingCell.textContent;
								if (newValue !== ogValue && editable) {
									const row = currentEditingCell.closest('tr');
									const hexTag = row.cells[0].textContent.trim();
									const VR = row.cells[2].textContent.trim();
									pendingEdits[hexTag] = { vr: VR, value: newValue };
									markChanged();
								}
								// fixme: distinguish between editable and removable
								else if (!editable) {
									currentEditingCell.textContent = ogValue;
									console.log("cannot edit");
									// remove focus from the cell and remove buttons row
									removeButtonsRow();
								}
								// remove focus from the cell and remove buttons row
								currentEditingCell.blur();
								currentEditingCell = null;
								removeButtonsRow();
							}
							// check for "remove row" button
							else if (e.target.classList.contains("remove-row")) {
								if (editable) {
									const row = currentEditingCell.closest('tr');
									const hexTag = row.cells[0].textContent.trim();
									pendingRemovals.add(hexTag);
									markChanged();
									row.remove();
								}
								else {
									currentEditingCell.textContent = ogValue;
									console.log("cannot remove");
								}
								// remove focus from the cell and remove buttons row
								currentEditingCell.blur();
								currentEditingCell = null;
								removeButtonsRow();
							}
							// check for cancel button which just cancels the change
							else if (e.target.classList.contains("cancel")) {
								currentEditingCell.textContent = ogValue;
								currentEditingCell.blur();
								currentEditingCell = null;
								removeButtonsRow();
							}
							// DICOM action buttons (save/replace/cancel)
							else if (e.target.classList.contains("dicom-action-btn")) {
								if (e.target.classList.contains("save")) {
									vscode.postMessage({
										command: "saveAll",
										mode: "new",
										edits: pendingEdits,
										removals: Array.from(pendingRemovals)
									});
									resetChanges();
								}
								else if (e.target.classList.contains("replace")) {
									vscode.postMessage({
										command: "saveAll",
										mode: "replace",
										edits: pendingEdits,
										removals: Array.from(pendingRemovals)
									});
									resetChanges();
								}
								else if (e.target.classList.contains("discard")) {
									// tell the extension to reload the metadata panel with original content
									vscode.postMessage({
										command: "reload"
									});
									resetChanges();
								}
							}
						});

						// add a listener to remove the currenteditingrow if dicom editing was successful
						window.addEventListener("message", function(e) {
							const message = e.data;
							if (message.removed === "removed") {
								const rows = document.querySelectorAll('tbody tr');
								rows.forEach(row => {
									const tagCell = row.cells[0];
									if (tagCell && tagCell.textContent.trim() === message.tag) {
										row.remove();
										console.log("row removed for tag:", message.tag);
									}
								});
								// remove the buttons row
								currentEditingCell = null;
								removeButtonsRow();
							}
						});

						// add a row below the editing row that displays 3 button options
						function createButtonsRow(cell) {
							console.log("create");
							// remove button row if already existing
							removeButtonsRow();

							const row = cell.closest('tr');
							const hexTag = row.cells[0].textContent.trim();
							const newRow = document.createElement('tr');
							newRow.className = 'button-row';

							const buttonCell = document.createElement('td');
							buttonCell.colSpan = 4;
							buttonCell.style.textAlign = 'center';
							buttonCell.style.padding = '5px';

							// check if tag is required for dicom validity
							const tagRequired = isTagRequired(hexTag);

							let removeButtonHTML;
							let saveButtonHTML;
							let editable = true;
							if (tagRequired === "require") {
								saveButtonHTML = '<button class="action-button save-edits" style="background: #007ACC; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Save</button>';
								// add tooltip (popup that shows up when hovering) for removal of tags that are required
								removeButtonHTML = 
									'<div class="tooltip">' +
										'<button class="action-button remove-row" style="background: #E74C3C; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Remove Row</button>' +
										'<span class="tooltiptext">Warning: Deleting this tag will invalidate the DICOM</span>' +
									'</div>';
							}
							// block removal of anything used in getimage()
							else if (tagRequired === "image") {
								saveButtonHTML =
									'<div class="tooltip">' +
										'<button class="action-button save-edits" style="background: #a2aec1ff; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; pointer-events: none;">Save</button>' +
										'<span class="tooltiptext">Image data cannot be edited.</span>' +
									'</div>';
								removeButtonHTML = 
									'<div class="tooltip">' +
										'<button class="action-button remove-row" style="background: #c1a3a2ff; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; pointer-events: none;">Remove Row</button>' +
										'<span class="tooltiptext">Image data cannot be removed.</span>' +
									'</div>';
								editable = false;
							} else {
								// regular remove and save button for non-required tags
								saveButtonHTML = '<button class="action-button save-edits" style="background: #007ACC; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Save</button>';
								removeButtonHTML = '<button class="action-button remove-row" style="background: #E74C3C; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Remove Row</button>';
							}

							buttonCell.innerHTML = 
								saveButtonHTML +
								'<button class="action-button cancel" style="background: #666; color: white; border: none; padding: 5px 10px; margin: 0 5px; border-radius: 3px; cursor: pointer;">Cancel</button>' +
								removeButtonHTML;

							newRow.appendChild(buttonCell);
							row.parentNode.insertBefore(newRow, row.nextSibling);
							buttonRow = newRow;
							return editable;
						}						

						function removeButtonsRow() {
							if (buttonRow) {
								buttonRow.remove();
								buttonRow = null;
							}
						}

						// required tags list from https://www.pclviewer.com/help/required_dicom_tags.htm
						// type 1: cannot be removed or empty
						// type 2: cannot be empty
						// type 3: optional
						// fixme: also add checking for when it is edited/saved, type 1 requireds cannot be empty https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_7.4.html
						// 	note: when making edits to the cell, if it is empty, warning popup when hover over save
						function isTagRequired(tag) {
							tag = tag.replace(/^x/, "").toUpperCase();

							// tags required for getImage() to work (CANNOT delete or // fixme: modify)
							const imageRequiredTags = [
								"00280010", "00280011", "00280100", "00280101", "00280103", "00280002", "00280004", "7FE00010",
							];
							const requiredTags = [
								"00080016", "00080018", "00100010", "00100020", "00100030", "00100040", "00200010",
								"0020000D", "0020000E", "00200011", "00200013", "00080020", "00080030", "00080060", "00280102"
							];
							if (imageRequiredTags.includes(tag)) {
								return "image";
							}
							else if (requiredTags.includes(tag)) {
								return "require";
							}
							else {
								return "ok";
							}
						}

						function resetChanges() {
							pendingEdits = {};
							pendingRemovals = new Set();
							hasChanges = false;
							showDicomActions(false);
							console.log("reset changes");
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