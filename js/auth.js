(function () {
  var TOKEN_KEY = "rcb_token";
  var USER_KEY = "rcb_user";
  var API = window.location.origin;

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

  function authHeaders() {
    var t = getToken();
    return t ? { Authorization: "Bearer " + t, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
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
      var res = await fetch(API + "/api/auth/me", { headers: { Authorization: "Bearer " + t } });
      if (!res.ok) {
        clearSession();
        return null;
      }
      var data = await res.json();
      saveSession(t, data.user);
      return data.user;
    },
  };

  var loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var data = new FormData(loginForm);
      var btn = loginForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        var res = await fetch(API + "/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: data.get("email"),
            password: data.get("password"),
          }),
        });
        var json = await res.json();
        if (!res.ok) throw new Error(json.detail || "Login failed");
        saveSession(json.token, json.user);
        window.location.href = "account.html";
      } catch (err) {
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
      var btn = signupForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        var res = await fetch(API + "/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: data.get("name"),
            email: data.get("email"),
            company: data.get("company"),
            password: data.get("password"),
            plan: data.get("plan") || "Silver",
          }),
        });
        var json = await res.json();
        if (!res.ok) throw new Error(json.detail || "Signup failed");
        saveSession(json.token, json.user);
        if (json.api_key) {
          localStorage.setItem("rcb_api_key_once", json.api_key);
        }
        window.location.href = "account.html";
      } catch (err) {
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
          (user.company || "Dealership") + " · " + (user.email || "") + " · live credits";
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
      if (params.get("paid") === "1" && params.get("session_id")) {
        await fetch(API + "/api/billing/confirm?session_id=" + encodeURIComponent(params.get("session_id")), {
          method: "POST",
          headers: { Authorization: "Bearer " + getToken() },
        });
        user = await window.RCB.refreshMe();
        if (creditsVal && user) creditsVal.textContent = user.credits;
      }

      // Load API keys list
      var keysList = document.getElementById("keysList");
      if (keysList) {
        var kr = await fetch(API + "/api/keys", { headers: { Authorization: "Bearer " + getToken() } });
        if (kr.ok) {
          var kd = await kr.json();
          keysList.innerHTML = (kd.keys || [])
            .map(function (k) {
              return "<li><code>" + k.key_prefix + "…</code> · " + k.label + "</li>";
            })
            .join("") || "<li>No keys yet</li>";
        }
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
        var res = await fetch(API + "/api/billing/demo-topup", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ credits: 100 }),
        });
        var json = await res.json();
        if (!res.ok) throw new Error(json.detail || "Top-up failed");
        var creditsVal = document.getElementById("creditsVal");
        if (creditsVal) creditsVal.textContent = json.credits;
        var u = readUser();
        if (u) {
          u.credits = json.credits;
          saveSession(getToken(), u);
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
        var res = await fetch(API + "/api/billing/checkout", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ plan: plan ? plan.value : "Silver" }),
        });
        var json = await res.json();
        if (!res.ok) throw new Error(typeof json.detail === "string" ? json.detail : "Checkout unavailable — use demo top-up");
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
