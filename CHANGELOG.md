# Change Log

All notable changes to the "DICOM Viewer & Editor" extension are documented here.

## [1.6.0] - 2026-08-21

**The single most-requested feature: compressed DICOMs now display and are fully editable.** Previously any compressed file hit a read-only "not supported" page — this covered a large share of real-world clinical/research exports.

- Added support for RLE Lossless, JPEG Baseline, JPEG Lossless, JPEG-LS, and JPEG 2000 compressed transfer syntaxes. These files now render correctly and can be edited and saved like any uncompressed DICOM.
- JPEG-LS and JPEG 2000 decoding preserves full source bit depth (up to 16-bit) — no precision loss on CT/MR data.
- A small number of transfer syntaxes outside these 5 (private or retired ones) still fall back to the previous read-only page rather than failing outright.

## [1.5.1] - 2026-08-20

- Fixed a packaging bug in 1.5.0 that could ship a large, unnecessary source map file, undermining the size reduction below. `.vscodeignore`'s `*.map` rule wasn't matching nested paths like `dist/extension.js.map`; changed to `**/*.map`. Package size back down to ~850 KB.

## [1.5.0] - 2026-08-20

A correctness- and security-focused release — no new features, but a long list of real bugs fixed, plus a much smaller package.

**Fixes:**

- Fixed data loss when saving multiple metadata edits in one go — previously only the last edit was kept.
- Fixed a cross-site scripting (XSS) vulnerability in the metadata panel: a crafted `.dcm` file could run arbitrary script.
- Stopped potentially logging patient data to the output console on parse/save errors.
- Fixed multi-frame DICOM files being incorrectly reported as "compressed" and refused.
- Fixed color images (ultrasound, endoscopy, secondary capture, etc.) rendering as garbled grayscale instead of color.
- Fixed several numeric tags (`Rows`, `Columns`, `BitsAllocated`, and others) showing blank or garbled values in the metadata table.
- Fixed tag names with apostrophes (e.g. "Referring Physician's Name") displaying a literal `&#x27;` instead of `'`.
- Fixed the metadata table being unreadable in light color themes.
- Fixed edits that were typed and then manually undone still marking the file as changed.
- Fixed empty cells losing their "[Empty]" label when clicked into and then clicked away from without editing.
- Fixed unsaved edits being silently discarded when switching away from the image tab and back.

**Packaging:**

- Cut the installed extension size from 15–21 MB down to well under 1 MB by bundling and no longer shipping `node_modules` wholesale.
- Removed unused dependencies.
- Stopped the extension activating on every VS Code launch — it now only activates when you open a `.dcm` file, as intended.
- Filled in Marketplace listing metadata (license, issue tracker link, homepage).

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
