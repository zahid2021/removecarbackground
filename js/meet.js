(function () {
  var grid = document.getElementById("meetGrid");
  if (!grid) return;

  var monthLabel = document.getElementById("meetMonthLabel");
  var slotsWrap = document.getElementById("meetSlotsWrap");
  var slotsEl = document.getElementById("meetSlots");
  var slotsTitle = document.getElementById("meetSlotsTitle");
  var tzLabel = document.getElementById("meetTzLabel");
  var stepCal = document.getElementById("meetStepCalendar");
  var stepDetails = document.getElementById("meetStepDetails");
  var stepDone = document.getElementById("meetStepDone");
  var selectedSummary = document.getElementById("meetSelectedSummary");
  var doneSummary = document.getElementById("meetDoneSummary");
  var gcalLink = document.getElementById("meetGcal");
  var form = document.getElementById("meetForm");

  var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  var tzOffsetMin = -new Date().getTimezoneOffset();
  var tzSign = tzOffsetMin >= 0 ? "+" : "-";
  var tzAbs = Math.abs(tzOffsetMin);
  var tzGmt =
    "GMT" +
    tzSign +
    String(Math.floor(tzAbs / 60)).padStart(2, "0") +
    ":" +
    String(tzAbs % 60).padStart(2, "0");
  if (tzLabel) {
    var city = tz.split("/").pop().replace(/_/g, " ");
    tzLabel.textContent = city + " (" + tzGmt + ")";
  }

  var view = new Date();
  view.setDate(1);
  view.setHours(0, 0, 0, 0);

  var selectedDate = null;
  var selectedSlot = null;

  var SLOT_HOURS = [9, 10, 11, 12, 13, 14, 15, 16]; // local business hours

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function ymd(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function startOfDay(d) {
    var x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function isWeekend(d) {
    var day = d.getDay();
    return day === 0 || day === 6;
  }

  function isPastDay(d) {
    return startOfDay(d) < startOfDay(new Date());
  }

  function monthName(d) {
    return d.toLocaleString(undefined, { month: "long", year: "numeric" });
  }

  function formatDayLong(d) {
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatTime(h) {
    var ampm = h >= 12 ? "PM" : "AM";
    var hr = h % 12;
    if (hr === 0) hr = 12;
    return hr + ":00 " + ampm;
  }

  function renderCalendar() {
    monthLabel.textContent = monthName(view);
    grid.innerHTML = "";
    var year = view.getFullYear();
    var month = view.getMonth();
    var firstDow = new Date(year, month, 1).getDay();
    var daysInMonth = new Date(year, month + 1, 0).getDate();

    for (var i = 0; i < firstDow; i++) {
      var empty = document.createElement("span");
      empty.className = "meet-day is-empty";
      grid.appendChild(empty);
    }

    for (var day = 1; day <= daysInMonth; day++) {
      var date = new Date(year, month, day);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "meet-day";
      btn.textContent = String(day);
      btn.dataset.date = ymd(date);

      var disabled = isWeekend(date) || isPastDay(date);
      if (disabled) {
        btn.classList.add("is-disabled");
        btn.disabled = true;
      } else {
        btn.classList.add("is-available");
      }
      if (selectedDate && ymd(selectedDate) === ymd(date)) {
        btn.classList.add("is-selected");
      }
      if (ymd(date) === ymd(new Date())) {
        btn.classList.add("is-today");
      }

      btn.addEventListener("click", function () {
        selectedDate = new Date(this.dataset.date + "T00:00:00");
        selectedSlot = null;
        renderCalendar();
        renderSlots();
      });
      grid.appendChild(btn);
    }
  }

  function renderSlots() {
    if (!selectedDate) {
      slotsWrap.hidden = true;
      return;
    }
    slotsWrap.hidden = false;
    slotsTitle.textContent = "Times for " + formatDayLong(selectedDate);
    slotsEl.innerHTML = "";

    var now = new Date();
    SLOT_HOURS.forEach(function (h) {
      var slotDate = new Date(selectedDate);
      slotDate.setHours(h, 0, 0, 0);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "meet-slot";
      btn.textContent = formatTime(h);
      if (slotDate <= now) {
        btn.disabled = true;
        btn.classList.add("is-disabled");
      }
      if (selectedSlot === h) btn.classList.add("is-selected");
      btn.addEventListener("click", function () {
        if (btn.disabled) return;
        selectedSlot = h;
        goDetails();
      });
      slotsEl.appendChild(btn);
    });
  }

  function goDetails() {
    var start = new Date(selectedDate);
    start.setHours(selectedSlot, 0, 0, 0);
    selectedSummary.textContent =
      formatDayLong(start) +
      " · " +
      formatTime(selectedSlot) +
      " – " +
      formatTime(selectedSlot + 1) +
      " · Google Meet · 30 minutes";
    stepCal.hidden = true;
    stepDetails.hidden = false;
    stepDone.hidden = true;
  }

  function toGCalStamp(d) {
    return (
      d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      "T" +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      "00Z"
    );
  }

  function buildGCalUrl(payload) {
    var start = new Date(selectedDate);
    start.setHours(selectedSlot, 0, 0, 0);
    var end = new Date(start.getTime() + 30 * 60 * 1000);
    var details =
      "RemoveCarBackground product demo (Google Meet).%0A" +
      "Guest: " +
      encodeURIComponent(payload.name) +
      " (" +
      encodeURIComponent(payload.email) +
      ")%0A" +
      "Company: " +
      encodeURIComponent(payload.company) +
      "%0A" +
      "Notes: " +
      encodeURIComponent(payload.notes || "—") +
      "%0A%0A" +
      "Host will confirm the Google Meet link by email.";
    return (
      "https://calendar.google.com/calendar/render?action=TEMPLATE" +
      "&text=" +
      encodeURIComponent("Meet with RemoveCarBackground") +
      "&dates=" +
      toGCalStamp(start) +
      "/" +
      toGCalStamp(end) +
      "&details=" +
      details +
      "&location=" +
      encodeURIComponent("Google Meet") +
      "&ctz=" +
      encodeURIComponent(tz)
    );
  }

  document.getElementById("meetPrev").addEventListener("click", function () {
    view.setMonth(view.getMonth() - 1);
    selectedDate = null;
    selectedSlot = null;
    slotsWrap.hidden = true;
    renderCalendar();
  });
  document.getElementById("meetNext").addEventListener("click", function () {
    view.setMonth(view.getMonth() + 1);
    selectedDate = null;
    selectedSlot = null;
    slotsWrap.hidden = true;
    renderCalendar();
  });
  document.getElementById("meetBack").addEventListener("click", function () {
    stepDetails.hidden = true;
    stepCal.hidden = false;
    renderSlots();
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var fd = new FormData(form);
    var payload = {
      name: String(fd.get("name") || "").trim(),
      email: String(fd.get("email") || "").trim(),
      company: String(fd.get("company") || "").trim(),
      notes: String(fd.get("notes") || "").trim(),
      date: ymd(selectedDate),
      time: formatTime(selectedSlot),
      slotHour: selectedSlot,
      timezone: tz,
      duration: 30,
      location: "Google Meet",
    };

    var api = window.RCB_API || window.location.origin;
    fetch(api + "/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(function () {
      /* still allow local confirm if API asleep */
    });

    var start = new Date(selectedDate);
    start.setHours(selectedSlot, 0, 0, 0);
    doneSummary.textContent =
      "Thanks " +
      payload.name +
      " — demo reserved for " +
      formatDayLong(start) +
      " at " +
      formatTime(selectedSlot) +
      " (" +
      tzGmt +
      ").";
        gcalLink.href = buildGCalUrl(payload);

        stepCal.hidden = true;
        stepDetails.hidden = true;
        stepDone.hidden = false;
      });

      renderCalendar();
    })();
