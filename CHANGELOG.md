# Change Log

All notable changes to the "DICOM Viewer & Editor" extension are documented here.

## [1.4.0] - 2026-05-31

No functional changes. README updates only.

## [1.3.0] - 2025-10-19

No user-facing changes. Internal cleanup: removed stray `console.log` calls and reorganized dependencies.

## [1.2.0] - 2025-10-19

No functional changes.

## [1.1.0] - 2025-10-19

- Added support for viewing and editing DICOM sequence (`SQ`) elements, with an expand/collapse UI to drill into nested items.

## [1.0.0] - 2025-09-07

- Added full metadata editing: change tag values, remove tags, and save changes to a new file or in place.
- Added a review step that tracks pending edits and lets you save or discard them, rather than applying changes immediately.
- Added a warning when editing or removing a tag that's required for DICOM validity.
- Disabled editing/removal of pixel data and other tags the image renderer depends on.

## [0.1.1] - 2025-09-01

- Formatted `DA` (date) tag values as `YYYY/MM/DD` in the metadata table instead of the raw `YYYYMMDD` string.
- Added the extension icon.

## [0.1.0] - 2025-09-01

- Added a side-by-side metadata panel showing every tag alongside the image.
- Added real tag name/VR lookup via a DICOM data dictionary.
- Switched image rendering to `pngjs` to fix cross-platform compatibility issues.
- Added detection for compressed transfer syntaxes (shown as unsupported, since compressed pixel data can't be decoded yet).

## [0.0.1] - 2025-08-20

- Initial release: view a `.dcm` file's image in a custom editor.
