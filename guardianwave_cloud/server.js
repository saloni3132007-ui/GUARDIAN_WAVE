const express = require("express");
const http = require("http");
const WebSocket = require("ws"); // Swapped to standard WebSockets

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Management for the Emergency Alert
let alertTimer = null;
let isAlertActive = false;

// WebSocket Connection Logic
wss.on("connection", (ws, req) => {
  console.log(`[+] Device Connected from ${req.socket.remoteAddress}`);

  ws.on("message", (message) => {
    // Convert the incoming buffer to a string and parse the JSON
    let dataStr = message.toString();
    let sensorData;

    try {
      sensorData = JSON.parse(dataStr);
    } catch (e) {
      console.log(`[RAW] Data received: ${dataStr}`);
      return;
    }

    if (sensorData.event === "esp32_stream") {
      console.log(`[DATA] PIR State: ${sensorData.pir}`);

      // Simulate a fall if PIR reads 1 (For testing)
      if (sensorData.pir === 1 && !isAlertActive) {
        triggerEmergencyProtocol(ws);
      }
    } else if (sensorData.event === "cancel_alert") {
      console.log(
        `[RESOLVED] User pressed the hardware button. Canceling alert.`,
      );

      if (alertTimer) {
        clearTimeout(alertTimer);
        alertTimer = null;
      }
      isAlertActive = false;
      console.log(`[STATUS] System returned to normal monitoring.`);
    }
  });

  ws.on("close", () => {
    console.log(`[-] Device Disconnected`);
  });
});

// Emergency Protocol Function
function triggerEmergencyProtocol(ws) {
  console.log(`[ALERT] Fall Detected! Triggering hardware buzzer...`);
  isAlertActive = true;

  ws.send("TRIGGER_BUZZER");

  // Start the 10-Second Countdown (for faster testing)
  alertTimer = setTimeout(() => {
    if (isAlertActive) {
      console.log(`[CRITICAL] 10 seconds passed with no button press!`);
      console.log(`[CRITICAL] Executing Twilio API Call...`);
      isAlertActive = false;
    }
  }, 10000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`=========================================`);
  console.log(`GuardianWave Backend Running on Port ${PORT}`);
  console.log(`Waiting for ESP32 hardware to connect...`);
  console.log(`=========================================`);
});
