(function () {
  var grid = document.getElementById("meetGrid");
  if (!grid) return;

  var monthLabel = document.getElementById("meetMonthLabel");
  var slotsWrap = document.getElementById("meetSlotsWrap");
  var slotsEl = document.getElementById("meetSlots");
  var slotsTitle = document.getElementById("meetSlotsTitle");
  var tzSelect = document.getElementById("meetTzSelect");
  var stepCal = document.getElementById("meetStepCalendar");
  var stepDetails = document.getElementById("meetStepDetails");
  var stepDone = document.getElementById("meetStepDone");
  var selectedSummary = document.getElementById("meetSelectedSummary");
  var doneSummary = document.getElementById("meetDoneSummary");
  var gcalLink = document.getElementById("meetGcal");
  var form = document.getElementById("meetForm");

  /* Major cities worldwide (IANA zones) */
  var TIMEZONES = [
    { group: "Asia", items: [
      ["Karachi", "Asia/Karachi"],
      ["Islamabad", "Asia/Karachi"],
      ["Lahore", "Asia/Karachi"],
      ["Dubai", "Asia/Dubai"],
      ["Riyadh", "Asia/Riyadh"],
      ["Doha", "Asia/Qatar"],
      ["Kuwait City", "Asia/Kuwait"],
      ["Muscat", "Asia/Muscat"],
      ["Tehran", "Asia/Tehran"],
      ["Mumbai", "Asia/Kolkata"],
      ["Delhi", "Asia/Kolkata"],
      ["Bengaluru", "Asia/Kolkata"],
      ["Colombo", "Asia/Colombo"],
      ["Dhaka", "Asia/Dhaka"],
      ["Kathmandu", "Asia/Kathmandu"],
      ["Bangkok", "Asia/Bangkok"],
      ["Jakarta", "Asia/Jakarta"],
      ["Singapore", "Asia/Singapore"],
      ["Kuala Lumpur", "Asia/Kuala_Lumpur"],
      ["Hong Kong", "Asia/Hong_Kong"],
      ["Shanghai", "Asia/Shanghai"],
      ["Beijing", "Asia/Shanghai"],
      ["Taipei", "Asia/Taipei"],
      ["Seoul", "Asia/Seoul"],
      ["Tokyo", "Asia/Tokyo"],
      ["Manila", "Asia/Manila"],
      ["Ho Chi Minh City", "Asia/Ho_Chi_Minh"],
      ["Tashkent", "Asia/Tashkent"],
      ["Almaty", "Asia/Almaty"],
      ["Baku", "Asia/Baku"],
      ["Tbilisi", "Asia/Tbilisi"],
      ["Yerevan", "Asia/Yerevan"],
      ["Jerusalem", "Asia/Jerusalem"],
      ["Amman", "Asia/Amman"],
      ["Beirut", "Asia/Beirut"],
    ]},
    { group: "Europe", items: [
      ["London", "Europe/London"],
      ["Manchester", "Europe/London"],
      ["Dublin", "Europe/Dublin"],
      ["Lisbon", "Europe/Lisbon"],
      ["Madrid", "Europe/Madrid"],
      ["Paris", "Europe/Paris"],
      ["Brussels", "Europe/Brussels"],
      ["Amsterdam", "Europe/Amsterdam"],
      ["Berlin", "Europe/Berlin"],
      ["Frankfurt", "Europe/Berlin"],
      ["Zurich", "Europe/Zurich"],
      ["Rome", "Europe/Rome"],
      ["Milan", "Europe/Rome"],
      ["Vienna", "Europe/Vienna"],
      ["Prague", "Europe/Prague"],
      ["Warsaw", "Europe/Warsaw"],
      ["Stockholm", "Europe/Stockholm"],
      ["Oslo", "Europe/Oslo"],
      ["Copenhagen", "Europe/Copenhagen"],
      ["Helsinki", "Europe/Helsinki"],
      ["Athens", "Europe/Athens"],
      ["Istanbul", "Europe/Istanbul"],
      ["Bucharest", "Europe/Bucharest"],
      ["Budapest", "Europe/Budapest"],
      ["Moscow", "Europe/Moscow"],
      ["Kyiv", "Europe/Kyiv"],
    ]},
    { group: "Americas", items: [
      ["New York", "America/New_York"],
      ["Washington DC", "America/New_York"],
      ["Boston", "America/New_York"],
      ["Miami", "America/New_York"],
      ["Toronto", "America/Toronto"],
      ["Montreal", "America/Toronto"],
      ["Chicago", "America/Chicago"],
      ["Houston", "America/Chicago"],
      ["Mexico City", "America/Mexico_City"],
      ["Denver", "America/Denver"],
      ["Phoenix", "America/Phoenix"],
      ["Los Angeles", "America/Los_Angeles"],
      ["San Francisco", "America/Los_Angeles"],
      ["Seattle", "America/Los_Angeles"],
      ["Vancouver", "America/Vancouver"],
      ["Calgary", "America/Edmonton"],
      ["São Paulo", "America/Sao_Paulo"],
      ["Buenos Aires", "America/Argentina/Buenos_Aires"],
      ["Santiago", "America/Santiago"],
      ["Bogotá", "America/Bogota"],
      ["Lima", "America/Lima"],
      ["Caracas", "America/Caracas"],
    ]},
    { group: "Africa", items: [
      ["Cairo", "Africa/Cairo"],
      ["Lagos", "Africa/Lagos"],
      ["Nairobi", "Africa/Nairobi"],
      ["Johannesburg", "Africa/Johannesburg"],
      ["Cape Town", "Africa/Johannesburg"],
      ["Casablanca", "Africa/Casablanca"],
      ["Accra", "Africa/Accra"],
      ["Addis Ababa", "Africa/Addis_Ababa"],
      ["Tunis", "Africa/Tunis"],
      ["Algiers", "Africa/Algiers"],
    ]},
    { group: "Oceania", items: [
      ["Sydney", "Australia/Sydney"],
      ["Melbourne", "Australia/Melbourne"],
      ["Brisbane", "Australia/Brisbane"],
      ["Perth", "Australia/Perth"],
      ["Auckland", "Pacific/Auckland"],
      ["Wellington", "Pacific/Auckland"],
      ["Fiji", "Pacific/Fiji"],
      ["Honolulu", "Pacific/Honolulu"],
    ]},
    { group: "UTC", items: [
      ["UTC", "UTC"],
    ]},
  ];

  var SLOT_HOURS = [9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5];
  var detected = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  var tz = detected;
  var cityLabel = detected.split("/").pop().replace(/_/g, " ");

  var view = new Date();
  view.setDate(1);
  view.setHours(0, 0, 0, 0);
  var selectedDate = null;
  var selectedSlot = null; // { h: number, label: string }

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

  function formatHourLabel(h) {
    var hour = Math.floor(h);
    var min = Math.round((h - hour) * 60);
    var ampm = hour >= 12 ? "PM" : "AM";
    var hr = hour % 12;
    if (hr === 0) hr = 12;
    return hr + ":" + pad(min) + " " + ampm;
  }

  function gmtLabel(timeZone) {
    try {
      var parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timeZone,
        timeZoneName: "longOffset",
        hour: "numeric",
      }).formatToParts(new Date());
      var name = "";
      parts.forEach(function (p) {
        if (p.type === "timeZoneName") name = p.value;
      });
      return name.replace("GMT", "GMT").replace("UTC", "GMT") || "GMT";
    } catch (e) {
      return "GMT";
    }
  }

  function getTzOffsetMs(timeZone, date) {
    var formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    var parts = formatter.formatToParts(date);
    var map = {};
    parts.forEach(function (p) {
      map[p.type] = p.value;
    });
    var asUTC = Date.UTC(
      +map.year,
      +map.month - 1,
      +map.day,
      +map.hour,
      +map.minute,
      +map.second
    );
    return asUTC - date.getTime();
  }

  function zonedLocalToDate(dateYmd, hourFloat, timeZone) {
    var hour = Math.floor(hourFloat);
    var minute = Math.round((hourFloat - hour) * 60);
    var y = +dateYmd.slice(0, 4);
    var m = +dateYmd.slice(5, 7) - 1;
    var d = +dateYmd.slice(8, 10);
    var utc = Date.UTC(y, m, d, hour, minute, 0);
    for (var i = 0; i < 3; i++) {
      var offset = getTzOffsetMs(timeZone, new Date(utc));
      utc = Date.UTC(y, m, d, hour, minute, 0) - offset;
    }
    return new Date(utc);
  }

  function fillTimezoneSelect() {
    if (!tzSelect) return;
    tzSelect.innerHTML = "";
    var matched = false;
    TIMEZONES.forEach(function (group) {
      var og = document.createElement("optgroup");
      og.label = group.group;
      group.items.forEach(function (item) {
        var opt = document.createElement("option");
        opt.value = item[1] + "|" + item[0];
        opt.textContent = item[0] + "  ·  " + gmtLabel(item[1]);
        if (!matched && item[1] === detected) {
          opt.selected = true;
          matched = true;
          tz = item[1];
          cityLabel = item[0];
        }
        og.appendChild(opt);
      });
      tzSelect.appendChild(og);
    });
    if (!matched) {
      var opt = document.createElement("option");
      opt.value = detected + "|" + cityLabel;
      opt.textContent = cityLabel + "  ·  " + gmtLabel(detected);
      opt.selected = true;
      tzSelect.insertBefore(opt, tzSelect.firstChild);
      tz = detected;
    }
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
      empty.setAttribute("aria-hidden", "true");
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
      if (selectedDate && ymd(selectedDate) === ymd(date)) btn.classList.add("is-selected");
      if (ymd(date) === ymd(new Date())) btn.classList.add("is-today");
      btn.addEventListener("click", onDayClick);
      grid.appendChild(btn);
    }
  }

  function onDayClick() {
    selectedDate = new Date(this.dataset.date + "T12:00:00");
    selectedSlot = null;
    renderCalendar();
    renderSlots();
  }

  function renderSlots() {
    if (!selectedDate) {
      slotsWrap.hidden = true;
      return;
    }
    slotsWrap.hidden = false;
    slotsTitle.textContent =
      "Available times · " + formatDayLong(selectedDate) + " · " + cityLabel;
    slotsEl.innerHTML = "";
    var dateKey = ymd(selectedDate);
    var now = Date.now();

    SLOT_HOURS.forEach(function (h) {
      var start = zonedLocalToDate(dateKey, h, tz);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "meet-slot";
      btn.textContent = formatHourLabel(h);
      if (start.getTime() <= now) {
        btn.disabled = true;
        btn.classList.add("is-disabled");
      }
      if (selectedSlot && selectedSlot.h === h) btn.classList.add("is-selected");
      btn.addEventListener("click", function () {
        if (btn.disabled) return;
        selectedSlot = { h: h, label: formatHourLabel(h) };
        goDetails();
      });
      slotsEl.appendChild(btn);
    });
  }

  function goDetails() {
    var endLabel = formatHourLabel(selectedSlot.h + 0.5);
    selectedSummary.innerHTML =
      "<strong>" +
      formatDayLong(selectedDate) +
      "</strong><br />" +
      selectedSlot.label +
      " – " +
      endLabel +
      " · " +
      cityLabel +
      " (" +
      gmtLabel(tz) +
      ")<br />Google Meet · 30 minutes";
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
    var start = zonedLocalToDate(ymd(selectedDate), selectedSlot.h, tz);
    var end = new Date(start.getTime() + 30 * 60 * 1000);
    var details =
      "RemoveCarBackground product demo via Google Meet.%0A" +
      "Guest: " +
      encodeURIComponent(payload.name) +
      " (" +
      encodeURIComponent(payload.email) +
      ")%0A" +
      "Company: " +
      encodeURIComponent(payload.company) +
      "%0A" +
      "Timezone: " +
      encodeURIComponent(cityLabel + " / " + tz) +
      "%0A" +
      "Notes: " +
      encodeURIComponent(payload.notes || "—") +
      "%0A%0AHost will confirm the Google Meet link by email.";
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

  if (tzSelect) {
    tzSelect.addEventListener("change", function () {
      var parts = tzSelect.value.split("|");
      tz = parts[0];
      cityLabel = parts[1] || tz.split("/").pop().replace(/_/g, " ");
      selectedSlot = null;
      if (selectedDate) renderSlots();
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var fd = new FormData(form);
    var payload = {
      name: String(fd.get("name") || "").trim(),
      email: String(fd.get("email") || "").trim(),
      company: String(fd.get("company") || "").trim(),
      notes: String(fd.get("notes") || "").trim(),
      date: ymd(selectedDate),
      time: selectedSlot.label,
      slotHour: selectedSlot.h,
      timezone: tz,
      city: cityLabel,
      duration: 30,
      location: "Google Meet",
    };

    var api = window.RCB_API || window.location.origin;
    fetch(api + "/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(function () {});

    doneSummary.textContent =
      "Thanks " +
      payload.name +
      " — demo reserved for " +
      formatDayLong(selectedDate) +
      " at " +
      selectedSlot.label +
      " (" +
      cityLabel +
      ", " +
      gmtLabel(tz) +
      ").";
    gcalLink.href = buildGCalUrl(payload);
    stepCal.hidden = true;
    stepDetails.hidden = true;
    stepDone.hidden = false;
  });

  fillTimezoneSelect();
  renderCalendar();
})();
