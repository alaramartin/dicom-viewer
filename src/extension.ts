// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { convertDicomToBase64 } from './getImage';

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
		webviewPanel:vscode.WebviewPanel,
		token:vscode.CancellationToken
	): Promise<void> {
		console.log("editor changed");
		let filepath = document.uri.fsPath;
		vscode.window.showInformationMessage(filepath);
		if (filepath.includes(".dcm")) {
			vscode.window.showInformationMessage("DICOM!!!!");
			webviewPanel.webview.options = {
				enableScripts: true,
			};
			// get the image in base64 and display in webview
			const base64Image = convertDicomToBase64(filepath);
			if (base64Image === "compressed") {
				webviewPanel.webview.html = this.getFailedContent();
			}
			else {
				webviewPanel.webview.html = this.getWebviewContent(base64Image);
			}
			
		}
	}

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: { backupId?: string },
		token: vscode.CancellationToken
	): Promise<vscode.CustomDocument> {
		return { uri, dispose: () => {} };
	}

	getFailedContent() {
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Image</title>
			</head>
			<body>
				<h3>compressed image not supported</h3>
			</body>
			</html>`;
	}

	getWebviewContent(base64Image:string) {
		if (base64Image) {
			return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Image</title>
			</head>
			<body>
				<h3>DICOM Viewer</h3>
				<img src="${base64Image}" width="300" style="border: 1px solid #ccc;" />
			</body>
			</html>`;
		}
		else {
			// if failed, return a cat picture
			return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>failed :( here's a cat picture to cheer you up:</title>
			</head>
			<body>
				<img src="https://en.wikipedia.org/wiki/Cat#/media/File:Cat_August_2010-4.jpg" width="300" style="border: 1px solid #ccc;" />
			</body>
			</html>`;
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	// Register our custom editor providers
	context.subscriptions.push(DICOMEditorProvider.register(context));
}

// This method is called when your extension is deactivated
export function deactivate() {}