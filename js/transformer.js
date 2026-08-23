(function () {
  var fileInput = document.getElementById("batchFiles");
  var browseBtn = document.getElementById("batchBrowse");
  var runBtn = document.getElementById("batchRun");
  var list = document.getElementById("batchList");
  var status = document.getElementById("batchStatus");
  var backdrop = document.getElementById("batchBackdrop");
  var mode = document.getElementById("batchMode");
  var plate = document.getElementById("batchPlate");
  var upscale = document.getElementById("batchUpscale");
  var drop = document.getElementById("batchDrop");

  if (!fileInput) return;

  var files = [];

  function render() {
    list.innerHTML = files
      .map(function (f, i) {
        return (
          "<li>" +
          (i + 1) +
          ". " +
          f.name +
          " <span class='mute'>(" +
          Math.round(f.size / 1024) +
          " KB)</span></li>"
        );
      })
      .join("");
    runBtn.disabled = files.length === 0;
    status.textContent = files.length ? files.length + " images ready" : "No files selected";
  }

  function addFiles(fileList) {
    Array.from(fileList || []).forEach(function (f) {
      if (f.type.startsWith("image/")) files.push(f);
    });
    if (files.length > 20) files = files.slice(0, 20);
    render();
  }

  browseBtn.addEventListener("click", function () {
    fileInput.click();
  });
  fileInput.addEventListener("change", function () {
    addFiles(fileInput.files);
  });

  ["dragenter", "dragover"].forEach(function (evt) {
    drop.addEventListener(evt, function (e) {
      e.preventDefault();
      drop.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    drop.addEventListener(evt, function (e) {
      e.preventDefault();
      drop.classList.remove("dragover");
    });
  });
  drop.addEventListener("drop", function (e) {
    addFiles(e.dataTransfer.files);
  });

  async function loadJSZip() {
    if (window.JSZip) return window.JSZip;
    await new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return window.JSZip;
  }

  runBtn.addEventListener("click", async function () {
    if (!files.length) return;
    if (!window.RCB_BG || !window.RCB_BG.processFile) {
      status.textContent = "Background engine missing — refresh the page";
      return;
    }
    runBtn.disabled = true;
    var started = Date.now();
    status.textContent = "Loading AI in browser (first time)…";

    try {
      var JSZip = await loadJSZip();
      var zip = new JSZip();
      var ok = 0;
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        status.textContent =
          "Processing " + (i + 1) + "/" + files.length + ": " + f.name;
        try {
          var blob = await window.RCB_BG.processFile(f, {
            mode: mode.value,
            backdrop: backdrop.value,
            plate: plate.value,
            plateText: "PRIVATE",
            upscale: upscale.value,
          });
          var name = f.name.replace(/\.[^.]+$/, "") + ".png";
          zip.file(name, blob);
          ok += 1;
        } catch (e) {
          status.textContent = "Skipped " + f.name + ": " + (e.message || e);
        }
      }
      if (!ok) throw new Error("All images failed");
      status.textContent = "Building ZIP…";
      var out = await zip.generateAsync({ type: "blob" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(out);
      a.download = "rcb-batch.zip";
      a.click();
      status.textContent =
        "Done in " +
        Math.round((Date.now() - started) / 1000) +
        "s — ZIP downloaded (" +
        ok +
        " images)";
    } catch (err) {
      status.textContent = err.message || "Batch failed";
    } finally {
      runBtn.disabled = files.length === 0;
    }
  });

  render();
})();
