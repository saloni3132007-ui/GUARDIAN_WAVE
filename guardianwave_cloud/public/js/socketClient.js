(function () {
  "use strict";

  var listeners = {};

  function on(eventName, callback) {
    if (!listeners[eventName]) listeners[eventName] = [];
    listeners[eventName].push(callback);
  }

  function off(eventName, callback) {
    if (!listeners[eventName]) return;
    listeners[eventName] = listeners[eventName].filter(function (cb) {
      return cb !== callback;
    });
  }

  function emit(eventName, payload) {
    if (!listeners[eventName]) return;
    listeners[eventName].forEach(function (cb) {
      try {
        cb(payload);
      } catch (err) {
        console.error("[GuardianWave] listener error:", err);
      }
    });
  }

  window.GuardianWave = window.GuardianWave || {};
  window.GuardianWave.on = on;
  window.GuardianWave.off = off;

  function setConnectionUI(isConnected) {
    var pill = document.getElementById("connectionPill");
    var text = document.getElementById("connectionStatusText");
    var dot = document.getElementById("connectionDot");
    if (!pill || !text || !dot) return;

    if (isConnected) {
      pill.style.background = "var(--teal-dim)";
      pill.style.color = "var(--teal)";
      dot.style.background = "var(--teal)";
      text.textContent = "System Online";
    } else {
      pill.style.background = "var(--coral-dim)";
      pill.style.color = "var(--coral)";
      dot.style.background = "var(--coral)";
      text.textContent = "Disconnected";
    }
  }

  // Connect to backend over pure WebSocket
  var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  var socketUrl = protocol + "//" + window.location.host;

  var socket = new WebSocket(socketUrl);

  socket.onopen = function () {
    setConnectionUI(true);
    emit("connectionChange", { connected: true });
    socket.send(JSON.stringify({ event: "ui_connect" }));
  };

  socket.onclose = function () {
    setConnectionUI(false);
    emit("connectionChange", { connected: false });
    console.warn(
      "[GuardianWave] WebSocket disconnected. Refresh to reconnect.",
    );
  };

  socket.onmessage = function (msg) {
    try {
      var payload = JSON.parse(msg.data);
      if (payload && payload.event) {
        emit(payload.event, payload);
      }
    } catch (err) {
      console.error("Failed to parse websocket message", err);
    }
  };

  window.GuardianWave.dismissFallAlert = function () {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ event: "cancel_alert" }));
    }
  };

  window.GuardianWave._socket = socket;
})();
