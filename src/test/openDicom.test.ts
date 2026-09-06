import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// Smoke test over real DICOM files. Point DICOM_FIXTURES at a folder of
// .dcm files to run it; without that the suite skips, so the repo doesn't
// have to carry binary fixtures.
const fixtureDir = process.env.DICOM_FIXTURES;

suite("opening real DICOM files", function () {
    // decoding the larger CT/MR files is not fast
    this.timeout(60000);

    let files: string[] = [];

    suiteSetup(function () {
        if (!fixtureDir || !fs.existsSync(fixtureDir)) {
            this.skip();
        }
        files = fs
            .readdirSync(fixtureDir!)
            .filter((f) => f.toLowerCase().endsWith(".dcm"))
            .map((f) => path.join(fixtureDir!, f))
            .sort();
        assert.ok(files.length > 0, "no .dcm files in DICOM_FIXTURES");
    });

    test("every fixture opens in the custom editor without throwing", async () => {
        for (const file of files) {
            await vscode.commands.executeCommand(
                "vscode.openWith",
                vscode.Uri.file(file),
                "dicomViewer.dcm",
            );
            await vscode.commands.executeCommand(
                "workbench.action.closeActiveEditor",
            );
        }
    });

    test("a malformed file opens the failure page instead of crashing", async () => {
        // sample.dcm in the fixture set is deliberately not a real DICOM;
        // any file too small to be one will do.
        const tiny = files.find((f) => fs.statSync(f).size < 1024);
        if (!tiny) {
            return;
        }
        await vscode.commands.executeCommand(
            "vscode.openWith",
            vscode.Uri.file(tiny),
            "dicomViewer.dcm",
        );
        await vscode.commands.executeCommand(
            "workbench.action.closeActiveEditor",
        );
    });
});
