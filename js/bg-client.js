/**
 * Dealer-grade browser background removal.
 * Drops floating tree/sky junk by keeping only the main car silhouette.
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
  // Quality + speed: fp16 is sharp enough; 896px holds edges without 200s hangs
  var MODEL = "isnet_fp16";
  var PROCESS_MAX_SIDE = 896;
  var PROCESS_TIMEOUT_MS = 50000;
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
      proxyToWorker: false,
      output: { format: "image/png", quality: 1 },
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
              " timed out — refresh, wait for AI ready, try again"
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
      return blobFromCanvas(canvasFromImage(img), "image/jpeg", 0.92);
    }
    var canvas = canvasFromImage(
      img,
      Math.max(1, Math.round(w * scale)),
      Math.max(1, Math.round(h * scale))
    );
    return blobFromCanvas(canvas, "image/jpeg", 0.92);
  }

  /**
   * Keep only the main car blob — deletes floating trees/sky islands above the roof.
   * Prefers the largest connected region that sits in the lower part of the frame.
   */
  function keepMainCarBlob(data, w, h) {
    var n = w * h;
    var labels = new Int32Array(n);
    var solid = new Uint8Array(n);
    var i;
    for (i = 0; i < n; i++) {
      solid[i] = data[i * 4 + 3] >= 110 ? 1 : 0;
    }

    // Break thin bridges to floating tree junk, then we'll dilate the car back
    function erodeInPlace(src) {
      var out = new Uint8Array(src);
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var p = y * w + x;
          if (!src[p]) continue;
          if (
            !src[p - 1] ||
            !src[p + 1] ||
            !src[p - w] ||
            !src[p + w]
          ) {
            out[p] = 0;
          }
        }
      }
      return out;
    }
    function dilateLabel(keepId) {
      var add = [];
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var p = y * w + x;
          if (labels[p] === keepId) continue;
          if (
            labels[p - 1] === keepId ||
            labels[p + 1] === keepId ||
            labels[p - w] === keepId ||
            labels[p + w] === keepId
          ) {
            add.push(p);
          }
        }
      }
      for (var j = 0; j < add.length; j++) labels[add[j]] = keepId;
    }

    solid = erodeInPlace(solid);
    solid = erodeInPlace(solid);

    var label = 0;
    var areas = [];
    var cySum = [];
    var minY = [];
    var maxY = [];
    var stack = new Int32Array(n);
    var dx = [1, -1, 0, 0];
    var dy = [0, 0, 1, -1];

    for (i = 0; i < n; i++) {
      if (!solid[i] || labels[i]) continue;
      label++;
      var top = 0;
      stack[top++] = i;
      labels[i] = label;
      var area = 0;
      var yAcc = 0;
      var yMin = h;
      var yMax = 0;
      while (top) {
        var p = stack[--top];
        var px = p % w;
        var py = (p / w) | 0;
        area++;
        yAcc += py;
        if (py < yMin) yMin = py;
        if (py > yMax) yMax = py;
        for (var k = 0; k < 4; k++) {
          var nx = px + dx[k];
          var ny = py + dy[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var ni = ny * w + nx;
          if (!solid[ni] || labels[ni]) continue;
          labels[ni] = label;
          stack[top++] = ni;
        }
      }
      areas[label] = area;
      cySum[label] = yAcc;
      minY[label] = yMin;
      maxY[label] = yMax;
    }

    if (label === 0) return;

    var best = 1;
    var bestScore = -1;
    var minArea = Math.max(60, Math.floor(n * 0.006));
    for (var id = 1; id <= label; id++) {
      var a = areas[id] || 0;
      if (a < minArea) continue;
      var cy = cySum[id] / a;
      var lowBias = cy / h;
      var touchesBottom = maxY[id] > h * 0.55 ? 1.4 : 0.45;
      var skyPenalty = minY[id] < h * 0.1 && maxY[id] < h * 0.42 ? 0.2 : 1;
      var score = a * (0.4 + lowBias) * touchesBottom * skyPenalty;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }

    // Grow car silhouette back after erode
    dilateLabel(best);
    dilateLabel(best);

    for (i = 0; i < n; i++) {
      if (labels[i] !== best) {
        data[i * 4] = 0;
        data[i * 4 + 1] = 0;
        data[i * 4 + 2] = 0;
        data[i * 4 + 3] = 0;
      }
    }

    // Hard clear anything well above the car roof (leftover sky/trees)
    var roof = minY[best];
    if (roof > 8) {
      var clearTo = Math.max(0, roof - 4);
      for (i = 0; i < clearTo * w; i++) {
        data[i * 4 + 3] = 0;
      }
    }
  }

  /** Despill + harden edges after blob filter. */
  function polishAlpha(data, w, h) {
    var n = w * h;
    var i;
    for (i = 0; i < n; i++) {
      var o = i * 4;
      var r = data[o];
      var g = data[o + 1];
      var b = data[o + 2];
      var a = data[o + 3];
      if (a === 0) continue;
      if (a < 40) {
        data[o + 3] = 0;
        continue;
      }
      var greenBias = g - Math.max(r, b);
      // Any leftover foliage tint on edges
      if (a < 230 && greenBias > 12) {
        data[o + 3] = 0;
        continue;
      }
      // Dark fuzzy tree bits (not green) with weak alpha
      if (a < 160 && r < 70 && g < 90 && b < 70) {
        data[o + 3] = 0;
        continue;
      }
      if (greenBias > 6) {
        data[o + 1] = Math.max(0, g - Math.min(greenBias, 28));
      }
      if (data[o + 3] < 110) data[o + 3] = 0;
      else if (data[o + 3] < 210)
        data[o + 3] = Math.round((data[o + 3] - 110) * (255 / 100));
      else data[o + 3] = 255;
    }

    // 1px smooth on soft edge only
    var copy = new Uint8ClampedArray(data);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var idx = (y * w + x) * 4 + 3;
        var c0 = copy[idx];
        if (c0 === 0 || c0 === 255) continue;
        var sum = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            sum += copy[((y + dy) * w + (x + dx)) * 4 + 3];
          }
        }
        data[idx] = (sum / 9) | 0;
      }
    }
  }

  async function refineCutoutBlob(cutoutBlob) {
    var img = await loadImage(cutoutBlob);
    var canvas = canvasFromImage(img);
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    keepMainCarBlob(imageData.data, canvas.width, canvas.height);
    polishAlpha(imageData.data, canvas.width, canvas.height);
    ctx.putImageData(imageData, 0, 0);
    return blobFromCanvas(canvas, "image/png");
  }

  /**
   * Rebuild cutout from ORIGINAL pixels using refined alpha (sharper car, clean edges).
   */
  async function remaskOriginal(originalFile, cutoutBlob) {
    var orig = await loadImage(originalFile);
    var cut = await loadImage(cutoutBlob);
    var w = orig.naturalWidth;
    var h = orig.naturalHeight;

    var maskC = document.createElement("canvas");
    maskC.width = w;
    maskC.height = h;
    var mctx = maskC.getContext("2d", { willReadFrequently: true });
    mctx.imageSmoothingEnabled = true;
    mctx.imageSmoothingQuality = "high";
    mctx.clearRect(0, 0, w, h);
    mctx.drawImage(cut, 0, 0, w, h);
    var mask = mctx.getImageData(0, 0, w, h);
    // Re-run blob keep at full res so upscaled junk doesn't return
    keepMainCarBlob(mask.data, w, h);
    polishAlpha(mask.data, w, h);

    var out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    var octx = out.getContext("2d", { willReadFrequently: true });
    octx.drawImage(orig, 0, 0, w, h);
    var rgba = octx.getImageData(0, 0, w, h);
    var od = rgba.data;
    var md = mask.data;
    for (var i = 0; i < od.length; i += 4) {
      od[i + 3] = md[i + 3];
    }
    octx.putImageData(rgba, 0, 0);
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
      finalCut = await remaskOriginal(fileOrBlob, refined);
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
        /* continue */
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
