/**
 * Own RemoveCarBackground API — POST /api/process (server rembg).
 * Falls back to browser RCB_BG only if the API is down / OOM.
 */
(function (global) {
  var API_TIMEOUT_MS = 45000;

  function authHeaders() {
    var h = {};
    try {
      var t = localStorage.getItem("rcb_token");
      if (t) h.Authorization = "Bearer " + t;
    } catch (e) {}
    return h;
  }

  function apiRoot() {
    return global.RCB_API || global.location.origin;
  }

  async function healthOk() {
    try {
      var res = await fetch(apiRoot() + "/api/health", {
        mode: "cors",
        cache: "no-store",
      });
      if (!res.ok) return false;
      var j = await res.json();
      return j && j.status === "ok";
    } catch (e) {
      return false;
    }
  }

  async function processViaApi(file, opts) {
    opts = opts || {};
    var fd = new FormData();
    fd.append("file", file, file.name || "car.jpg");
    fd.append("mode", opts.mode || "full");
    fd.append("backdrop", opts.backdrop || "studio-white");
    fd.append("plate", opts.plate || "none");
    fd.append("plate_text", opts.plateText || "PRIVATE");
    fd.append("upscale", String(opts.upscale || "1"));
    fd.append("save", "1");

    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      ctrl.abort();
    }, API_TIMEOUT_MS);

    try {
      var res = await fetch(apiRoot() + "/api/process", {
        method: "POST",
        body: fd,
        headers: authHeaders(),
        mode: "cors",
        signal: ctrl.signal,
      });
      if (!res.ok) {
        var detail = "";
        try {
          var err = await res.json();
          detail = err.detail || JSON.stringify(err);
        } catch (e2) {
          detail = await res.text();
        }
        throw new Error(detail || "API process failed (" + res.status + ")");
      }
      return await res.blob();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Prefer own API. If API fails (free-tier OOM, sleep, network), use browser AI.
   */
  async function processFile(file, opts, onProgress) {
    opts = opts || {};
    var forceBrowser = opts.forceBrowser === true;
    var forceApi = opts.forceApi === true;

    if (!forceBrowser) {
      try {
        if (typeof onProgress === "function") onProgress("api", 0, 1);
        var blob = await processViaApi(file, opts);
        if (typeof onProgress === "function") onProgress("api", 1, 1);
        return blob;
      } catch (apiErr) {
        if (forceApi) throw apiErr;
        // fall through to browser
        if (typeof onProgress === "function") {
          onProgress("browser-fallback", 0, 1);
        }
      }
    }

    if (!global.RCB_BG || !global.RCB_BG.processFileBrowser) {
      if (!global.RCB_BG || !global.RCB_BG._browserProcess) {
        throw new Error(
          "Own API unavailable and browser AI missing — refresh, or deploy API with more RAM"
        );
      }
    }
    var browserFn =
      global.RCB_BG.processFileBrowser || global.RCB_BG._browserProcess;
    return browserFn(file, opts, onProgress);
  }

  global.RCB_API_CLIENT = {
    healthOk: healthOk,
    processViaApi: processViaApi,
    processFile: processFile,
  };
})(typeof window !== "undefined" ? window : globalThis);
