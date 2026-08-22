// Right-click any metadata row for a small context menu to copy its tag,
// value, or the whole row to the clipboard. Shared by both the editable and
// read-only (compressed-file) metadata panels — copying doesn't depend on
// whether the file can be edited.
(function () {
    let menu = null;

    function removeMenu() {
        if (menu) {
            menu.remove();
            menu = null;
        }
    }

    function copyText(text) {
        // fires directly from the menu item's own click handler, so this is
        // still within the user gesture the Clipboard API requires
        navigator.clipboard.writeText(text).catch(() => {
            // best-effort — there's nothing actionable to tell the user if
            // this fails (permissions, focus loss), so just drop it
        });
    }

    // the tag column on a sequence-header row also contains the ▼/▶ toggle
    // button's own text, so read the real tag from data-sequence-tag rather
    // than the cell's rendered text where it's available. Item-header rows
    // ("Item 1", "Item 2"...) have no real DICOM tag at all.
    function getRowTag(row) {
        if (row.dataset.sequenceTag) {
            return row.dataset.sequenceTag;
        }
        if (row.classList.contains("sequence-item-header")) {
            return "";
        }
        return row.cells[0] ? row.cells[0].textContent.trim() : "";
    }

    function getRowName(row) {
        return row.cells[1] ? row.cells[1].textContent.trim() : "";
    }

    function getRowValue(row) {
        if (row.classList.contains("sequence-item-header")) {
            // this row's only real content is its own label ("Item 1")
            return row.cells[0] ? row.cells[0].textContent.trim() : "";
        }
        return row.cells[3] ? row.cells[3].textContent.trim() : "";
    }

    function getRowText(row) {
        const vr = row.cells[2] ? row.cells[2].textContent.trim() : "";
        // a tab separator renders as a visible arrow glyph in editors with
        // "render whitespace" on, which reads like stray formatting — " | "
        // is plain and unambiguous wherever it's pasted
        return [getRowTag(row), getRowName(row), vr, getRowValue(row)].join(
            " | ",
        );
    }

    function addMenuItem(label, text) {
        const item = document.createElement("div");
        item.className = "metadata-copy-menu-item";
        item.textContent = label;
        item.addEventListener("click", () => {
            copyText(text);
            removeMenu();
        });
        menu.appendChild(item);
    }

    document.addEventListener("contextmenu", (e) => {
        const row = e.target.closest("tbody > tr");
        // ignore the button-row that appears below a cell being edited —
        // it has no tag/name/value of its own to copy
        if (!row || row.classList.contains("button-row")) {
            return;
        }
        e.preventDefault();
        removeMenu();

        const tag = getRowTag(row);
        const value = getRowValue(row);

        menu = document.createElement("div");
        menu.id = "metadata-copy-menu";
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;

        if (tag) {
            addMenuItem("Copy Tag", tag);
        }
        if (value) {
            addMenuItem("Copy Value", value);
        }
        addMenuItem("Copy Row", getRowText(row));

        document.body.appendChild(menu);

        // keep it on-screen if it would otherwise spill past the edge
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 8)}px`;
        }
        if (rect.bottom > window.innerHeight) {
            menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 8)}px`;
        }
    });

    document.addEventListener("click", (e) => {
        if (menu && !menu.contains(e.target)) {
            removeMenu();
        }
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            removeMenu();
        }
    });
    // don't let a stale menu float in place while the table scrolls under it
    document.addEventListener("scroll", removeMenu, true);
})();
