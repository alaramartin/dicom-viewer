// Interactive window/level: drag on the image to adjust window center/width,
// double-click to reset. Only takes over once the extension host posts real
// pixel data (see getGrayscaleImageData in src/getImage.ts) — until then the
// static <img> stays as-is, which is also what non-eligible files (color
// images, JPEG Baseline/Extended, anything unsupported) keep showing.
(function () {
    const vscode = acquireVsCodeApi();

    let imageData = null; // { width, height, pixels, invert, defaultWindowCenter, defaultWindowWidth }
    let windowCenter = 0;
    let windowWidth = 1;

    let canvas = null;
    let ctx = null;
    let renderQueued = false;

    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartCenter = 0;
    let dragStartWidth = 1;

    // Mirrors applyLinearVoiLut() in src/getImage.ts — PS3.3 C.11.2.1.2.1's
    // default ("LINEAR") VOI LUT function. Keep the two in sync.
    function applyLinearVoiLut(x, center, width) {
        if (width <= 1) {
            return x <= center - 0.5 ? 0 : 255;
        }
        const low = center - 0.5 - (width - 1) / 2;
        const high = center - 0.5 + (width - 1) / 2;
        if (x <= low) {
            return 0;
        }
        if (x > high) {
            return 255;
        }
        return Math.round(((x - (center - 0.5)) / (width - 1) + 0.5) * 255);
    }

    function render() {
        if (!imageData || !ctx) {
            return;
        }
        const { width, height, pixels, invert } = imageData;
        const frame = ctx.createImageData(width, height);
        const out = frame.data;
        for (let i = 0; i < width * height; i++) {
            let gray = applyLinearVoiLut(pixels[i], windowCenter, windowWidth);
            if (invert) {
                gray = 255 - gray;
            }
            const idx = i * 4;
            out[idx] = gray;
            out[idx + 1] = gray;
            out[idx + 2] = gray;
            out[idx + 3] = 255;
        }
        ctx.putImageData(frame, 0, 0);
    }

    // coalesce renders to one per animation frame — mousemove can fire much
    // faster than that, and re-rendering a full image per event is wasted work.
    function scheduleRender() {
        if (renderQueued) {
            return;
        }
        renderQueued = true;
        requestAnimationFrame(() => {
            renderQueued = false;
            render();
        });
    }

    function resetWindow() {
        windowCenter = imageData.defaultWindowCenter;
        windowWidth = imageData.defaultWindowWidth;
        scheduleRender();
    }

    function setupCanvas() {
        const imgEl = document.querySelector("img");
        canvas = document.createElement("canvas");
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        canvas.className = "dicom-image";
        canvas.title = "Drag to adjust window/level — double-click to reset";

        canvas.addEventListener("mousedown", (e) => {
            dragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragStartCenter = windowCenter;
            dragStartWidth = windowWidth;
            e.preventDefault();
        });
        window.addEventListener("mousemove", (e) => {
            if (!dragging) {
                return;
            }
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            // sensitivity relative to the file's own default window, so
            // dragging feels reasonable whether values are in Hounsfield
            // Units, raw 16-bit counts, or something else entirely.
            const sensitivity = Math.max(1, imageData.defaultWindowWidth) / 256;
            windowWidth = Math.max(1, dragStartWidth + dx * sensitivity);
            // a lower center brightens the image (the same pixel value ends
            // up further above the window's midpoint), so dragging up
            // (dy negative) needs to *decrease* center for "up = brighter".
            windowCenter = dragStartCenter + dy * sensitivity;
            scheduleRender();
        });
        window.addEventListener("mouseup", () => {
            dragging = false;
        });
        canvas.addEventListener("dblclick", resetWindow);

        if (imgEl && imgEl.parentNode) {
            imgEl.parentNode.replaceChild(canvas, imgEl);
        } else {
            document.body.appendChild(canvas);
        }
        ctx = canvas.getContext("2d");
        render();

        // only shown once the canvas actually takes over — files that keep
        // the static image (color, JPEG Baseline/Extended, etc.) have no
        // drag/reset behavior to explain.
        const hint = document.createElement("p");
        hint.className = "window-level-hint";
        hint.textContent = "Drag on the image to adjust window/level — up/down for brightness, left/right for contrast. Double-click to reset.";
        canvas.insertAdjacentElement("afterend", hint);
    }

    window.addEventListener("message", (event) => {
        const message = event.data;
        if (message.command === "grayscaleImageData") {
            imageData = {
                width: message.width,
                height: message.height,
                pixels: message.pixels,
                invert: message.invert,
                defaultWindowCenter: message.defaultWindowCenter,
                defaultWindowWidth: message.defaultWindowWidth,
            };
            windowCenter = message.defaultWindowCenter;
            windowWidth = message.defaultWindowWidth;
            setupCanvas();
        }
    });

    // tell the extension host we're ready to receive the pixel data — it
    // may have finished decoding before this script even started running,
    // so this ready signal (rather than the host guessing when to send) is
    // what avoids losing that first postMessage.
    vscode.postMessage({ command: "ready" });
})();
