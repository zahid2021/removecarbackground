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
        return "<li>" + (i + 1) + ". " + f.name + " <span class='mute'>(" + Math.round(f.size / 1024) + " KB)</span></li>";
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

  runBtn.addEventListener("click", async function () {
    if (!files.length) return;
    runBtn.disabled = true;
    status.textContent = "Batch processing… first image may load the AI model";

    var fd = new FormData();
    files.forEach(function (f) {
      fd.append("files", f);
    });
    fd.append("mode", mode.value);
    fd.append("backdrop", backdrop.value);
    fd.append("plate", plate.value);
    fd.append("upscale", upscale.value);

    var headers = {};
    var t = (window.RCB && window.RCB.getToken()) || localStorage.getItem("rcb_token") || "";
    if (t) headers.Authorization = "Bearer " + t;

    try {
      var res = await fetch(window.location.origin + "/api/batch", {
        method: "POST",
        body: fd,
        headers: headers,
      });
      if (!res.ok) {
        var err = await res.json().catch(function () {
          return { detail: "Batch failed" };
        });
        throw new Error(err.detail || "Batch failed");
      }
      var blob = await res.blob();
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "rcb-batch.zip";
      a.click();
      status.textContent =
        "Done — ZIP downloaded (" +
        (res.headers.get("X-Batch-Count") || files.length) +
        " images). Credits used: " +
        (res.headers.get("X-Credits-Used") || "0");
    } catch (err) {
      status.textContent = err.message || "Batch failed";
    } finally {
      runBtn.disabled = files.length === 0;
    }
  });

  render();
})();
