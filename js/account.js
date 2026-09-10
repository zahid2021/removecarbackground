(function () {
  var API = window.RCB_API || window.location.origin;

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
        return (
          '<div class="gallery-item" data-aid="' +
          a.id +
          '">' +
          '<div class="gallery-thumb mute" style="min-height:120px;display:flex;align-items:center;justify-content:center;background:#eceff3">Loading…</div>' +
          "<div><small>" +
          (a.original_name || a.mode || "advert") +
          "</small><br/>" +
          '<button type="button" data-del="' +
          a.id +
          '" class="btn btn-ghost" style="padding:4px 8px;font-size:0.75rem">Delete</button></div></div>'
        );
      })
      .join("");
    data.adverts.forEach(function (a) {
      var card = gallery.querySelector('[data-aid="' + a.id + '"]');
      if (!card) return;
      var slot = card.querySelector(".gallery-thumb");
      fetch(API + "/api/adverts/" + a.id + "/file", { headers: authHeaders() })
        .then(function (r) {
          if (!r.ok) throw new Error("missing");
          return r.blob();
        })
        .then(function (blob) {
          var url = URL.createObjectURL(blob);
          slot.outerHTML = '<img src="' + url + '" alt="" loading="lazy" />';
        })
        .catch(function () {
          slot.innerHTML =
            "<small style='color:#b00020;padding:8px;text-align:center'>File missing — Delete &amp; re-process</small>";
        });
    });
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
        return (
          '<div class="gallery-item" data-bid="' +
          b.id +
          '">' +
          '<div class="gallery-thumb mute" style="min-height:120px;display:flex;align-items:center;justify-content:center;background:#eceff3">Loading…</div>' +
          "<div><small>" +
          b.name +
          "</small><br/>" +
          '<button type="button" data-bdel="' +
          b.id +
          '" class="btn btn-ghost" style="padding:4px 8px;font-size:0.75rem">Delete</button></div></div>'
        );
      })
      .join("");

    // Load thumbs with Authorization header (img src alone fails cross-host / expired disk)
    data.custom.forEach(function (b) {
      var card = gallery.querySelector('[data-bid="' + b.id + '"]');
      if (!card) return;
      var slot = card.querySelector(".gallery-thumb");
      fetch(API + "/api/backdrops/" + b.id + "/file", { headers: authHeaders() })
        .then(function (r) {
          if (!r.ok) throw new Error("missing");
          return r.blob();
        })
        .then(function (blob) {
          var url = URL.createObjectURL(blob);
          slot.outerHTML = '<img src="' + url + '" alt="" loading="lazy" />';
        })
        .catch(function () {
          slot.innerHTML =
            "<small style='color:#b00020;padding:8px;text-align:center'>Image lost after server restart — Delete &amp; re-upload</small>";
        });
    });

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
