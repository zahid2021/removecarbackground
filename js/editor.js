(function () {
  var ROOT = window.RCB_API || window.location.origin;
  var API = ROOT + "/api/process";
  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("fileInput");
  var browseBtn = document.getElementById("browseBtn");
  var emptyState = document.getElementById("emptyState");
  var previewWrap = document.getElementById("previewWrap");
  var preview = document.getElementById("preview");
  var mockBadge = document.getElementById("mockBadge");
  var processBtn = document.getElementById("processBtn");
  var downloadBtn = document.getElementById("downloadBtn");
  var clearBtn = document.getElementById("clearBtn");
  var statusText = document.getElementById("statusText");
  var summary = document.getElementById("summary");
  var backdrop = document.getElementById("backdrop");
  var upscale = document.getElementById("upscale");
  var upscaleLabel = document.getElementById("upscaleLabel");
  var history = document.getElementById("history");
  var modeSeg = document.getElementById("modeSeg");
  var plateSeg = document.getElementById("plateSeg");
  var plateText = document.getElementById("plateText");
  var creditsChip = document.getElementById("creditsChip");

  if (!dropzone) return;

  // Default Full-Cut for dealer stock photos
  var state = {
    mode: "full",
    plate: "none",
    file: null,
    fileName: null,
    objectUrl: null,
    resultUrl: null,
    processed: false,
  };

  var params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "half") {
    state.mode = "half";
  }
  modeSeg.querySelectorAll("button").forEach(function (b) {
    b.classList.toggle("active", b.dataset.mode === state.mode);
  });
  if (params.get("batch") === "1") {
    // hint for transformer users
  }

  // Preload AI so Process feels ~1s after ready
  if (window.RCB_BG && window.RCB_BG.warmup) {
    setStatus("Preparing AI model in browser…");
    window.RCB_BG.warmup(function (key, current, total) {
      if (!total) return;
      setStatus("Preparing AI… " + Math.round((current / total) * 100) + "%");
    })
        .then(function () {
        setStatus("AI ready (high quality) — Process may take ~20–40s");
      })
      .catch(function () {
        setStatus("Upload a car photo — AI loads on first Process");
      });
  }

  function token() {
    return (window.RCB && window.RCB.getToken()) || localStorage.getItem("rcb_token") || "";
  }

  async function refreshCredits() {
    if (!creditsChip || !window.RCB) return;
    var user = await window.RCB.refreshMe();
    if (user) {
      creditsChip.hidden = false;
      creditsChip.textContent = user.credits + " credits";
    }
  }
  refreshCredits();

  function updateSummary() {
    var bg = backdrop.options[backdrop.selectedIndex].text;
    summary.innerHTML =
      "Mode: " +
      (state.mode === "half" ? "Half-Cut" : "Full-Cut") +
      "<br />Backdrop: " +
      bg +
      "<br />Plate: " +
      (state.plate === "cover" ? "Cover" : "Keep") +
      "<br />Upscale: " +
      upscale.value +
      "×";
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  function enableActions(hasFile) {
    processBtn.disabled = !hasFile;
    clearBtn.disabled = !hasFile;
    downloadBtn.disabled = !hasFile || !state.processed;
  }

  function revoke(url) {
    if (url) URL.revokeObjectURL(url);
  }

  function showFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      setStatus("Please choose an image file");
      return;
    }
    revoke(state.objectUrl);
    revoke(state.resultUrl);
    state.objectUrl = URL.createObjectURL(file);
    state.resultUrl = null;
    state.file = file;
    state.fileName = file.name;
    state.processed = false;
    preview.src = state.objectUrl;
    emptyState.hidden = true;
    previewWrap.hidden = false;
    mockBadge.hidden = true;
    dropzone.classList.add("has-image");
    enableActions(true);
    setStatus("Loaded · " + file.name);
    updateSummary();
  }

  browseBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener("click", function () {
    if (!state.file) fileInput.click();
  });

  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) showFile(fileInput.files[0]);
  });

  ["dragenter", "dragover"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });

  dropzone.addEventListener("drop", function (e) {
    var file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) showFile(file);
  });

  modeSeg.addEventListener("click", function (e) {
    var btn = e.target.closest("button");
    if (!btn) return;
    modeSeg.querySelectorAll("button").forEach(function (b) {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    state.mode = btn.dataset.mode;
    updateSummary();
  });

  plateSeg.addEventListener("click", function (e) {
    var btn = e.target.closest("button");
    if (!btn) return;
    plateSeg.querySelectorAll("button").forEach(function (b) {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    state.plate = btn.dataset.plate;
    if (plateText) plateText.hidden = state.plate !== "cover";
    updateSummary();
  });

  backdrop.addEventListener("change", updateSummary);
  upscale.addEventListener("input", function () {
    upscaleLabel.textContent =
      upscale.value + "×" + (upscale.value === "1" ? " (original)" : " sharp upscale");
    updateSummary();
  });

  // Load custom brand backdrops into select
  (async function loadCustomBackdrops() {
    var t = token();
    if (!t || !backdrop) return;
    try {
      var res = await fetch(ROOT + "/api/backdrops", {
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

  processBtn.addEventListener("click", async function () {
    if (!state.file) return;
    if (!window.RCB_BG || !window.RCB_BG.processFile) {
      setStatus("Background engine missing — refresh the page");
      return;
    }
    processBtn.disabled = true;
    downloadBtn.disabled = true;
    var started = Date.now();
    setStatus("Loading AI in your browser (first time only)…");
    mockBadge.hidden = false;
    mockBadge.textContent =
      (state.mode === "half" ? "HALF-CUT" : "FULL-CUT") + " · WORKING";

    var tick = setInterval(function () {
      var s = Math.round((Date.now() - started) / 1000);
      setStatus("Working in browser… " + s + "s — do not close this tab");
    }, 1000);

    try {
      var blob = await window.RCB_BG.processFile(
        state.file,
        {
          mode: state.mode,
          backdrop: backdrop.value,
          plate: state.plate,
          plateText: (plateText && plateText.value) || "PRIVATE",
          upscale: upscale.value,
        },
        function (key, current, total) {
          if (!total) return;
          var pct = Math.round((current / total) * 100);
          setStatus("AI model: " + key + " " + pct + "%");
        }
      );
      revoke(state.resultUrl);
      state.resultUrl = URL.createObjectURL(blob);
      preview.src = state.resultUrl;
      state.processed = true;
      mockBadge.textContent =
        (state.mode === "half" ? "HALF-CUT" : "FULL-CUT") +
        (state.plate === "cover" ? " · PLATE" : "") +
        (upscale.value !== "1" ? " · " + upscale.value + "×" : "") +
        " · DONE";
      setStatus(
        "Done in " + Math.round((Date.now() - started) / 1000) + "s — download PNG"
      );
      history.innerHTML =
        '<div class="history-item"><div class="history-thumb"></div><div><div>' +
        (state.fileName || "image") +
        "</div><span class=\"status-pill\">Processed</span></div></div>";
    } catch (err) {
      mockBadge.textContent = "ERROR";
      setStatus(err.message || "Processing failed — try Chrome/Edge and refresh");
    } finally {
      clearInterval(tick);
      enableActions(!!state.file);
    }
  });

  downloadBtn.addEventListener("click", function () {
    var url = state.resultUrl || state.objectUrl;
    if (!url) return;
    var a = document.createElement("a");
    a.href = url;
    a.download =
      "rcb-" +
      state.mode +
      "-" +
      (state.fileName || "car").replace(/\.[^.]+$/, "") +
      ".png";
    a.click();
    setStatus("Download started");
  });

  clearBtn.addEventListener("click", function () {
    revoke(state.objectUrl);
    revoke(state.resultUrl);
    state.objectUrl = null;
    state.resultUrl = null;
    state.file = null;
    state.fileName = null;
    state.processed = false;
    preview.removeAttribute("src");
    emptyState.hidden = false;
    previewWrap.hidden = true;
    mockBadge.hidden = true;
    dropzone.classList.remove("has-image");
    fileInput.value = "";
    enableActions(false);
    setStatus("Waiting for upload");
  });

  updateSummary();
})();
