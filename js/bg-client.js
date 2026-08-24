/**
 * MotorCut-style browser BG remove — must always complete.
 * Half-cut / Full-cut + plate + backdrop. Cleanup is safe (never blanks the car).
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
  var MODEL = "isnet_fp16";
  var PROCESS_MAX_SIDE = 896;
  var PROCESS_TIMEOUT_MS = 70000;
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
      output: { format: "image/png", quality: 0.95 },
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
            (label || "Process") +
              " timed out — hard refresh (Ctrl+Shift+R), wait for AI ready, try again"
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
      if (typeof src === "string") img.src = src;
      else img.src = URL.createObjectURL(src);
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

  function blobFromCanvas(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(
        function (b) {
          if (b) resolve(b);
          else reject(new Error("Could not export image"));
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
   * Dealer cleanup:
   * 1) keep ONLY the largest blob (car) — drop ALL other islands (trees)
   * 2) light open to cut thin foliage bridges on the roof
   * 3) trim roof spikes above the median roof line
   */
  function safeCleanup(data, w, h) {
    var n = w * h;
    var i;
    var o;

    for (i = 0; i < n; i++) {
      o = i * 4;
      var a = data[o + 3];
      if (a < 28) {
        data[o + 3] = 0;
        continue;
      }
      var r = data[o];
      var g = data[o + 1];
      var b = data[o + 2];
      var greenBias = g - Math.max(r, b);
      if (a < 200 && greenBias > 14) {
        data[o + 3] = 0;
        continue;
      }
      if (a < 150 && g > 85 && b > 65 && r < g - 12) {
        data[o + 3] = 0;
        continue;
      }
      if (greenBias > 6) data[o + 1] = Math.max(0, g - Math.min(greenBias, 28));
      if (data[o + 3] < 90) data[o + 3] = 0;
      else if (data[o + 3] < 210)
        data[o + 3] = Math.round((data[o + 3] - 90) * (255 / 120));
      else data[o + 3] = 255;
    }

    var labels = new Int32Array(n);
    var solid = new Uint8Array(n);
    for (i = 0; i < n; i++) solid[i] = data[i * 4 + 3] >= 128 ? 1 : 0;

    function erodeMask(src) {
      var out = new Uint8Array(src);
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var p = y * w + x;
          if (!src[p]) continue;
          if (!src[p - 1] || !src[p + 1] || !src[p - w] || !src[p + w]) out[p] = 0;
        }
      }
      return out;
    }
    function dilateMask(src) {
      var out = new Uint8Array(src);
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var p = y * w + x;
          if (src[p]) continue;
          if (src[p - 1] || src[p + 1] || src[p - w] || src[p + w]) out[p] = 1;
        }
      }
      return out;
    }

    // Break thin tree bridges, then grow back after we pick the car
    var work = erodeMask(solid);

    var label = 0;
    var areas = [];
    var stack = new Int32Array(n);
    var dx = [1, -1, 0, 0];
    var dy = [0, 0, 1, -1];
    for (i = 0; i < n; i++) {
      if (!work[i] || labels[i]) continue;
      label++;
      var top = 0;
      stack[top++] = i;
      labels[i] = label;
      var area = 0;
      while (top) {
        var p = stack[--top];
        area++;
        var px = p % w;
        var py = (p / w) | 0;
        for (var k = 0; k < 4; k++) {
          var nx = px + dx[k];
          var ny = py + dy[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var ni = ny * w + nx;
          if (!work[ni] || labels[ni]) continue;
          labels[ni] = label;
          stack[top++] = ni;
        }
      }
      areas[label] = area;
    }
    if (label === 0) {
      // erode wiped everything — fall back to original solid largest
      labels = new Int32Array(n);
      work = solid;
      label = 0;
      areas = [];
      for (i = 0; i < n; i++) {
        if (!work[i] || labels[i]) continue;
        label++;
        top = 0;
        stack[top++] = i;
        labels[i] = label;
        area = 0;
        while (top) {
          p = stack[--top];
          area++;
          px = p % w;
          py = (p / w) | 0;
          for (k = 0; k < 4; k++) {
            nx = px + dx[k];
            ny = py + dy[k];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            ni = ny * w + nx;
            if (!work[ni] || labels[ni]) continue;
            labels[ni] = label;
            stack[top++] = ni;
          }
        }
        areas[label] = area;
      }
      if (label === 0) return;
    }

    var largest = 1;
    var largestA = 0;
    for (var id = 1; id <= label; id++) {
      if ((areas[id] || 0) > largestA) {
        largestA = areas[id];
        largest = id;
      }
    }

    var keep = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      if (labels[i] === largest) keep[i] = 1;
    }
    keep = dilateMask(keep);

    // Roof spike trim vs median roof line
    var tops = new Int32Array(w);
    for (var x = 0; x < w; x++) {
      tops[x] = h;
      for (var y = 0; y < h; y++) {
        if (keep[y * w + x]) {
          tops[x] = y;
          break;
        }
      }
    }
    var roofVals = [];
    for (x = 0; x < w; x++) if (tops[x] < h) roofVals.push(tops[x]);
    roofVals.sort(function (a, b) {
      return a - b;
    });
    var medRoof = roofVals.length
      ? roofVals[(roofVals.length / 2) | 0]
      : 0;
    for (x = 0; x < w; x++) {
      if (tops[x] < h && tops[x] < medRoof - 10) {
        for (y = 0; y < medRoof - 2; y++) keep[y * w + x] = 0;
      }
    }

    for (i = 0; i < n; i++) {
      if (!keep[i]) {
        data[i * 4] = 0;
        data[i * 4 + 1] = 0;
        data[i * 4 + 2] = 0;
        data[i * 4 + 3] = 0;
      } else if (data[i * 4 + 3] > 0) {
        data[i * 4 + 3] = 255;
      }
    }
  }

  /** Tight crop car, then center on dealer canvas (fixes tiny lower-right car). */
  async function frameCutout(cutoutBlob, backdropKey) {
    var img = await loadImage(cutoutBlob);
    var src = canvasFromImage(img);
    var ctx = src.getContext("2d", { willReadFrequently: true });
    var w = src.width;
    var h = src.height;
    var data = ctx.getImageData(0, 0, w, h).data;
    var minX = w;
    var minY = h;
    var maxX = 0;
    var maxY = 0;
    var found = false;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] < 16) continue;
        found = true;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (!found) return cutoutBlob;

    var pad = Math.max(12, Math.round(Math.max(maxX - minX, maxY - minY) * 0.06));
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad);
    maxY = Math.min(h - 1, maxY + pad);
    var cw = maxX - minX + 1;
    var ch = maxY - minY + 1;

    var outW = Math.max(cw + 80, Math.round(cw * 1.35));
    var outH = Math.max(ch + 80, Math.round(ch * 1.25));
    var out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    var octx = out.getContext("2d");
    var color = COLORS[backdropKey] || COLORS["studio-white"];
    if (backdropKey === "checker" || color === null) {
      octx.clearRect(0, 0, outW, outH);
    } else {
      octx.fillStyle = "rgb(" + color.join(",") + ")";
      octx.fillRect(0, 0, outW, outH);
    }
    var ox = ((outW - cw) / 2) | 0;
    var oy = ((outH - ch) * 0.55) | 0;
    octx.drawImage(src, minX, minY, cw, ch, ox, oy, cw, ch);
    return blobFromCanvas(out, "image/png");
  }

  async function refineCutoutBlob(cutoutBlob) {
    try {
      var img = await loadImage(cutoutBlob);
      var canvas = canvasFromImage(img);
      var ctx = canvas.getContext("2d", { willReadFrequently: true });
      var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      safeCleanup(imageData.data, canvas.width, canvas.height);
      ctx.putImageData(imageData, 0, 0);
      return await blobFromCanvas(canvas, "image/png");
    } catch (e) {
      // Cleanup must never block delivery
      return cutoutBlob;
    }
  }

  async function upscaleToOriginal(originalFile, cutoutBlob) {
    var orig = await loadImage(originalFile);
    var cut = await loadImage(cutoutBlob);
    var w = orig.naturalWidth;
    var h = orig.naturalHeight;
    if (
      Math.abs(cut.naturalWidth - w) < 4 &&
      Math.abs(cut.naturalHeight - h) < 4
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
      var cfg = configBase();
      if (typeof onProgress === "function") onProgress("download", 0, 1);
      if (typeof mod.preload === "function") {
        await withTimeout(mod.preload(cfg), 120000, "AI model download");
      } else {
        var c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        var tiny = await new Promise(function (resolve) {
          c.toBlob(resolve, "image/png");
        });
        await withTimeout(mod.removeBackground(tiny, cfg), 120000, "AI warmup");
      }
      ready = true;
      if (typeof onProgress === "function") onProgress("download", 1, 1);
      return true;
    })();
    return warmPromise;
  }

  async function removeBg(fileOrBlob, onProgress) {
    var mod = await loadLib();
    if (!mod.removeBackground)
      throw new Error("AI failed to load — use Chrome or Edge");

    var cfg = configBase();
    cfg.progress = function (key, current, total) {
      if (typeof onProgress === "function" && total) onProgress(key, current, total);
    };

    if (typeof onProgress === "function") onProgress("compute", 0, 1);
    var input = await resizeBlob(fileOrBlob, PROCESS_MAX_SIDE);
    var rawCut = await withTimeout(
      mod.removeBackground(input, cfg),
      PROCESS_TIMEOUT_MS,
      "Background remove"
    );
    var refined = await refineCutoutBlob(rawCut);
    try {
      refined = await upscaleToOriginal(fileOrBlob, refined);
    } catch (e) {
      /* keep refined */
    }
    ready = true;
    if (typeof onProgress === "function") onProgress("compute", 1, 1);
    return refined;
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

  /**
   * MotorCut-style compose:
   * - Full-cut: replace floor + background
   * - Half-cut: keep original floor/shadows, replace only upper background
   */
  async function compose(cutoutBlob, originalFile, opts) {
    opts = opts || {};
    var mode = opts.mode || "full";
    var backdrop = opts.backdrop || "studio-white";
    var plate = opts.plate || "none";
    var plateText = opts.plateText || "PRIVATE";
    var upscale = Math.max(1, Math.min(2, parseInt(opts.upscale || "1", 10) || 1));

    // Center-crop car onto dealer canvas (MotorCut-style framing)
    var framed = cutoutBlob;
    try {
      framed = await frameCutout(cutoutBlob, mode === "half" ? "checker" : backdrop);
    } catch (e) {
      framed = cutoutBlob;
    }

    var cutImg = await loadImage(framed);
    var w = cutImg.naturalWidth;
    var h = cutImg.naturalHeight;
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");

    var color = COLORS[backdrop];
    if (mode === "half") {
      // Half-cut framed on transparent then we paint floor from original
      ctx.clearRect(0, 0, w, h);
      if (originalFile) {
        var orig = await loadImage(originalFile);
        var floorFrom = Math.floor(h * 0.58);
        var srcY = Math.floor(orig.naturalHeight * 0.58);
        // fill upper with backdrop first
        if (backdrop !== "checker" && color) {
          ctx.fillStyle = "rgb(" + color.join(",") + ")";
          ctx.fillRect(0, 0, w, floorFrom);
        }
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
    } else if (backdrop === "checker" || color === null) {
      ctx.clearRect(0, 0, w, h);
    } else {
      // frameCutout already applied backdrop for full-cut
      ctx.clearRect(0, 0, w, h);
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
    if (!file) throw new Error("No image selected");
    opts = opts || {};
    if (!ready) {
      if (typeof onProgress === "function") onProgress("warmup", 0, 1);
      try {
        await warmup(onProgress);
      } catch (e) {
        /* removeBg loads model */
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
