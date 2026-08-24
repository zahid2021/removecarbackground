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
    var runner =
      (window.RCB_BG && window.RCB_BG.processFile) ||
      (window.RCB_API_CLIENT && window.RCB_API_CLIENT.processFile);
    if (!runner) {
      status.textContent = "Background engine missing — refresh the page";
      return;
    }
    runBtn.disabled = true;
    var started = Date.now();
    status.textContent = "Using own API (batch)…";

    try {
      // Prefer server ZIP batch when API is up (faster + one round-trip)
      if (window.RCB_API_CLIENT && (await window.RCB_API_CLIENT.healthOk())) {
        var fd = new FormData();
        files.forEach(function (f) {
          fd.append("files", f, f.name);
        });
        fd.append("mode", mode.value);
        fd.append("backdrop", backdrop.value);
        fd.append("plate", plate.value);
        fd.append("plate_text", "PRIVATE");
        fd.append("upscale", upscale.value);
        var headers = {};
        try {
          var t = localStorage.getItem("rcb_token");
          if (t) headers.Authorization = "Bearer " + t;
        } catch (e) {}
        status.textContent = "Server batch processing " + files.length + " images…";
        var res = await fetch(
          (window.RCB_API || window.location.origin) + "/api/batch",
          { method: "POST", body: fd, headers: headers, mode: "cors" }
        );
        if (res.ok) {
          var zipBlob = await res.blob();
          var a = document.createElement("a");
          a.href = URL.createObjectURL(zipBlob);
          a.download = "rcb-batch.zip";
          a.click();
          status.textContent =
            "Done in " +
            Math.round((Date.now() - started) / 1000) +
            "s — ZIP from own API";
          return;
        }
        status.textContent = "API batch failed — falling back per image…";
      }

      var JSZip = await loadJSZip();
      var zip = new JSZip();
      var ok = 0;
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        status.textContent =
          "Processing " + (i + 1) + "/" + files.length + ": " + f.name;
        try {
          var blob = await runner(f, {
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
      var a2 = document.createElement("a");
      a2.href = URL.createObjectURL(out);
      a2.download = "rcb-batch.zip";
      a2.click();
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
