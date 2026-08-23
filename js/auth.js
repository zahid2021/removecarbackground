(function () {
  var TOKEN_KEY = "rcb_token";
  var USER_KEY = "rcb_user";
  var VAULT_KEY = "rcb_accounts_v1";
  var API = window.RCB_API || window.location.origin;

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function readUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch (e) {
      return null;
    }
  }

  function saveSession(token, user) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function isLocalToken(t) {
    return !!(t && String(t).indexOf("local.") === 0);
  }

  function authHeaders() {
    var t = getToken();
    return t
      ? { Authorization: "Bearer " + t, "Content-Type": "application/json" }
      : { "Content-Type": "application/json" };
  }

  function errDetail(json, fallback) {
    if (!json || json.detail == null) return fallback;
    if (typeof json.detail === "string") return json.detail;
    if (Array.isArray(json.detail)) {
      return json.detail
        .map(function (d) {
          return d.msg || d.message || JSON.stringify(d);
        })
        .join("; ");
    }
    return String(json.detail);
  }

  function loadVault() {
    try {
      return JSON.parse(localStorage.getItem(VAULT_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveVault(vault) {
    localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  }

  function b64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromB64(str) {
    var bin = atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function hashPassword(password, saltB64) {
    var enc = new TextEncoder();
    var salt = saltB64
      ? fromB64(saltB64)
      : crypto.getRandomValues(new Uint8Array(16));
    var keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(String(password)),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    var bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt, iterations: 120000, hash: "SHA-256" },
      keyMaterial,
      256
    );
    return { hash: b64(new Uint8Array(bits)), salt: b64(salt) };
  }

  async function rememberAccount(email, password, user) {
    var key = String(email || "")
      .trim()
      .toLowerCase();
    if (!key || !password || !user) return;
    var hashed = await hashPassword(password);
    var vault = loadVault();
    vault[key] = {
      hash: hashed.hash,
      salt: hashed.salt,
      user: {
        id: user.id || "local",
        email: user.email || key,
        name: user.name || "Dealer",
        company: user.company || "",
        plan: user.plan || "Silver",
        credits: typeof user.credits === "number" ? user.credits : 360,
        role: user.role || "admin",
      },
    };
    saveVault(vault);
  }

  async function loginLocal(email, password) {
    var key = String(email || "")
      .trim()
      .toLowerCase();
    var rec = loadVault()[key];
    if (!rec) return null;
    var got = await hashPassword(password, rec.salt);
    if (got.hash !== rec.hash) return null;
    return {
      token: "local." + b64(crypto.getRandomValues(new Uint8Array(24))),
      user: rec.user,
    };
  }

  function localUserFromSignup(data) {
    var plan = data.get("plan") || "Silver";
    var creditsMap = {
      Core: 80,
      Starter: 160,
      Silver: 360,
      Gold: 600,
      Platinum: 1200,
      Enterprise: 2400,
    };
    return {
      id: "local-" + Date.now(),
      email: String(data.get("email") || "")
        .trim()
        .toLowerCase(),
      name: String(data.get("name") || "").trim() || "Dealer",
      company: String(data.get("company") || "").trim(),
      plan: plan,
      credits: creditsMap[plan] || 360,
      role: "admin",
    };
  }

  window.RCB = {
    getToken: getToken,
    readUser: readUser,
    saveSession: saveSession,
    clearSession: clearSession,
    authHeaders: authHeaders,
    api: API,
    async refreshMe() {
      var t = getToken();
      if (!t) return null;
      // Local durable session — survives API sleep / wiped SQLite
      if (isLocalToken(t)) {
        return readUser();
      }
      try {
        var res = await fetch(API + "/api/auth/me", {
          headers: { Authorization: "Bearer " + t },
        });
        if (res.ok) {
          var data = await res.json();
          saveSession(t, data.user);
          return data.user;
        }
      } catch (e) {
        /* API cold / offline */
      }
      // Keep last known user if we still have a vaulted account
      var cached = readUser();
      if (cached && cached.email && loadVault()[String(cached.email).toLowerCase()]) {
        var localTok =
          "local." + b64(crypto.getRandomValues(new Uint8Array(24)));
        saveSession(localTok, cached);
        return cached;
      }
      clearSession();
      return null;
    },
  };

  var loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var data = new FormData(loginForm);
      var email = data.get("email");
      var password = data.get("password");
      var btn = loginForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        var res = await fetch(API + "/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email, password: password }),
        });
        var json = await res.json().catch(function () {
          return {};
        });
        if (res.ok && json.token) {
          await rememberAccount(email, password, json.user);
          saveSession(json.token, json.user);
          window.location.href = "account.html";
          return;
        }
        // API wiped users on free sleep — fall back to this browser's vault
        var local = await loginLocal(email, password);
        if (local) {
          saveSession(local.token, local.user);
          window.location.href = "account.html";
          return;
        }
        throw new Error(errDetail(json, "Invalid email or password"));
      } catch (err) {
        // Network error → still try local vault
        try {
          var local2 = await loginLocal(email, password);
          if (local2) {
            saveSession(local2.token, local2.user);
            window.location.href = "account.html";
            return;
          }
        } catch (e2) {
          /* ignore */
        }
        alert(err.message || "Login failed");
        btn.disabled = false;
      }
    });
  }

  var signupForm = document.getElementById("signupForm");
  if (signupForm) {
    signupForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var data = new FormData(signupForm);
      var email = data.get("email");
      var password = data.get("password");
      var btn = signupForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        var res = await fetch(API + "/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: data.get("name"),
            email: email,
            company: data.get("company"),
            password: password,
            plan: data.get("plan") || "Silver",
          }),
        });
        var json = await res.json().catch(function () {
          return {};
        });
        if (res.ok && json.token) {
          await rememberAccount(email, password, json.user);
          saveSession(json.token, json.user);
          if (json.api_key) {
            localStorage.setItem("rcb_api_key_once", json.api_key);
          }
          window.location.href = "account.html";
          return;
        }
        // If email already on dead API / API down — create durable local account
        var detail = errDetail(json, "");
        var allowLocal =
          !res.ok &&
          (res.status >= 500 ||
            res.status === 0 ||
            /already registered|sign up again|No account/i.test(detail) ||
            !detail);
        if (!allowLocal && res.status === 400 && /already registered/i.test(detail)) {
          // Account exists on API but maybe wiped later — still ensure local vault
          var existingLocal = await loginLocal(email, password);
          if (existingLocal) {
            saveSession(existingLocal.token, existingLocal.user);
            window.location.href = "account.html";
            return;
          }
          throw new Error(detail || "Signup failed");
        }
        var user = localUserFromSignup(data);
        await rememberAccount(email, password, user);
        var localTok =
          "local." + b64(crypto.getRandomValues(new Uint8Array(24)));
        saveSession(localTok, user);
        window.location.href = "account.html";
      } catch (err) {
        try {
          var user2 = localUserFromSignup(data);
          await rememberAccount(email, password, user2);
          saveSession(
            "local." + b64(crypto.getRandomValues(new Uint8Array(24))),
            user2
          );
          window.location.href = "account.html";
          return;
        } catch (e2) {
          /* fall through */
        }
        alert(err.message || "Signup failed");
        btn.disabled = false;
      }
    });
  }

  var userName = document.getElementById("userName");
  if (userName) {
    (async function () {
      var user = await window.RCB.refreshMe();
      if (!user) {
        window.location.href = "login.html";
        return;
      }
      userName.textContent = user.name || "Dealer";
      var meta = document.getElementById("userMeta");
      if (meta) {
        meta.textContent =
          (user.company || "Dealership") +
          " · " +
          (user.email || "") +
          (isLocalToken(getToken()) ? " · saved on this device" : " · live credits");
      }
      var creditsVal = document.getElementById("creditsVal");
      if (creditsVal) creditsVal.textContent = user.credits;
      var planVal = document.getElementById("planVal");
      if (planVal) planVal.textContent = user.plan || "Silver";

      var once = localStorage.getItem("rcb_api_key_once");
      var apiKeyBox = document.getElementById("apiKeyOnce");
      if (once && apiKeyBox) {
        apiKeyBox.hidden = false;
        apiKeyBox.querySelector("code").textContent = once;
        localStorage.removeItem("rcb_api_key_once");
      }

      var params = new URLSearchParams(window.location.search);
      if (params.get("paid") === "1" && params.get("session_id") && !isLocalToken(getToken())) {
        await fetch(
          API +
            "/api/billing/confirm?session_id=" +
            encodeURIComponent(params.get("session_id")),
          {
            method: "POST",
            headers: { Authorization: "Bearer " + getToken() },
          }
        );
        user = await window.RCB.refreshMe();
        if (creditsVal && user) creditsVal.textContent = user.credits;
      }

      var keysList = document.getElementById("keysList");
      if (keysList && !isLocalToken(getToken())) {
        var kr = await fetch(API + "/api/keys", {
          headers: { Authorization: "Bearer " + getToken() },
        });
        if (kr.ok) {
          var kd = await kr.json();
          keysList.innerHTML =
            (kd.keys || [])
              .map(function (k) {
                return "<li><code>" + k.key_prefix + "…</code> · " + k.label + "</li>";
              })
              .join("") || "<li>No keys yet</li>";
        }
      } else if (keysList) {
        keysList.innerHTML =
          "<li>Device login — API keys available after Postgres is linked</li>";
      }
    })();
  }

  var logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", function (e) {
      e.preventDefault();
      clearSession();
      window.location.href = "index.html";
    });
  }

  var topupBtn = document.getElementById("topupBtn");
  if (topupBtn) {
    topupBtn.addEventListener("click", async function () {
      topupBtn.disabled = true;
      try {
        if (isLocalToken(getToken())) {
          var u = readUser() || {};
          u.credits = (u.credits || 0) + 100;
          saveSession(getToken(), u);
          var vault = loadVault();
          var ek = String(u.email || "").toLowerCase();
          if (vault[ek]) {
            vault[ek].user = u;
            saveVault(vault);
          }
          var creditsVal = document.getElementById("creditsVal");
          if (creditsVal) creditsVal.textContent = u.credits;
          topupBtn.textContent = "+100 credits added";
          return;
        }
        var res = await fetch(API + "/api/billing/demo-topup", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ credits: 100 }),
        });
        var json = await res.json();
        if (!res.ok) throw new Error(json.detail || "Top-up failed");
        var creditsVal2 = document.getElementById("creditsVal");
        if (creditsVal2) creditsVal2.textContent = json.credits;
        var u2 = readUser();
        if (u2) {
          u2.credits = json.credits;
          saveSession(getToken(), u2);
        }
        topupBtn.textContent = "+100 credits added";
      } catch (err) {
        alert(err.message);
        topupBtn.disabled = false;
      }
    });
  }

  var checkoutBtn = document.getElementById("checkoutBtn");
  if (checkoutBtn) {
    checkoutBtn.addEventListener("click", async function () {
      var plan = document.getElementById("checkoutPlan");
      checkoutBtn.disabled = true;
      try {
        if (isLocalToken(getToken())) {
          throw new Error("Checkout needs server login — demo top-up works on this device");
        }
        var res = await fetch(API + "/api/billing/checkout", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ plan: plan ? plan.value : "Silver" }),
        });
        var json = await res.json();
        if (!res.ok)
          throw new Error(
            typeof json.detail === "string"
              ? json.detail
              : "Checkout unavailable — use demo top-up"
          );
        window.location.href = json.checkout_url;
      } catch (err) {
        alert(err.message);
        checkoutBtn.disabled = false;
      }
    });
  }

  var newKeyBtn = document.getElementById("newKeyBtn");
  if (newKeyBtn) {
    newKeyBtn.addEventListener("click", async function () {
      if (isLocalToken(getToken())) {
        alert("API keys need server account (Postgres). Demo top-up works on this device.");
        return;
      }
      var res = await fetch(API + "/api/keys?label=dms", {
        method: "POST",
        headers: { Authorization: "Bearer " + getToken() },
      });
      var json = await res.json();
      if (!res.ok) {
        alert(json.detail || "Failed");
        return;
      }
      alert("New API key (copy now):\n\n" + json.api_key);
      location.reload();
    });
  }
})();
