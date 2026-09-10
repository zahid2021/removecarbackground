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

  if (!fileInput || !list) return;

  /** @type {{file:File, name:string, originalUrl:string, resultUrl:string|null, state:string, error:string|null}[]} */
  var items = [];

  function revoke(url) {
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
    }
  }

  function clearItems() {
    items.forEach(function (it) {
      revoke(it.originalUrl);
      revoke(it.resultUrl);
    });
    items = [];
  }

  function render() {
    if (!items.length) {
      list.innerHTML = "";
      list.hidden = true;
      runBtn.disabled = true;
      status.textContent = "No files selected — AI prepares in the background";
      return;
    }
    list.hidden = false;
    list.innerHTML = items
      .map(function (it, i) {
        var resultHtml = it.resultUrl
          ? '<img class="batch-card-img" src="' +
            it.resultUrl +
            '" alt="Result ' +
            (i + 1) +
            '" />'
          : '<div class="batch-card-placeholder">' +
            (it.state === "working"
              ? "Processing…"
              : it.state === "error"
                ? "Failed"
                : "Waiting") +
            "</div>";
        var pill =
          it.state === "done"
            ? '<span class="status-pill">Done</span>'
            : it.state === "working"
              ? '<span class="status-pill" style="background:#fff3cd;color:#7a5b00">Working</span>'
              : it.state === "error"
                ? '<span class="status-pill" style="background:#fde8e8;color:#9b1c1c">Error</span>'
                : '<span class="status-pill" style="background:#e8eef5;color:#445">Queued</span>';
        return (
          '<article class="batch-card" data-i="' +
          i +
          '">' +
          '<div class="batch-card-pair">' +
          '<div class="batch-card-col">' +
          '<span class="batch-card-label">Original</span>' +
          '<img class="batch-card-img" src="' +
          it.originalUrl +
          '" alt="Original ' +
          (i + 1) +
          '" />' +
          "</div>" +
          '<div class="batch-card-col">' +
          '<span class="batch-card-label">Result</span>' +
          resultHtml +
          "</div>" +
          "</div>" +
          '<div class="batch-card-meta">' +
          "<strong>" +
          (i + 1) +
          ". " +
          it.name +
          "</strong> " +
          pill +
          (it.error
            ? '<div class="mute" style="margin-top:4px">' + it.error + "</div>"
            : "") +
          "</div></article>"
        );
      })
      .join("");
    runBtn.disabled = items.length === 0;
    var done = items.filter(function (x) {
      return x.state === "done";
    }).length;
    status.textContent = done
      ? done + "/" + items.length + " processed — scroll to compare each car"
      : items.length + " cars ready — originals shown below";
  }

  function addFiles(fileList) {
    Array.from(fileList || []).forEach(function (f) {
      if (!f.type.startsWith("image/")) return;
      if (items.length >= 20) return;
      items.push({
        file: f,
        name: f.name,
        originalUrl: URL.createObjectURL(f),
        resultUrl: null,
        state: "queued",
        error: null,
      });
    });
    render();
  }

  browseBtn.addEventListener("click", function () {
    fileInput.click();
  });
  fileInput.addEventListener("change", function () {
    addFiles(fileInput.files);
    fileInput.value = "";
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

  function stem(name) {
    return String(name || "")
      .replace(/\.[^.]+$/, "")
      .toLowerCase();
  }

  async function applyZipResults(zipBlob) {
    var JSZip = await loadJSZip();
    var zip = await JSZip.loadAsync(zipBlob);
    var byStem = {};
    var entries = Object.keys(zip.files);
    for (var e = 0; e < entries.length; e++) {
      var path = entries[e];
      var entry = zip.files[path];
      if (entry.dir) continue;
      var base = path.split("/").pop();
      var blob = await entry.async("blob");
      byStem[stem(base)] = URL.createObjectURL(blob);
    }
    items.forEach(function (it) {
      var url = byStem[stem(it.name)] || byStem[stem(it.name) + ".png"];
      if (url) {
        revoke(it.resultUrl);
        it.resultUrl = url;
        it.state = "done";
        it.error = null;
      } else {
        it.state = "error";
        it.error = "Not found in ZIP";
      }
    });
    render();
  }

  async function processOneByOne(runner) {
    var JSZip = await loadJSZip();
    var zip = new JSZip();
    var ok = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      it.state = "working";
      it.error = null;
      render();
      status.textContent =
        "Processing car " + (i + 1) + "/" + items.length + ": " + it.name;
      try {
        var blob = await runner(it.file, {
          mode: mode.value,
          backdrop: backdrop.value,
          plate: plate.value,
          plateText: "PRIVATE",
          upscale: upscale.value,
        });
        revoke(it.resultUrl);
        it.resultUrl = URL.createObjectURL(blob);
        it.state = "done";
        zip.file(stem(it.name) + ".png", blob);
        ok += 1;
      } catch (err) {
        it.state = "error";
        it.error = (err && err.message) || String(err);
      }
      render();
    }
    if (!ok) throw new Error("All images failed");
    status.textContent = "Building ZIP…";
    var out = await zip.generateAsync({ type: "blob" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(out);
    a.download = "rcb-batch.zip";
    a.click();
    return ok;
  }

  // Brand backdrops in batch select (same as editor)
  (async function loadCustomBackdrops() {
    var t = "";
    try {
      t = localStorage.getItem("rcb_token") || "";
    } catch (e) {}
    if (!t || !backdrop) return;
    try {
      var res = await fetch((window.RCB_API || "") + "/api/backdrops", {
        headers: { Authorization: "Bearer " + t },
      });
      if (!res.ok) return;
      var data = await res.json();
      (data.custom || []).forEach(function (b) {
        var opt = document.createElement("option");
        opt.value = b.value;
        opt.textContent = "Brand · " + b.name;
        backdrop.appendChild(opt);
      });
    } catch (e) {}
  })();

  runBtn.addEventListener("click", async function () {
    if (!items.length) return;
    var runner =
      (window.RCB_BG && window.RCB_BG.processFile) ||
      (window.RCB_API_CLIENT && window.RCB_API_CLIENT.processFile);
    if (!runner) {
      status.textContent = "Background engine missing — refresh the page";
      return;
    }
    runBtn.disabled = true;
    var started = Date.now();
    items.forEach(function (it) {
      it.state = "queued";
      it.error = null;
      revoke(it.resultUrl);
      it.resultUrl = null;
    });
    render();
    status.textContent = "Starting batch…";

    try {
      if (window.RCB_API_CLIENT && (await window.RCB_API_CLIENT.healthOk())) {
        var fd = new FormData();
        items.forEach(function (it) {
          fd.append("files", it.file, it.name);
        });
        fd.append("mode", mode.value);
        fd.append("backdrop", backdrop.value);
        fd.append("plate", plate.value);
        fd.append("plate_text", "PRIVATE");
        fd.append("upscale", upscale.value);
        var headers = {};
        try {
          var tok = localStorage.getItem("rcb_token");
          if (tok) headers.Authorization = "Bearer " + tok;
        } catch (e) {}
        status.textContent =
          "Server processing " + items.length + " cars — results will appear below…";
        items.forEach(function (it) {
          it.state = "working";
        });
        render();
        var res = await fetch(
          (window.RCB_API || window.location.origin) + "/api/batch",
          { method: "POST", body: fd, headers: headers, mode: "cors" }
        );
        if (res.ok) {
          var zipBlob = await res.blob();
          await applyZipResults(zipBlob);
          var a = document.createElement("a");
          a.href = URL.createObjectURL(zipBlob);
          a.download = "rcb-batch.zip";
          a.click();
          var doneN = items.filter(function (x) {
            return x.state === "done";
          }).length;
          status.textContent =
            "Done in " +
            Math.round((Date.now() - started) / 1000) +
            "s — " +
            doneN +
            " cars shown below + ZIP downloaded";
          return;
        }
        status.textContent = "API batch failed — processing one by one with previews…";
      }

      var ok = await processOneByOne(runner);
      status.textContent =
        "Done in " +
        Math.round((Date.now() - started) / 1000) +
        "s — " +
        ok +
        " cars shown below + ZIP downloaded";
    } catch (err) {
      status.textContent = (err && err.message) || "Batch failed";
    } finally {
      runBtn.disabled = items.length === 0;
    }
  });

  var clearBtn = document.getElementById("batchClear");
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      clearItems();
      render();
    });
  }

  render();
})();
