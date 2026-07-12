(function () {
  "use strict";

  // AUTHENTICATION GUARD
  const userName = localStorage.getItem("gw_user");
  if (!userName) {
    window.location.href = "signin.html";
    return;
  }

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

  GW.on("connectionChange", function (payload) {
    if (
      payload.connected &&
      GW._socket &&
      GW._socket.readyState === WebSocket.OPEN
    ) {
      GW._socket.send(
        JSON.stringify({
          event: "bind_user",
          username: userName,
        }),
      );
    }
  });

  function formatTime(timestamp) {
    var date = timestamp ? new Date(timestamp) : new Date();
    var h = String(date.getHours()).padStart(2, "0");
    var m = String(date.getMinutes()).padStart(2, "0");
    var s = String(date.getSeconds()).padStart(2, "0");
    return h + ":" + m + ":" + s;
  }

  // System History Logs
  function logHistory(msg, isAlert) {
    var logEl = document.getElementById("historyLog");
    if (!logEl) return;

    if (logEl.innerHTML.includes("No anomalies detected")) {
      logEl.innerHTML = "";
    }

    var timeStr = formatTime(new Date());
    var color = isAlert ? "var(--coral)" : "var(--teal)";

    var entry = document.createElement("div");
    entry.style.cssText =
      "padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05); transition: 0.3s;";
    entry.innerHTML = `<span style="color:${color}; font-family:'IBM Plex Mono', monospace; margin-right:12px; font-weight: 500;">[${timeStr}]</span> ${msg}`;

    logEl.insertBefore(entry, logEl.firstChild);
  }

  // Live CSI Value Update
  GW.on("csiVariance", function (payload) {
    var csiValEl = document.getElementById("csiVarianceValue");
    if (csiValEl && payload.value !== undefined) {
      csiValEl.textContent = parseFloat(payload.value).toFixed(2);
    }
  });

  GW.on("pirStatus", function (payload) {
    payload = payload || {};
    var statusEl = document.getElementById("pirStatusText");
    if (statusEl && payload.message) {
      let text = payload.message;
      let icon = "👀";

      // Dynamic Emoji Injection
      if (text.toLowerCase().includes("empty")) icon = "🪹";
      else if (text.toLowerCase().includes("fall")) icon = "🚨";
      else if (
        text.toLowerCase().includes("running") ||
        text.toLowerCase().includes("large")
      )
        icon = "🏃";
      else if (text.toLowerCase().includes("walking")) icon = "🚶";
      else if (text.toLowerCase().includes("idle")) icon = "🧍";

      statusEl.textContent = icon + " " + text;
      setRoomStatus(false, "Scanning Active", icon + " " + text);
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
    }
  });

  // Listens for the REAL backend update if the call is missed
  GW.on("hospitalFallback", function (payload) {
    var hospOverlay = document.getElementById("hospitalOverlay");
    if (hospOverlay) hospOverlay.classList.remove("hidden");
    logHistory("🏥 Hospital Notified - Contact unavailable", true);
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

  // Return to Dashboard button from the Hospital popup
  var hospDismissBtn = document.getElementById("hospitalDismissBtn");
  if (hospDismissBtn) {
    hospDismissBtn.addEventListener("click", function () {
      var hospOverlay = document.getElementById("hospitalOverlay");
      if (hospOverlay) hospOverlay.classList.add("hidden");
      setRoomStatus(false, "All clear", "System Reset after escalation");
      updateFallCard("Reset after escalation", false);
    });
  }

  // Sign out behavior
  var signOutBtn = document.getElementById("signOutBtn");
  if (signOutBtn) {
    signOutBtn.addEventListener("click", function () {
      localStorage.removeItem("gw_user");
      if (GW._socket) GW._socket.close();
      window.location.href = "landing.html";
    });
  }
})();
