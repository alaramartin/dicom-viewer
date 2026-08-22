// Metadata table search/filter — shared by both the editable and read-only
// (compressed-file) metadata panels, since filtering behaves identically
// either way. Matches tag number, tag name, or value (case-insensitive
// substring match across all cells of a row). Sequences containing a match
// auto-expand to reveal it and collapse back to their default (collapsed)
// state once the search box is cleared.
document.addEventListener("DOMContentLoaded", function () {
    const searchInput = document.getElementById("metadata-search");
    if (!searchInput) {
        // metadata.length === 1 — no table was rendered, nothing to filter
        return;
    }
    const countLabel = document.getElementById("metadata-search-count");
    const allRows = Array.from(document.querySelectorAll("tbody > tr"));
    const totalLeafCount = allRows.filter(
        (row) =>
            !row.classList.contains("sequence-header") &&
            !row.classList.contains("sequence-item-header"),
    ).length;

    function rowText(row) {
        return Array.from(row.cells)
            .map((cell) => cell.textContent || "")
            .join(" ")
            .toLowerCase();
    }

    // "visible" here means "should win regardless of collapse state" — it's
    // the same class the sequence-toggle click handler uses to expand a
    // sequence, so forcing it on during a search and clearing it afterward
    // is exactly the expand/collapse mechanism already in place.
    function showRow(row) {
        row.classList.remove("search-hidden");
        if (row.classList.contains("sequence-child")) {
            row.classList.remove("hidden");
            row.classList.add("visible");
        }
    }

    function hideRow(row) {
        row.classList.add("search-hidden");
    }

    function expandHeader(header) {
        header.classList.remove("sequence-collapsed");
        header.classList.add("sequence-expanded");
        const toggle = header.querySelector(".sequence-toggle");
        if (toggle) {
            toggle.textContent = "▼";
        }
    }

    function collapseHeader(header) {
        header.classList.remove("sequence-expanded");
        header.classList.add("sequence-collapsed");
        const toggle = header.querySelector(".sequence-toggle");
        if (toggle) {
            toggle.textContent = "▶";
        }
    }

    function clearFilter() {
        allRows.forEach((row) => row.classList.remove("search-hidden"));
        document.querySelectorAll(".sequence-child").forEach((row) => {
            row.classList.add("hidden");
            row.classList.remove("visible");
        });
        document.querySelectorAll(".sequence-header").forEach(collapseHeader);
        if (countLabel) {
            countLabel.textContent = "";
        }
    }

    function applyFilter(rawQuery) {
        const query = rawQuery.trim().toLowerCase();
        if (!query) {
            clearFilter();
            return;
        }

        // leaf rows: plain (non-sequence) rows and sequence-element rows —
        // the rows that actually carry a tag/name/value to search
        const leafRows = allRows.filter(
            (row) =>
                !row.classList.contains("sequence-header") &&
                !row.classList.contains("sequence-item-header"),
        );
        const leafMatch = new Map();
        let matchCount = 0;
        leafRows.forEach((row) => {
            const matches = rowText(row).includes(query);
            leafMatch.set(row, matches);
            if (matches) {
                matchCount++;
            }
        });

        // top-level plain rows (not part of any sequence)
        leafRows.forEach((row) => {
            if (row.classList.contains("sequence-child")) {
                return; // sequence-element rows are handled per-item below
            }
            if (leafMatch.get(row)) {
                showRow(row);
            } else {
                hideRow(row);
            }
        });

        // sequences, top-down: a sequence whose own row matches shows
        // everything under it unconditionally (no reason to also filter
        // its contents once the user found it by name); otherwise each item
        // is shown if its own row matches or any of its elements do
        document.querySelectorAll(".sequence-header").forEach((header) => {
            const sequenceTag = header.dataset.sequenceTag;
            const items = document.querySelectorAll(
                `tr.sequence-item-header[data-parent="${sequenceTag}"]`,
            );
            const headerSelfMatch = rowText(header).includes(query);
            let sequenceVisible = headerSelfMatch;

            items.forEach((itemHeader) => {
                const itemTag = itemHeader.dataset.itemTag;
                const children = document.querySelectorAll(
                    `tr[data-parent="${itemTag}"]`,
                );
                const itemSelfMatch =
                    headerSelfMatch || rowText(itemHeader).includes(query);
                const anyChildMatch = Array.from(children).some((child) =>
                    leafMatch.get(child),
                );
                const itemVisible = itemSelfMatch || anyChildMatch;

                if (itemVisible) {
                    showRow(itemHeader);
                    children.forEach((child) => {
                        if (itemSelfMatch || leafMatch.get(child)) {
                            showRow(child);
                        } else {
                            hideRow(child);
                        }
                    });
                    sequenceVisible = true;
                } else {
                    hideRow(itemHeader);
                    children.forEach(hideRow);
                }
            });

            if (sequenceVisible) {
                showRow(header);
                expandHeader(header);
            } else {
                hideRow(header);
                collapseHeader(header);
            }
        });

        if (countLabel) {
            countLabel.textContent = `${matchCount} of ${totalLeafCount} tags match`;
        }
    }

    searchInput.addEventListener("input", () => applyFilter(searchInput.value));
});
