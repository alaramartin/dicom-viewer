# DICOM Viewer & Editor

[![Athena Award Badge](https://img.shields.io/endpoint?url=https%3A%2F%2Faward.athena.hackclub.com%2Fapi%2Fbadge)](https://award.athena.hackclub.com?utm_source=readme)

View and edit DICOM (.dcm) files directly in VS Code. View both the image and associated metadata side-by-side. Edit metadata and save edited DICOMs in the side panel.

## Features

-   **Viewer**: Display DICOM images as well as file metadata including tags, value representations (VRs), and attribute values
-   **Editor**: Edit DICOM tags directly from the metadata display
    -   Includes warnings to ensure that file remains in valid DICOM standard format
    -   Choose to update current file or create new file with changes
-   **Easy to use**: Activates as soon as you click on a .dcm file
-   **Sequences**: Supports sequence elements (viewing and editing)

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

I made this extension after my summer internship at a medical lab, where I was working with DICOM format images all day. VS Code doesn't support viewing DICOM images, so I had to rely on external tools to view and edit, which was a hassle and also a security risk for confidential patient info. I decided to make this extension to make my own work easier, and published it so that others who work in this field can have this tool to make their work easier too. A huge hurdle for me was that `pydicom`, a DICOM library in Python, is really comprehensive and easy to use, but would make this extension more difficult for users to download: they would have to also install the Python requirements. I wanted this extension to be super easy for anyone to just download and use immediately, so I had to find JS libraries for DICOM actions, but all of the JS DICOM libraries have very minimal documentation (or just none). Working with these new, undocumented libraries was the biggest challenge because I almost never knew was I was doing and spent hours on debugging methods I barely knew anything about. But to me, the end result is super cool and super useful :)
