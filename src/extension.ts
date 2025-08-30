// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { convertDicomToBase64 } from './getImage';

/* 
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  console.log('DICOM Viewer extension is now active!');
  
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => {
      console.log('Editor changed!');
      if (document) {
        const filepath = document.fileName;
        console.log(`Current file: ${filepath}`);
        vscode.window.showInformationMessage(`File opened: ${filepath}`);
        
        if (filepath.includes(".dcm")) {
          console.log('DICOM file detected!');
          vscode.window.showInformationMessage(`Opening DICOM file: ${filepath}`);
          
          const panel = vscode.window.createWebviewPanel(
            'dicomViewer',
            'DICOM Image',
            vscode.ViewColumn.One,
            {
              enableScripts: true,
              retainContextWhenHidden: true
            }
          );
          
          const { exec } = require('node:child_process');
          const scriptPath = context.asAbsolutePath('src/get_image.py');
          console.log(`Executing: python3 "${scriptPath}" "${filepath}"`);
          
          exec(`python3 "${scriptPath}" "${filepath}"`, (error: any, stdout: any, stderr: any) => {
            if (error) {
              console.error(`exec error: ${error}`);
              vscode.window.showErrorMessage(`Python execution error: ${error.message}`);
              return;
            }
            console.log(`Python stdout: ${stdout}`);
            if (stderr) {
              console.error(`Python stderr: ${stderr}`);
            }
            
            // get the image returned in base64
            const lines = stdout.trim().split('\n');
            const base64Image = lines[lines.length - 1];
            console.log(`Base64 length: ${base64Image?.length || 0}`);
            panel.webview.html = getWebviewContent(base64Image);
          });
        }
      }
    })
  );
}

function getWebviewContent(base64Image: string) {
  const imageSrc = `data:image/jpeg;base64,${base64Image}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DICOM Image</title>
</head>
<body>
    <h3>DICOM Viewer</h3>
    <img src="${imageSrc}" width="300" style="border: 1px solid #ccc;" />
    <p>Base64 length: ${base64Image?.length || 0}</p>
</body>
</html>`;
}

// This method is called when your extension is deactivated
export function deactivate() {}

*/


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
			const base64Image = convertDicomToBase64(filepath);
			webviewPanel.webview.html = this.getWebviewContent(base64Image);
		}
	}

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: { backupId?: string },
		token: vscode.CancellationToken
	): Promise<vscode.CustomDocument> {
		return { uri, dispose: () => {} };
	}

	// getBase64Image(filepath:string): string {
	// 	const { exec } = require('node:child_process');
	// 	const scriptPath = this.context.asAbsolutePath('src/get_image.py');
	// 	console.log(`Executing: python3 "${scriptPath}" "${filepath}"`);
		
	// 	exec(`python3 "${scriptPath}" "${filepath}"`, (error: any, stdout: any, stderr: any) => {
	// 		if (error) {
	// 			console.error(`exec error: ${error}`);
	// 			vscode.window.showErrorMessage(`Python execution error: ${error.message}`);
	// 			return "hi";
	// 		}
	// 		console.log(`Python stdout: ${stdout}`);
	// 		if (stderr) {
	// 			console.error(`Python stderr: ${stderr}`);
	// 		}
			
	// 		// get and return the image returned in base64
	// 		const lines = stdout.trim().split('\n');
	// 		const base64Image = lines[lines.length - 1];
	// 		console.log(`Base64 length: ${base64Image?.length || 0}`);
	// 		return base64Image;
	// 	});
	// 	return "hi";
	// }

	getWebviewContent(base64Image: string) {
		if (base64Image !== "hi") {
			const imageSrc = `data:image/jpeg;base64,${base64Image}`;
			return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>DICOM Image</title>
			</head>
			<body>
				<h3>DICOM Viewer</h3>
				<img src="${imageSrc}" width="300" style="border: 1px solid #ccc;" />
				<p>Base64 length: ${base64Image?.length || 0}</p>
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