/**
 * Browser-side background removal (no Render RAM needed).
 * Uses @imgly/background-removal in the user's browser.
 */
(function (global) {
  var COLORS = {
    "studio-white": [245, 245, 247],
    graphite: [42, 48, 58],
    "brand-red": [120, 18, 28],
    "outdoor-soft": [210, 216, 222],
    checker: null,
  };

  var libPromise = null;

  function loadLib() {
    if (!libPromise) {
      libPromise = import(
        "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.5/+esm"
      ).catch(function () {
        return import("https://esm.sh/@imgly/background-removal@1.5.5");
      });
    }
    return libPromise;
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = reject;
      img.src = typeof src === "string" ? src : URL.createObjectURL(src);
    });
  }

  async function removeBg(fileOrBlob, onProgress) {
    var mod = await loadLib();
    var removeBackground = mod.removeBackground || (mod.default && mod.default.removeBackground);
    if (!removeBackground) throw new Error("Background library failed to load");

    var blob = await removeBackground(fileOrBlob, {
      model: "small",
      output: { format: "image/png", quality: 0.92 },
      progress: function (key, current, total) {
        if (typeof onProgress === "function" && total) {
          onProgress(key, current, total);
        }
      },
    });
    return blob;
  }

  function drawChecker(ctx, w, h, size) {
    size = size || 16;
    for (var y = 0; y < h; y += size) {
      for (var x = 0; x < w; x += size) {
        var on = ((x / size) | 0) % 2 === ((y / size) | 0) % 2;
        ctx.fillStyle = on ? "#e8e8ec" : "#ffffff";
        ctx.fillRect(x, y, size, size);
      }
    }
  }

  function coverPlate(ctx, w, h, text) {
    var pw = Math.max(80, Math.floor(w * 0.22));
    var ph = Math.max(22, Math.floor(pw * 0.3));
    var x = Math.floor((w - pw) / 2);
    var y = Math.floor(h * 0.72);
    ctx.fillStyle = "#f5c814";
    ctx.strokeStyle = "#141414";
    ctx.lineWidth = 2;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, pw, ph, 4);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(x, y, pw, ph);
      ctx.strokeRect(x, y, pw, ph);
    }
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
    var upscale = Math.max(1, Math.min(4, parseInt(opts.upscale || "1", 10) || 1));

    var cutImg = await loadImage(cutoutBlob);
    var w = cutImg.naturalWidth;
    var h = cutImg.naturalHeight;
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");

    var color = COLORS[backdrop];
    if (backdrop === "checker" || color === null) {
      // Transparent PNG — leave clear (download keeps alpha). Preview can show checker via CSS.
      ctx.clearRect(0, 0, w, h);
    } else {
      ctx.fillStyle = "rgb(" + color.join(",") + ")";
      ctx.fillRect(0, 0, w, h);
    }

    if (mode === "half" && originalFile) {
      var orig = await loadImage(originalFile);
      var floorFrom = Math.floor(h * 0.62);
      ctx.drawImage(
        orig,
        0,
        floorFrom,
        orig.naturalWidth,
        orig.naturalHeight - Math.floor(orig.naturalHeight * 0.62),
        0,
        floorFrom,
        w,
        h - floorFrom
      );
    }

    ctx.drawImage(cutImg, 0, 0, w, h);

    if (plate === "cover") {
      coverPlate(ctx, w, h, plateText);
    }

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

    var mime = backdrop === "checker" ? "image/png" : "image/png";
    var blob = await new Promise(function (resolve) {
      canvas.toBlob(function (b) {
        resolve(b);
      }, mime);
    });
    return blob;
  }

  async function processFile(file, opts, onProgress) {
    var cut = await removeBg(file, onProgress);
    return compose(cut, file, opts);
  }

  global.RCB_BG = {
    COLORS: COLORS,
    removeBg: removeBg,
    compose: compose,
    processFile: processFile,
  };
})(window);
