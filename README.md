# DICOM Viewer & Editor

View and edit DICOM (.dcm) files directly in VS Code. View both the image and associated metadata side-by-side. Edit metadata and save edited DICOMs in the side panel.

Available on [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=alarm.dicom-viewer) and [OpenVSX](https://open-vsx.org/extension/alarm/dicom-viewer).

## Features

- **Viewer**: Display DICOM images as well as file metadata including tags, value representations (VRs), and attribute values
- **Editor**: Edit DICOM tags directly from the metadata display
    - Includes warnings to ensure that file remains in valid DICOM standard format
    - Choose to update current file or create new file with changes
- **Easy to use**: Activates as soon as you click on a .dcm file
- **Sequences**: Supports sequence elements (viewing and editing)
- **Compressed images**: Displays and edits DICOMs compressed with RLE Lossless, JPEG Baseline, JPEG Extended (8-bit), JPEG Lossless, JPEG-LS, and JPEG 2000 — the full pixel data is decoded, not just the metadata
- **Window/level**: Honors the file's real window/level and rescale values (accurate Hounsfield Units on CT), and supports interactive adjustment — drag on the image to change brightness/contrast, double-click to reset

### Examples

Viewing:
![example1](https://raw.githubusercontent.com/alaramartin/dicom-viewer/refs/heads/main/media/images/example-dicom.png)

Editing:
![example2](https://raw.githubusercontent.com/alaramartin/dicom-viewer/refs/heads/main/media/images/example-dicom-edit.png)
![example3](https://raw.githubusercontent.com/alaramartin/dicom-viewer/refs/heads/main/media/images/example-dicom-warning.png)

Note: A small number of compressed transfer syntaxes (e.g. private or retired ones, or 12-bit JPEG Extended specifically) still show a read-only "not supported" page instead of the image. The official names and VRs of private tags may not be identified. Binary data and tags required for image display cannot be edited.

## Installation

Click the "Install" button. No additional dependencies to worry about :)

## Contributing

Feel free to open issues and pull requests. I'll be regularly checking activity on the [repository](https://github.com/alaramartin/dicom-viewer)!

## License

This extension is released under the MIT License. See the LICENSE file for more details.
