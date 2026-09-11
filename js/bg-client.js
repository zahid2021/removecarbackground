/**
 * MotorCut-style browser BG remove — must always complete.
 * Half-cut / Full-cut + plate + backdrop. Cleanup is safe (never blanks the car).
 */
(function (global) {
  var COLORS = {
    "studio-white": [255, 255, 255],
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
  var preferredDevice = "gpu";

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

  function configBase(device) {
    return {
      publicPath: PUBLIC_PATH,
      model: MODEL,
      device: device || "gpu",
      proxyToWorker: false,
      output: { format: "image/png", quality: 0.95 },
    };
  }

  function isGpuBackendError(err) {
    var msg = String((err && err.message) || err || "");
    return /webgpu|requestAdapterInfo|no available backend|gpu/i.test(msg);
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
      var py = (i / w) | 0;
      var luma = 0.299 * r + 0.587 * g + 0.114 * b;
      // Gray floor / horizon haze in lower half
      if (
        py > h * 0.42 &&
        a < 210 &&
        Math.abs(r - g) < 22 &&
        Math.abs(g - b) < 22 &&
        luma > 55 &&
        luma < 210
      ) {
        data[o] = 0;
        data[o + 1] = 0;
        data[o + 2] = 0;
        data[o + 3] = 0;
        continue;
      }
      if (a < 180 && greenBias > 14) {
        data[o + 3] = 0;
        continue;
      }
      if (a < 140 && g > 85 && b > 65 && r < g - 12) {
        data[o + 3] = 0;
        continue;
      }
      // Do not kill solid dark glass by luma — that chops Tesla/glass roofs
      if (greenBias > 5) data[o + 1] = Math.max(0, g - Math.min(greenBias, 28));
      if (data[o + 3] < 55) data[o + 3] = 0;
      else if (data[o + 3] < 220)
        data[o + 3] = Math.round((data[o + 3] - 55) * (255 / 165));
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

    // Strip thin roof antennas / whip masts (all cars & Jeeps)
    function stripAntennaSpikes(mask) {
      var topY = new Int32Array(w);
      var x;
      for (x = 0; x < w; x++) {
        topY[x] = h;
        for (var y = 0; y < h; y++) {
          if (mask[y * w + x]) {
            topY[x] = y;
            break;
          }
        }
      }
      var tops = [];
      for (x = 0; x < w; x++) {
        if (topY[x] < h) tops.push(topY[x]);
      }
      if (tops.length < 12) return mask;
      tops.sort(function (a, b) {
        return a - b;
      });
      var roof = tops[(tops.length * 0.35) | 0];
      var maxSpikeW = Math.max(4, (w * 0.028) | 0);
      var minSpikeH = Math.max(12, (h * 0.04) | 0);
      var out = new Uint8Array(mask);
      x = 0;
      while (x < w) {
        if (topY[x] >= h || topY[x] >= roof - ((minSpikeH / 2) | 0)) {
          x++;
          continue;
        }
        var x0 = x;
        var minTop = topY[x];
        while (x < w && topY[x] < h && topY[x] < roof - ((minSpikeH / 2) | 0)) {
          if (topY[x] < minTop) minTop = topY[x];
          x++;
        }
        var runW = x - x0;
        var spikeH = roof - minTop;
        if (runW <= maxSpikeW && spikeH >= minSpikeH) {
          for (var xx = x0; xx < x; xx++) {
            for (var yy = 0; yy < roof; yy++) out[yy * w + xx] = 0;
          }
        }
      }
      return out;
    }
    keep = stripAntennaSpikes(keep);

    // Remove leftover floor between tires (cars & Jeeps)
    function stripUndercarriageGround(mask) {
      var ysMin = h,
        ysMax = 0,
        xsMin = w,
        xsMax = 0,
        found = false;
      var p;
      for (p = 0; p < n; p++) {
        if (!mask[p]) continue;
        found = true;
        var px = p % w;
        var py = (p / w) | 0;
        if (px < xsMin) xsMin = px;
        if (px > xsMax) xsMax = px;
        if (py < ysMin) ysMin = py;
        if (py > ysMax) ysMax = py;
      }
      if (!found) return mask;
      var bh = ysMax - ysMin + 1;
      var bw = xsMax - xsMin + 1;
      if (bh < 40 || bw < 40) return mask;
      var band0 = ysMin + ((bh * 0.58) | 0);
      var bottom = new Int32Array(w);
      var thick = new Int32Array(w);
      var x;
      for (x = 0; x < w; x++) bottom[x] = -1;
      for (x = xsMin; x <= xsMax; x++) {
        var t = 0;
        var last = -1;
        for (var y = ysMin; y <= ysMax; y++) {
          if (mask[y * w + x]) {
            last = y;
            if (y >= band0) t++;
          }
        }
        thick[x] = t;
        bottom[x] = last;
      }
      var thr = Math.max(4, (bh * 0.07) | 0);
      var tire = new Uint8Array(w);
      var tireXs = [];
      for (x = xsMin; x <= xsMax; x++) {
        if (thick[x] >= thr && bottom[x] >= ysMin + ((bh * 0.72) | 0)) {
          tire[x] = 1;
          tireXs.push(x);
        }
      }
      if (tireXs.length < 6) return mask;
      var mid = ((xsMin + xsMax) / 2) | 0;
      var left = tireXs.filter(function (v) {
        return v < mid;
      });
      var right = tireXs.filter(function (v) {
        return v >= mid;
      });
      var out = new Uint8Array(mask);
      if (!left.length || !right.length) {
        var chassis0 = ysMin + ((bh * 0.78) | 0);
        for (x = xsMin; x <= xsMax; x++) {
          if (thick[x] < thr && bottom[x] >= chassis0) {
            for (y = chassis0; y <= ysMax; y++) out[y * w + x] = 0;
          }
        }
        return out;
      }
      var L = left[left.length - 1];
      var R = right[0];
      if (R - L < 8) return mask;
      var samples = [];
      function sampleChassis(xs) {
        for (var i = 0; i < xs.length; i++) {
          var xx = xs[i];
          for (var yy = band0; yy <= ysMax; yy++) {
            if (mask[yy * w + xx]) {
              samples.push(yy);
              break;
            }
          }
        }
      }
      sampleChassis(left.slice(-8));
      sampleChassis(right.slice(0, 8));
      if (!samples.length) return mask;
      samples.sort(function (a, b) {
        return a - b;
      });
      var chassis = samples[(samples.length / 2) | 0] + Math.max(2, (bh / 80) | 0);
      chassis = Math.min(ysMax - 2, chassis);
      for (x = L + 1; x < R; x++) {
        for (y = chassis; y <= ysMax; y++) out[y * w + x] = 0;
      }
      var crumbY = ysMin + ((bh * 0.88) | 0);
      for (x = xsMin; x <= xsMax; x++) {
        if (tire[x]) continue;
        if (bottom[x] >= crumbY && thick[x] < thr) {
          for (y = crumbY; y <= ysMax; y++) out[y * w + x] = 0;
        }
      }
      return out;
    }
    keep = stripUndercarriageGround(keep);
    keep = stripAntennaSpikes(keep);

    // Soft AA edge (box blur of mask) instead of hard binary matte
    var soft = new Float32Array(n);
    for (i = 0; i < n; i++) soft[i] = keep[i] ? 255 : 0;
    var blur = new Float32Array(n);
    for (var y2 = 0; y2 < h; y2++) {
      for (var x2 = 0; x2 < w; x2++) {
        var sum = 0;
        var cnt = 0;
        for (var dy2 = -1; dy2 <= 1; dy2++) {
          for (var dx2 = -1; dx2 <= 1; dx2++) {
            var yy = y2 + dy2;
            var xx = x2 + dx2;
            if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
            sum += soft[yy * w + xx];
            cnt++;
          }
        }
        blur[y2 * w + x2] = sum / cnt;
      }
    }
    for (i = 0; i < n; i++) {
      var aa = keep[i] ? Math.max(220, Math.round(blur[i])) : Math.round(blur[i]);
      if (aa < 16 || !keep[i]) {
        data[i * 4] = 0;
        data[i * 4 + 1] = 0;
        data[i * 4 + 2] = 0;
        data[i * 4 + 3] = 0;
      } else {
        data[i * 4 + 3] = aa;
      }
    }
  }

  /** Clean marketplace oval shadow under tires (no gray smear bar). */
  function drawContactShadow(ctx, srcCanvas, minX, minY, cw, ch, ox, oy) {
    try {
      var sctx = srcCanvas.getContext("2d", { willReadFrequently: true });
      var data = sctx.getImageData(minX, minY, cw, ch).data;
      var bottom = -1;
      var left = cw;
      var right = 0;
      for (var y = 0; y < ch; y++) {
        for (var x = 0; x < cw; x++) {
          if (data[(y * cw + x) * 4 + 3] <= 40) continue;
          if (y > bottom) bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
      if (bottom < 0) return;
      var footW = Math.max(16, right - left + 1);
      var sw = Math.max(20, Math.round(footW * 0.92));
      var sh = Math.max(10, Math.round(ch * 0.07));
      var cx = ox + left + footW / 2;
      var cy = oy + bottom - sh / 6;
      ctx.save();
      if (typeof ctx.filter === "string") {
        ctx.filter = "blur(" + Math.max(4, Math.round(sw * 0.04)) + "px)";
      }
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      if (typeof ctx.ellipse === "function") {
        ctx.ellipse(cx, cy, sw / 2, sh / 2, 0, 0, Math.PI * 2);
      } else {
        ctx.arc(cx, cy, sw / 2, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath();
      if (typeof ctx.ellipse === "function") {
        ctx.ellipse(cx, cy + sh * 0.1, sw * 0.32, sh * 0.28, 0, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.restore();
    } catch (e) {
      /* ignore */
    }
  }

  /** Tight crop car, then center on dealer canvas (fixes tiny lower-right car). */
  async function frameCutout(cutoutBlob, backdropKey, withShadow) {
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

    // Extra bottom padding for marketplace contact shadow
    var outW = Math.max(cw + 80, Math.round(cw * 1.35));
    var outH = Math.max(ch + 110, Math.round(ch * 1.34));
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
    var oy = ((outH - ch) * 0.48) | 0;
    if (withShadow !== false) {
      drawContactShadow(octx, src, minX, minY, cw, ch, ox, oy);
    }
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
      try {
        var mod = await loadLib();
        var devices = ["gpu", "cpu"];
        var lastErr = null;
        for (var i = 0; i < devices.length; i++) {
          var cfg = configBase(devices[i]);
          try {
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
            preferredDevice = devices[i];
            if (typeof onProgress === "function") onProgress("download", 1, 1);
            return true;
          } catch (e) {
            lastErr = e;
            if (!isGpuBackendError(e) || devices[i] === "cpu") throw e;
            // WebGPU broken in this browser — try WASM/CPU
          }
        }
        throw lastErr || new Error("AI warmup failed");
      } catch (e) {
        warmPromise = null;
        ready = false;
        throw e;
      }
    })();
    return warmPromise;
  }

  async function removeBg(fileOrBlob, onProgress) {
    var mod = await loadLib();
    if (!mod.removeBackground)
      throw new Error("AI failed to load — use Chrome or Edge");

    var devices = preferredDevice === "cpu" ? ["cpu"] : ["gpu", "cpu"];
    var lastErr = null;

    for (var i = 0; i < devices.length; i++) {
      var cfg = configBase(devices[i]);
      cfg.progress = function (key, current, total) {
        if (typeof onProgress === "function" && total) onProgress(key, current, total);
      };
      try {
        if (typeof onProgress === "function") onProgress("compute", 0, 1);
        var input = await resizeBlob(fileOrBlob, PROCESS_MAX_SIDE);
        var rawCut = await withTimeout(
          mod.removeBackground(input, cfg),
          PROCESS_TIMEOUT_MS,
          "Background remove"
        );
        preferredDevice = devices[i];
        var refined = await refineCutoutBlob(rawCut);
        try {
          refined = await upscaleToOriginal(fileOrBlob, refined);
        } catch (e) {
          /* keep refined */
        }
        ready = true;
        if (typeof onProgress === "function") onProgress("compute", 1, 1);
        return refined;
      } catch (e) {
        lastErr = e;
        if (!isGpuBackendError(e) || devices[i] === "cpu") break;
      }
    }

    var msg = String((lastErr && lastErr.message) || lastErr || "AI failed");
    if (isGpuBackendError(lastErr)) {
      throw new Error(
        "Browser AI failed (WebGPU/CPU). Use Chrome/Edge latest, or hard refresh. " +
          msg.replace(/Please check if the publicPath[^.]+\.?/i, "").trim()
      );
    }
    throw lastErr || new Error("Background remove failed");
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
      // Full-cut: marketplace contact shadow. Half-cut keeps real floor shadows.
      framed = await frameCutout(
        cutoutBlob,
        mode === "half" ? "checker" : backdrop,
        mode !== "half"
      );
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

  async function processFileBrowser(file, opts, onProgress) {
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

  /** Prefer own server API; browser AI is fallback only. */
  async function processFile(file, opts, onProgress) {
    if (global.RCB_API_CLIENT && global.RCB_API_CLIENT.processFile) {
      return global.RCB_API_CLIENT.processFile(file, opts, onProgress);
    }
    return processFileBrowser(file, opts, onProgress);
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
    processFileBrowser: processFileBrowser,
    _browserProcess: processFileBrowser,
  };

  // Browser warmup only as fallback — own API is primary
  function maybeWarmupBrowser() {
    if (!global.RCB_API_CLIENT) {
      warmup().catch(function () {});
      return;
    }
    global.RCB_API_CLIENT.healthOk().then(function (ok) {
      if (!ok) warmup().catch(function () {});
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", maybeWarmupBrowser);
  } else {
    maybeWarmupBrowser();
  }
})(window);
