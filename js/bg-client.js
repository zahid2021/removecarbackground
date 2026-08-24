/**
 * Browser-side background removal — quality-first for dealership photos.
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
  // Quality over speed — quint8@512 caused green tree ghosts + jagged edges
  var MODEL = "isnet";
  var PROCESS_MAX_SIDE = 1280;
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
      proxyToWorker: true,
      output: { format: "image/png", quality: 1 },
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
      canvas.toBlob(function (b) {
        resolve(b);
      }, type || "image/png", quality);
    });
  }

  /** Resize keeping aspect — PNG to avoid JPEG block artifacts before AI. */
  async function resizeBlob(fileOrBlob, maxSide) {
    maxSide = maxSide || PROCESS_MAX_SIDE;
    var img = await loadImage(fileOrBlob);
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    var scale = Math.min(1, maxSide / Math.max(w, h));
    if (scale >= 0.999) {
      if (fileOrBlob instanceof Blob) return fileOrBlob;
      return blobFromCanvas(canvasFromImage(img), "image/png");
    }
    var canvas = canvasFromImage(
      img,
      Math.max(1, Math.round(w * scale)),
      Math.max(1, Math.round(h * scale))
    );
    return blobFromCanvas(canvas, "image/png");
  }

  /**
   * Clean mask: kill floating debris, green tree fringe, harden car silhouette.
   */
  function refineAlphaData(data, w, h) {
    var i;
    var a;
    var r;
    var g;
    var b;
    var n = w * h;

    // Pass 1 — hard-kill weak noise + green/cyan spill (trees/sky leftovers)
    for (i = 0; i < n; i++) {
      var o = i * 4;
      r = data[o];
      g = data[o + 1];
      b = data[o + 2];
      a = data[o + 3];

      if (a < 28) {
        data[o + 3] = 0;
        continue;
      }

      // Semi-transparent fringe that is green-dominant → background junk
      var greenBias = g - Math.max(r, b);
      if (a < 210 && greenBias > 18) {
        data[o + 3] = 0;
        continue;
      }
      // Bright sky/leaf fragments (high G+B, not car paint)
      if (a < 160 && g > 90 && b > 70 && r < g - 15 && greenBias > 8) {
        data[o + 3] = 0;
        continue;
      }

      // Despill remaining edge pixels (pull green toward red/blue)
      if (a < 245 && greenBias > 8) {
        var pull = Math.min(greenBias, 40);
        data[o + 1] = Math.max(0, g - pull);
      }

      // Harden alpha for a clean dealer cut
      if (data[o + 3] > 0 && data[o + 3] < 90) data[o + 3] = 0;
      else if (data[o + 3] >= 90 && data[o + 3] < 180)
        data[o + 3] = Math.round((data[o + 3] - 90) * (255 / 90));
      else if (data[o + 3] >= 180) data[o + 3] = 255;
    }

    // Pass 2 — remove tiny floating islands (3x3: keep only if enough opaque neighbors)
    var copy = new Uint8ClampedArray(data);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var idx = (y * w + x) * 4 + 3;
        if (copy[idx] < 128) continue;
        var solid = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (copy[((y + dy) * w + (x + dx)) * 4 + 3] >= 128) solid++;
          }
        }
        if (solid <= 3) data[idx] = 0;
      }
    }

    // Pass 3 — light edge feather (1px) so tires/body aren't jagged
    copy = new Uint8ClampedArray(data);
    for (y = 1; y < h - 1; y++) {
      for (x = 1; x < w - 1; x++) {
        idx = (y * w + x) * 4 + 3;
        var c0 = copy[idx];
        if (c0 === 0 || c0 === 255) continue;
        var sum = 0;
        var cnt = 0;
        for (dy = -1; dy <= 1; dy++) {
          for (dx = -1; dx <= 1; dx++) {
            sum += copy[((y + dy) * w + (x + dx)) * 4 + 3];
            cnt++;
          }
        }
        data[idx] = Math.round(sum / cnt);
      }
    }
  }

  async function refineCutoutBlob(cutoutBlob) {
    var img = await loadImage(cutoutBlob);
    var canvas = canvasFromImage(img);
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    refineAlphaData(imageData.data, canvas.width, canvas.height);
    ctx.putImageData(imageData, 0, 0);
    return blobFromCanvas(canvas, "image/png");
  }

  /**
   * Apply refined AI alpha onto the ORIGINAL full-resolution photo
   * so the car stays sharp (not the 1024 AI pass).
   */
  async function applyMaskToOriginal(originalFile, cutoutBlob) {
    var orig = await loadImage(originalFile);
    var cut = await loadImage(cutoutBlob);
    var w = orig.naturalWidth;
    var h = orig.naturalHeight;

    var maskCanvas = document.createElement("canvas");
    maskCanvas.width = w;
    maskCanvas.height = h;
    var mctx = maskCanvas.getContext("2d", { willReadFrequently: true });
    mctx.imageSmoothingEnabled = true;
    mctx.imageSmoothingQuality = "high";
    mctx.drawImage(cut, 0, 0, w, h);
    var maskData = mctx.getImageData(0, 0, w, h);
    refineAlphaData(maskData.data, w, h);

    var out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    var octx = out.getContext("2d", { willReadFrequently: true });
    octx.drawImage(orig, 0, 0, w, h);
    var outData = octx.getImageData(0, 0, w, h);
    var od = outData.data;
    var md = maskData.data;
    for (var i = 0; i < od.length; i += 4) {
      od[i + 3] = md[i + 3];
      // Edge despill on RGB from original
      if (od[i + 3] > 0 && od[i + 3] < 250) {
        var gBias = od[i + 1] - Math.max(od[i], od[i + 2]);
        if (gBias > 10) od[i + 1] = Math.max(0, od[i + 1] - Math.min(gBias, 35));
      }
    }
    octx.putImageData(outData, 0, 0);
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
        await preload(cfg);
      } else {
        var c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        var tiny = await new Promise(function (resolve) {
          c.toBlob(resolve, "image/png");
        });
        await mod.removeBackground(tiny, cfg);
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

    if (typeof onProgress === "function") onProgress("compute", 0, 1);
    var input = await resizeBlob(fileOrBlob, PROCESS_MAX_SIDE);
    var rawCut = await removeBackground(input, cfg);
    var refined = await refineCutoutBlob(rawCut);
    // Map clean mask back onto full-resolution original when possible
    var finalCut = refined;
    try {
      finalCut = await applyMaskToOriginal(fileOrBlob, refined);
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

    return blobFromCanvas(canvas, "image/png");
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
