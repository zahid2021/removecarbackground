/**
 * Browser-side background removal — fast path for the live website.
 * Does NOT use the Render Python API (that OOMs on free plan).
 */
(function (global) {
  var COLORS = {
    "studio-white": [245, 245, 247],
    graphite: [42, 48, 58],
    "brand-red": [120, 18, 28],
    "outdoor-soft": [210, 216, 222],
    checker: null,
  };

  var VERSION = "1.5.5";
  var PUBLIC_PATH =
    "https://staticimgly.com/@imgly/background-removal-data/" + VERSION + "/dist/";
  var libPromise = null;
  var warmPromise = null;
  var ready = false;

  function loadLib() {
    if (!libPromise) {
      libPromise = import(
        "https://cdn.jsdelivr.net/npm/@imgly/background-removal@" + VERSION + "/+esm"
      ).catch(function () {
        return import(
          "https://esm.sh/@imgly/background-removal@" + VERSION + "?bundle"
        );
      });
    }
    return libPromise;
  }

  function configBase() {
    return {
      publicPath: PUBLIC_PATH,
      // quantized = fastest (~1s after model cached)
      model: "isnet_quint8",
      device: "gpu",
      proxyToWorker: true,
      output: { format: "image/png", quality: 0.85 },
    };
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error("Could not decode image"));
      };
      if (typeof src === "string") {
        img.src = src;
      } else {
        img.src = URL.createObjectURL(src);
      }
    });
  }

  /** Shrink before AI — big win for speed (target ~1s after warmup). */
  async function downscaleBlob(fileOrBlob, maxSide) {
    maxSide = maxSide || 768;
    var img = await loadImage(fileOrBlob);
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    var scale = Math.min(1, maxSide / Math.max(w, h));
    if (scale >= 1) {
      if (fileOrBlob instanceof Blob) return fileOrBlob;
      return fileOrBlob;
    }
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    var ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise(function (resolve) {
      canvas.toBlob(function (b) {
        resolve(b || fileOrBlob);
      }, "image/jpeg", 0.92);
    });
  }

  async function warmup(onProgress) {
    if (warmPromise) return warmPromise;
    warmPromise = (async function () {
      var mod = await loadLib();
      var preload = mod.preload;
      var cfg = configBase();
      if (typeof onProgress === "function") onProgress("download", 0, 1);
      if (typeof preload === "function") {
        await preload(cfg);
      } else {
        // Force model fetch with a tiny canvas
        var c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        var tiny = await new Promise(function (resolve) {
          c.toBlob(resolve, "image/png");
        });
        var removeBackground = mod.removeBackground;
        await removeBackground(tiny, cfg);
      }
      ready = true;
      if (typeof onProgress === "function") onProgress("download", 1, 1);
      return true;
    })();
    return warmPromise;
  }

  async function removeBg(fileOrBlob, onProgress) {
    var mod = await loadLib();
    var removeBackground = mod.removeBackground;
    if (!removeBackground) throw new Error("AI library failed to load — use Chrome/Edge");

    var cfg = configBase();
    cfg.progress = function (key, current, total) {
      if (typeof onProgress === "function" && total) onProgress(key, current, total);
    };

    var input = await downscaleBlob(fileOrBlob, 768);
    var blob = await removeBackground(input, cfg);
    ready = true;
    return blob;
  }

  function coverPlate(ctx, w, h, text) {
    var pw = Math.max(80, Math.floor(w * 0.22));
    var ph = Math.max(22, Math.floor(pw * 0.3));
    var x = Math.floor((w - pw) / 2);
    var y = Math.floor(h * 0.72);
    ctx.fillStyle = "#f5c814";
    ctx.strokeStyle = "#141414";
    ctx.lineWidth = 2;
    ctx.fillRect(x, y, pw, ph);
    ctx.strokeRect(x, y, pw, ph);
    ctx.fillStyle = "#14378c";
    ctx.fillRect(x + 1, y + 1, Math.floor(pw / 7), ph - 2);
    ctx.fillStyle = "#111";
    ctx.font = "bold " + Math.max(10, Math.floor(ph * 0.45)) + "px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((text || "PRIVATE").slice(0, 10).toUpperCase(), x + pw / 2 + 6, y + ph / 2);
  }

  async function compose(cutoutBlob, originalFile, opts) {
    opts = opts || {};
    var mode = opts.mode || "full";
    var backdrop = opts.backdrop || "studio-white";
    var plate = opts.plate || "none";
    var plateText = opts.plateText || "PRIVATE";
    var upscale = Math.max(1, Math.min(2, parseInt(opts.upscale || "1", 10) || 1));

    var cutImg = await loadImage(cutoutBlob);
    var w = cutImg.naturalWidth;
    var h = cutImg.naturalHeight;
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");

    var color = COLORS[backdrop];
    if (backdrop === "checker" || color === null) {
      ctx.clearRect(0, 0, w, h);
    } else {
      ctx.fillStyle = "rgb(" + color.join(",") + ")";
      ctx.fillRect(0, 0, w, h);
    }

    if (mode === "half" && originalFile) {
      var orig = await loadImage(originalFile);
      var floorFrom = Math.floor(h * 0.62);
      var srcY = Math.floor(orig.naturalHeight * 0.62);
      ctx.drawImage(
        orig,
        0,
        srcY,
        orig.naturalWidth,
        orig.naturalHeight - srcY,
        0,
        floorFrom,
        w,
        h - floorFrom
      );
    }

    ctx.drawImage(cutImg, 0, 0, w, h);

    if (plate === "cover") coverPlate(ctx, w, h, plateText);

    if (upscale > 1) {
      var up = document.createElement("canvas");
      up.width = w * upscale;
      up.height = h * upscale;
      var uctx = up.getContext("2d");
      uctx.imageSmoothingEnabled = true;
      uctx.imageSmoothingQuality = "high";
      uctx.drawImage(canvas, 0, 0, up.width, up.height);
      canvas = up;
    }

    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b);
        else reject(new Error("Could not export PNG"));
      }, "image/png");
    });
  }

  async function processFile(file, opts, onProgress) {
    if (!ready) {
      if (typeof onProgress === "function") onProgress("warmup", 0, 1);
      try {
        await warmup(onProgress);
      } catch (e) {
        /* continue — removeBg will load model */
      }
    }
    var cut = await removeBg(file, onProgress);
    return compose(cut, file, opts);
  }

  global.RCB_BG = {
    COLORS: COLORS,
    ready: function () {
      return ready;
    },
    warmup: warmup,
    removeBg: removeBg,
    compose: compose,
    processFile: processFile,
  };

  // Start downloading the AI model as soon as the editor/batch page opens
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      warmup().catch(function () {});
    });
  } else {
    warmup().catch(function () {});
  }
})(window);
