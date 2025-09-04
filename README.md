# DICOM Viewer & Editor

View and edit DICOM (.dcm) files directly in VS Code. View both the image and associated metadata side-by-side. Edit metadata and save edited DICOMs in the side panel.

## Features

- **Viewer**: Display DICOM image as well as file metadata including tags, value representations (VRs), and attribute values
- **Editor**: Edit DICOM tags directly from the metadata display
    - Includes warnings to ensure that file remains in valid DICOM standard format
- **Easy to use**: Activates as soon as you click on a .dcm file

### Examples
Viewing:
![example1](https://raw.githubusercontent.com/alaramartin/dicom-viewer/refs/heads/main/example-dicom.png)

Editing:
![example2](https://raw.githubusercontent.com/alaramartin/dicom-viewer/refs/heads/main/example-dicom-edit.png)

Note: this extension currently does not support displaying compressed images or the official name/VR of private tags. Binary data and tags required for image display cannot be edited.

## Installation

Click the "Install" button. No additional dependencies to worry about :)

## Contributing

Feel free to open issues and pull requests. I'll be regularly checking activity on the [repository](https://github.com/alaramartin/dicom-viewer)!

## License

This extension is released under the MIT License. See the LICENSE file for more details.