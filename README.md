# DICOM Viewer & Editor

View and edit DICOM (.dcm) files directly in VS Code. View both the image and associated metadata side-by-side. Edit metadata and save edited DICOMs in the side panel.

## Features

-   **Viewer**: Display DICOM images as well as file metadata including tags, value representations (VRs), and attribute values
-   **Editor**: Edit DICOM tags directly from the metadata display
    -   Includes warnings to ensure that file remains in valid DICOM standard format
    -   Choose to update current file or create new file with changes
-   **Easy to use**: Activates as soon as you click on a .dcm file

### Examples

Viewing:
![example1](https://raw.githubusercontent.com/alaramartin/dicom-viewer/refs/heads/main/media/images/example-dicom.png)

Editing:
![example2](https://raw.githubusercontent.com/alaramartin/dicom-viewer/refs/heads/main/media/images/example-dicom-edit.png)
![example3](https://raw.githubusercontent.com/alaramartin/dicom-viewer/refs/heads/main/media/images/example-dicom-warning.png)

Note: This extension currently does not support displaying or editing compressed images. The official names and VRs of private tags may not be identified. Binary data and tags required for image display cannot be edited.

## Installation

Click the "Install" button. No additional dependencies to worry about :)

## Contributing

Feel free to open issues and pull requests. I'll be regularly checking activity on the [repository](https://github.com/alaramartin/dicom-viewer)!

## License

This extension is released under the MIT License. See the LICENSE file for more details.

## For Athena Award: Reflection

Note: if you need some DICOMs to test this extension on, (dicomlibrary.com)[https://www.dicomlibrary.com/] has some sample DICOMs ;)
