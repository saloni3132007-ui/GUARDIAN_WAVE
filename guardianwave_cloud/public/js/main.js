(function () {
  "use strict";

  // AUTHENTICATION GUARD
  // If user is not logged in, boot them back to the signin page immediately!
  const userName = localStorage.getItem("gw_user");
  if (!userName) {
    window.location.href = "signin.html";
    return;
  }

  // Personalize the dashboard
  const roomLabel = document.getElementById("deviceRoomLabel");
  if (roomLabel) {
    roomLabel.textContent = userName + "'s Room";
  }

  if (!window.GuardianWave || !window.GuardianWave.on) {
    console.error("[GuardianWave] socketClient.js must load before main.js");
    return;
  }

  var GW = window.GuardianWave;
  var FALL_WINDOW_SECONDS = 30;
  var fallCountdownInterval = null;

  function formatTime(timestamp) {
    var date = timestamp ? new Date(timestamp) : new Date();
    var h = String(date.getHours()).padStart(2, "0");
    var m = String(date.getMinutes()).padStart(2, "0");
    return h + ":" + m;
  }

  // Update PIR & Status
  GW.on("pirStatus", function (payload) {
    payload = payload || {};
    var statusEl = document.getElementById("pirStatusText");
    if (statusEl && payload.message) {
      statusEl.textContent = payload.message;
      setRoomStatus(false, "Scanning Active", payload.message);
    }
    var tsEl = document.getElementById("pirTimestamp");
    if (tsEl) tsEl.textContent = formatTime(payload.timestamp);
  });

  // Status Ring UI Controls
  function setRoomStatus(isAlert, title, subtitle) {
    var ring = document.getElementById("statusRing");
    var iconOk = document.getElementById("statusIconOk");
    var iconAlert = document.getElementById("statusIconAlert");
    var titleEl = document.getElementById("statusTitle");
    var subtitleEl = document.getElementById("statusSubtitle");

    if (ring) ring.classList.toggle("is-alert", isAlert);
    if (iconOk) iconOk.classList.toggle("hidden", isAlert);
    if (iconAlert) iconAlert.classList.toggle("hidden", !isAlert);
    if (titleEl) titleEl.textContent = title;
    if (subtitleEl) subtitleEl.textContent = subtitle;
  }

  // Fall Alert UI Controls
  function updateFallCard(message, isCoral) {
    var statusEl = document.getElementById("fallStatusText");
    var tsEl = document.getElementById("fallTimestamp");
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.style.color = isCoral ? "var(--coral)" : "var(--text-1)";
    }
    if (tsEl) tsEl.textContent = formatTime();
  }

  function showFallOverlay() {
    var overlay = document.getElementById("fallOverlay");
    var countdownEl = document.getElementById("fallCountdown");
    if (!overlay) return;

    overlay.classList.remove("hidden");
    setRoomStatus(true, "Fall alert active", "Awaiting resolution");

    var remaining = FALL_WINDOW_SECONDS;
    if (countdownEl) countdownEl.textContent = String(remaining);

    clearInterval(fallCountdownInterval);
    fallCountdownInterval = setInterval(function () {
      remaining -= 1;
      if (countdownEl) countdownEl.textContent = String(Math.max(remaining, 0));

      if (remaining <= 0) {
        clearInterval(fallCountdownInterval);
      }
    }, 1000);
  }

  function hideFallOverlay() {
    var overlay = document.getElementById("fallOverlay");
    if (overlay) overlay.classList.add("hidden");
    clearInterval(fallCountdownInterval);
  }

  GW.on("fallAlert", function (payload) {
    payload = payload || {};

    if (payload.status === "detected") {
      showFallOverlay();
      updateFallCard("Fall detected — calling in 30s", true);
      logHistory("⚠️ Severe Fall Detected — Awaiting User Confirmation", true);
    } else if (payload.status === "resolved") {
      hideFallOverlay();
      updateFallCard("Resolved — No emergency", false);
      setRoomStatus(false, "All clear", "Alarm dismissed");
      logHistory("✓ Alarm Canceled Locally — Safety Confirmed", false);
    } else if (payload.status === "escalated") {
      hideFallOverlay();
      updateFallCard("Escalated — Twilio dispatched", true);
      setRoomStatus(true, "Emergency Alert", "Contact notified");
      logHistory("📞 Escalated — Emergency Contact successfully called", true);

      //  Hospital Call Simulation (Demo Mode)
      // Wait 4 seconds to simulate the family member not answering
      setTimeout(function () {
        var hospOverlay = document.getElementById("hospitalOverlay");
        if (hospOverlay) hospOverlay.classList.remove("hidden");
        logHistory("🏥 Hospital Notified (Demo) - Contact unavailable", true);
      }, 4000);
    }
  });

  var dismissBtn = document.getElementById("fallDismissBtn");
  if (dismissBtn) {
    dismissBtn.addEventListener("click", function () {
      hideFallOverlay();
      updateFallCard("Resolved by button", false);
      setRoomStatus(false, "All clear", "Alarm dismissed locally");
      GW.dismissFallAlert();
    });
  }

  var hospDismissBtn = document.getElementById("hospitalDismissBtn");
  if (hospDismissBtn) {
    hospDismissBtn.addEventListener("click", function () {
      var hospOverlay = document.getElementById("hospitalOverlay");
      if (hospOverlay) hospOverlay.classList.add("hidden");
      setRoomStatus(false, "All clear", "System Reset after escalation");
      updateFallCard("Reset after escalation", false);
    });
  }

  var signOutBtn = document.getElementById("signOutBtn");
  if (signOutBtn) {
    signOutBtn.addEventListener("click", function () {
      localStorage.removeItem("gw_user");
      if (GW._socket) GW._socket.close();
      window.location.href = "landing.html";
    });
  }
})();
