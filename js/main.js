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
      nav.classList.toggle("open");
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

  // PWA
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  }
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    window.deferredPrompt = e;
  });
})();
