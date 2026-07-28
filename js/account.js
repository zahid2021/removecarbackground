(function () {
  var API = window.location.origin;

  function token() {
    return (window.RCB && window.RCB.getToken()) || localStorage.getItem("rcb_token") || "";
  }

  function authHeaders(json) {
    var h = { Authorization: "Bearer " + token() };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async function loadStorage() {
    var res = await fetch(API + "/api/storage", { headers: authHeaders() });
    if (!res.ok) return;
    var data = await res.json();
    var storageVal = document.getElementById("storageVal");
    if (storageVal) {
      storageVal.textContent =
        (data.used_gb || 0).toFixed(2) + " / 1 GB";
    }
    var gallery = document.getElementById("advertGallery");
    if (!gallery) return;
    if (!data.adverts || !data.adverts.length) {
      gallery.innerHTML = "<p class='mute'>No saved adverts yet — process an image while logged in.</p>";
      return;
    }
    gallery.innerHTML = data.adverts
      .map(function (a) {
        var src = "/api/adverts/" + a.id + "/file?token=" + encodeURIComponent(token());
        return (
          '<div class="gallery-item">' +
          '<img src="' +
          src +
          '" alt="" loading="lazy" />' +
          "<div><small>" +
          (a.original_name || a.mode || "advert") +
          "</small><br/>" +
          '<button type="button" data-del="' +
          a.id +
          '" class="btn btn-ghost" style="padding:4px 8px;font-size:0.75rem">Delete</button></div></div>'
        );
      })
      .join("");
    gallery.querySelectorAll("[data-del]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await fetch(API + "/api/adverts/" + btn.dataset.del, {
          method: "DELETE",
          headers: authHeaders(),
        });
        loadStorage();
      });
    });
  }

  async function loadBackdrops() {
    var res = await fetch(API + "/api/backdrops", { headers: authHeaders() });
    if (!res.ok) return;
    var data = await res.json();
    var gallery = document.getElementById("backdropGallery");
    if (!gallery) return;
    if (!data.custom || !data.custom.length) {
      gallery.innerHTML = "<p class='mute'>No custom backdrops yet.</p>";
      return;
    }
    gallery.innerHTML = data.custom
      .map(function (b) {
        var src = b.url + "?token=" + encodeURIComponent(token());
        return (
          '<div class="gallery-item">' +
          '<img src="' +
          src +
          '" alt="" loading="lazy" />' +
          "<div><small>" +
          b.name +
          "</small><br/>" +
          '<button type="button" data-bdel="' +
          b.id +
          '" class="btn btn-ghost" style="padding:4px 8px;font-size:0.75rem">Delete</button></div></div>'
        );
      })
      .join("");
    gallery.querySelectorAll("[data-bdel]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await fetch(API + "/api/backdrops/" + btn.dataset.bdel, {
          method: "DELETE",
          headers: authHeaders(),
        });
        loadBackdrops();
      });
    });
  }

  async function loadTeam() {
    var res = await fetch(API + "/api/team", { headers: authHeaders() });
    if (!res.ok) return;
    var data = await res.json();
    var teamList = document.getElementById("teamList");
    var inviteList = document.getElementById("inviteList");
    if (teamList) {
      teamList.innerHTML = (data.members || [])
        .map(function (m) {
          return "<li><b>" + m.name + "</b> · " + m.email + " · " + m.role + "</li>";
        })
        .join("");
    }
    if (inviteList) {
      inviteList.innerHTML = (data.invites || [])
        .filter(function (i) {
          return i.status === "pending";
        })
        .map(function (i) {
          return (
            "<li>Pending: " +
            i.email +
            " (" +
            i.role +
            ") — <a href='/invite.html?token=" +
            i.token +
            "'>link</a></li>"
          );
        })
        .join("") || "<li class='mute'>No pending invites</li>";
    }
    if (data.role !== "admin") {
      var form = document.getElementById("inviteForm");
      if (form) form.hidden = true;
    }
  }

  var uploadBtn = document.getElementById("backdropUpload");
  if (uploadBtn) {
    uploadBtn.addEventListener("click", async function () {
      var file = document.getElementById("backdropFile").files[0];
      var name = document.getElementById("backdropName").value || "Brand backdrop";
      if (!file) {
        alert("Choose an image");
        return;
      }
      var fd = new FormData();
      fd.append("file", file);
      fd.append("name", name);
      var res = await fetch(API + "/api/backdrops", {
        method: "POST",
        headers: { Authorization: "Bearer " + token() },
        body: fd,
      });
      var json = await res.json();
      if (!res.ok) {
        alert(json.detail || "Upload failed");
        return;
      }
      document.getElementById("backdropFile").value = "";
      loadBackdrops();
    });
  }

  var inviteBtn = document.getElementById("inviteBtn");
  if (inviteBtn) {
    inviteBtn.addEventListener("click", async function () {
      var email = document.getElementById("inviteEmail").value;
      var role = document.getElementById("inviteRole").value;
      var res = await fetch(API + "/api/team/invite", {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ email: email, role: role }),
      });
      var json = await res.json();
      if (!res.ok) {
        alert(json.detail || "Invite failed");
        return;
      }
      prompt("Invite link (share with teammate):", json.invite_url);
      document.getElementById("inviteEmail").value = "";
      loadTeam();
    });
  }

  var installBtn = document.getElementById("installBtn");
  if (installBtn) {
    installBtn.addEventListener("click", function () {
      if (window.deferredPrompt) {
        window.deferredPrompt.prompt();
      } else {
        alert(
          "iOS: Safari → Share → Add to Home Screen\nAndroid: Chrome → Install app\n\nNative shells: see mobile/README.md"
        );
      }
    });
  }

  // Stripe status
  fetch(API + "/api/billing/plans")
    .then(function (r) {
      return r.json();
    })
    .then(function (p) {
      var el = document.getElementById("stripeStatus");
      if (!el) return;
      el.textContent = p.stripe_enabled
        ? "Stripe live — Pay with Stripe charges a real card (test keys = test mode)."
        : "Stripe not configured — set STRIPE_SECRET_KEY in .env. Demo top-up works now.";
    });

  if (document.getElementById("userName")) {
    // Wait a tick for auth.js refresh
    setTimeout(function () {
      loadStorage();
      loadBackdrops();
      loadTeam();
      var u = window.RCB && window.RCB.readUser();
      if (u && document.getElementById("storageVal") && u.storage_used_gb != null) {
        document.getElementById("storageVal").textContent =
          Number(u.storage_used_gb).toFixed(2) + " / 1 GB";
      }
    }, 400);
  }
})();
