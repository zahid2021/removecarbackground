(function () {
  var nav = document.getElementById("nav");
  var burger = document.getElementById("burger");

  if (nav) {
    window.addEventListener("scroll", function () {
      nav.classList.toggle("scrolled", window.scrollY > 8);
    });
  }

  if (burger && nav) {
    burger.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      burger.setAttribute("aria-expanded", open ? "true" : "false");
      document.body.style.overflow = open ? "hidden" : "";
      if (!open) {
        nav.querySelectorAll(".has-menu.open").forEach(function (el) {
          el.classList.remove("open");
        });
      }
    });

    // Mobile: tap Solutions to expand/collapse (keep Login/Sign Up reachable)
    nav.querySelectorAll(".has-menu > a").forEach(function (link) {
      link.addEventListener("click", function (e) {
        if (window.matchMedia("(max-width: 980px)").matches && nav.classList.contains("open")) {
          e.preventDefault();
          link.parentElement.classList.toggle("open");
        }
      });
    });

    // Close menu after navigating
    nav.querySelectorAll(".nav-links a").forEach(function (link) {
      link.addEventListener("click", function () {
        if (!nav.classList.contains("open")) return;
        // Solutions parent toggle — don't close menu
        if (
          link.parentElement &&
          link.parentElement.classList.contains("has-menu") &&
          !link.closest(".sub-menu")
        ) {
          return;
        }
        nav.classList.remove("open");
        burger.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      });
    });
  }

  var reveals = document.querySelectorAll(".reveal");
  if (reveals.length && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          e.target.classList.add("in");
          io.unobserve(e.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    reveals.forEach(function (el) {
      io.observe(el);
    });
  } else {
    reveals.forEach(function (el) {
      el.classList.add("in");
    });
  }

  // Multi-currency pricing (MotorCut parity)
  var prices = {
    gbp: { core: "£40", starter: "£75", silver: "£150", gold: "£200", platinum: "£300" },
    usd: { core: "$50", starter: "$100", silver: "$200", gold: "$275", platinum: "$400" },
    eur: { core: "€45", starter: "€80", silver: "€160", gold: "€225", platinum: "€350" },
  };
  var currencyToggle = document.getElementById("currencyToggle");
  if (currencyToggle) {
    currencyToggle.addEventListener("click", function (e) {
      var btn = e.target.closest("button");
      if (!btn) return;
      currencyToggle.querySelectorAll("button").forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      var cur = btn.dataset.currency;
      var map = prices[cur];
      document.querySelectorAll("#priceGrid .price").forEach(function (card) {
        var plan = card.dataset.plan;
        var el = card.querySelector(".price-val");
        if (el && map[plan]) el.textContent = map[plan];
      });
    });
  }

  var demoForm = document.getElementById("demoForm");
  if (demoForm) {
    demoForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = document.getElementById("demoMsg");
      if (msg) msg.classList.add("show");
      demoForm.reset();
    });
  }

  // PWA — force update so mobile drops stale HTML (old 01/02 labels)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js?v=45").then(function (reg) {
      reg.update();
    }).catch(function () {});
    navigator.serviceWorker.addEventListener("message", function (event) {
      if (event.data && event.data.type === "RCB_SW_UPDATED") {
        window.location.reload();
      }
    });
  }

  // Pre-warm the free API dyno in the background (does not block page paint)
  try {
    var api = window.RCB_API || window.location.origin;
    if (api) {
      fetch(api + "/api/health", { mode: "cors", cache: "no-store" }).catch(function () {});
    }
  } catch (e) {}

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    window.deferredPrompt = e;
  });
})();
