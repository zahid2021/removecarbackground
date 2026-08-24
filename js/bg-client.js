/**
 * Browser-side background removal — ~15s target after model is warm.
 * Balanced quality (no green tree ghosts) without the 200s full-isnet path.
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
  // fp16 @ 768: clean enough for dealers, typically ~8–20s after warm
  var MODEL = "isnet_fp16";
  var PROCESS_MAX_SIDE = 768;
  var PROCESS_TIMEOUT_MS = 45000;
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
      model: MODEL,
      device: "gpu",
      // Main thread is faster for one mid-size image than worker round-trips
      proxyToWorker: false,
      output: { format: "image/png", quality: 0.92 },
    };
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        reject(
          new Error(
            (label || "Background remove") +
              " timed out after " +
              Math.round(ms / 1000) +
              "s — refresh and try a smaller photo, or wait for “AI ready” first"
          )
        );
      }, ms);
      promise.then(
        function (v) {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(v);
        },
        function (e) {
          if (done) return;
          done = true;
          clearTimeout(t);
          reject(e);
        }
      );
    });
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

  function canvasFromImage(img, w, h) {
    var canvas = document.createElement("canvas");
    canvas.width = w || img.naturalWidth;
    canvas.height = h || img.naturalHeight;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  async function blobFromCanvas(canvas, type, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(
        function (b) {
          resolve(b);
        },
        type || "image/png",
        quality
      );
    });
  }

  async function resizeBlob(fileOrBlob, maxSide) {
    maxSide = maxSide || PROCESS_MAX_SIDE;
    var img = await loadImage(fileOrBlob);
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    var scale = Math.min(1, maxSide / Math.max(w, h));
    if (scale >= 0.999) {
      if (fileOrBlob instanceof Blob) return fileOrBlob;
      return blobFromCanvas(canvasFromImage(img), "image/jpeg", 0.9);
    }
    var canvas = canvasFromImage(
      img,
      Math.max(1, Math.round(w * scale)),
      Math.max(1, Math.round(h * scale))
    );
    // JPEG is much faster to encode/decode than PNG at this stage
    return blobFromCanvas(canvas, "image/jpeg", 0.9);
  }

  /** Fast single-pass cleanup — kills green fringe without heavy morphology. */
  function refineAlphaFast(data, n) {
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      var r = data[o];
      var g = data[o + 1];
      var b = data[o + 2];
      var a = data[o + 3];
      if (a < 32) {
        data[o + 3] = 0;
        continue;
      }
      var greenBias = g - Math.max(r, b);
      if (a < 200 && greenBias > 16) {
        data[o + 3] = 0;
        continue;
      }
      if (a < 150 && g > 85 && b > 65 && r < g - 12) {
        data[o + 3] = 0;
        continue;
      }
      if (a < 245 && greenBias > 8) {
        data[o + 1] = Math.max(0, g - Math.min(greenBias, 30));
      }
      if (data[o + 3] < 100) data[o + 3] = 0;
      else if (data[o + 3] < 200)
        data[o + 3] = Math.round((data[o + 3] - 100) * (255 / 100));
      else data[o + 3] = 255;
    }
  }

  async function refineCutoutBlob(cutoutBlob) {
    var img = await loadImage(cutoutBlob);
    var canvas = canvasFromImage(img);
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    refineAlphaFast(imageData.data, canvas.width * canvas.height);
    ctx.putImageData(imageData, 0, 0);
    return blobFromCanvas(canvas, "image/png");
  }

  /**
   * Upscale clean cutout to original size via GPU canvas (no per-pixel full-res loop).
   */
  async function upscaleCutoutToOriginal(originalFile, cutoutBlob) {
    var orig = await loadImage(originalFile);
    var cut = await loadImage(cutoutBlob);
    var w = orig.naturalWidth;
    var h = orig.naturalHeight;
    // If already close to original, skip
    if (
      Math.abs(cut.naturalWidth - w) < 8 &&
      Math.abs(cut.naturalHeight - h) < 8
    ) {
      return cutoutBlob;
    }
    var out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    var ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(cut, 0, 0, w, h);
    return blobFromCanvas(out, "image/png");
  }

  async function warmup(onProgress) {
    if (warmPromise) return warmPromise;
    warmPromise = (async function () {
      var mod = await loadLib();
      var preload = mod.preload;
      var cfg = configBase();
      if (typeof onProgress === "function") onProgress("download", 0, 1);
      if (typeof preload === "function") {
        await withTimeout(preload(cfg), 90000, "AI model download");
      } else {
        var c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        var tiny = await new Promise(function (resolve) {
          c.toBlob(resolve, "image/png");
        });
        await withTimeout(
          mod.removeBackground(tiny, cfg),
          90000,
          "AI model download"
        );
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
    if (!removeBackground)
      throw new Error("AI library failed to load — use Chrome/Edge");

    var cfg = configBase();
    cfg.progress = function (key, current, total) {
      if (typeof onProgress === "function" && total) onProgress(key, current, total);
    };

    if (typeof onProgress === "function") onProgress("compute", 0, 1);
    var input = await resizeBlob(fileOrBlob, PROCESS_MAX_SIDE);
    var rawCut = await withTimeout(
      removeBackground(input, cfg),
      PROCESS_TIMEOUT_MS,
      "Background remove"
    );
    var refined = await refineCutoutBlob(rawCut);
    var finalCut = refined;
    try {
      finalCut = await upscaleCutoutToOriginal(fileOrBlob, refined);
    } catch (e) {
      finalCut = refined;
    }
    ready = true;
    if (typeof onProgress === "function") onProgress("compute", 1, 1);
    return finalCut;
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
    ctx.fillText(
      (text || "PRIVATE").slice(0, 10).toUpperCase(),
      x + pw / 2 + 6,
      y + ph / 2
    );
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

    return blobFromCanvas(canvas, "image/png");
  }

  async function processFile(file, opts, onProgress) {
    if (!ready) {
      if (typeof onProgress === "function") onProgress("warmup", 0, 1);
      try {
        await warmup(onProgress);
      } catch (e) {
        /* removeBg will load model */
      }
    }
    var cut = await removeBg(file, onProgress);
    return compose(cut, file, opts);
  }

  global.RCB_BG = {
    COLORS: COLORS,
    MODEL: MODEL,
    ready: function () {
      return ready;
    },
    warmup: warmup,
    removeBg: removeBg,
    compose: compose,
    processFile: processFile,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      warmup().catch(function () {});
    });
  } else {
    warmup().catch(function () {});
  }
})(window);
