require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
const fs = require("fs");

// TWILIO CONFIGURATION
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);
const MY_PHONE_NUMBER = process.env.MY_PHONE_NUMBER;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// UTILITY: Alert Persistence
function logSystemEvent(deviceId, eventType, details) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] DEV:${deviceId} | EVENT:${eventType} | DETAILS:${details}\n`;
  fs.appendFileSync("alert_history.log", logEntry);
}

// Signal Processing: Hampel Filter
class HampelFilter {
  constructor(windowSize = 20, thresholdMultiplier = 3) {
    this.windowSize = windowSize;
    this.threshold = thresholdMultiplier;
    this.dataWindow = [];
  }

  getMedian(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  process(newValue) {
    this.dataWindow.push(newValue);
    if (this.dataWindow.length > this.windowSize) this.dataWindow.shift();

    if (this.dataWindow.length < 3) {
      return { clean: newValue, variance: 0 };
    }

    const median = this.getMedian(this.dataWindow);
    const deviations = this.dataWindow.map((val) => Math.abs(val - median));
    const mad = this.getMedian(deviations);

    const scaledMad = mad * 1.4826;
    let cleanVal =
      Math.abs(newValue - median) > this.threshold * scaledMad
        ? median
        : newValue;

    return { clean: cleanVal, variance: mad };
  }
}

class DeviceTracker {
  constructor(deviceId, ws) {
    this.deviceId = deviceId;
    this.ws = ws;

    this.csiFilter = new HampelFilter();
    this.systemState = "IDLE";
    this.alertTimer = null;
    this.observationTimer = null;
    this.isAlertActive = false;

    this.persistentPirState = 0;
    this.pirClearTimeout = null;

    this.postFallVarianceSum = 0;
    this.postFallFrameCount = 0;

    logSystemEvent(this.deviceId, "CONNECTED", "Device initialized tracking.");
  }

  processSensorData(sensorData) {
    if (sensorData.pir === 1) {
      this.persistentPirState = 1;
      if (this.pirClearTimeout) clearTimeout(this.pirClearTimeout);
      this.pirClearTimeout = setTimeout(() => {
        this.persistentPirState = 0;
      }, 4000);
    }

    let filterResult = this.csiFilter.process(sensorData.amplitude);

    process.stdout.write(
      `\r[DEV: ${this.deviceId}] [STATE: ${this.systemState}] PIR: ${this.persistentPirState} | Variance: ${filterResult.variance.toFixed(2)}      `,
    );

    if (this.systemState === "IDLE") {
      if (
        filterResult.variance > 6.0 &&
        this.persistentPirState === 1 &&
        !this.isAlertActive
      ) {
        console.log(
          `\n\n[DEV: ${this.deviceId}] [IMPACT DETECTED] Human-caused variance spike! Entering observation...`,
        );
        logSystemEvent(
          this.deviceId,
          "IMPACT_DETECTED",
          `Variance spiked to ${filterResult.variance.toFixed(2)}`,
        );

        this.systemState = "FALL_SUSPECTED";
        this.postFallVarianceSum = 0;
        this.postFallFrameCount = 0;

        this.observationTimer = setTimeout(() => {
          let averagePostFallVariance =
            this.postFallVarianceSum / this.postFallFrameCount;
          console.log(
            `\n[DEV: ${this.deviceId}] [ANALYSIS COMPLETE] Avg post-impact variance: ${averagePostFallVariance.toFixed(2)}`,
          );

          if (averagePostFallVariance < 2.0) {
            console.log(
              `[DEV: ${this.deviceId}] [CRITICAL] Post-fall stillness confirmed. Triggering Alert!`,
            );
            logSystemEvent(
              this.deviceId,
              "FALL_CONFIRMED",
              `Stillness avg variance: ${averagePostFallVariance.toFixed(2)}`,
            );
            this.systemState = "ALERT";
            this.triggerEmergencyProtocol();
          } else {
            console.log(
              `[DEV: ${this.deviceId}] [SAFE] Sustained movement detected. Resetting.`,
            );
            logSystemEvent(
              this.deviceId,
              "FALL_REJECTED",
              `Movement continued. Variance: ${averagePostFallVariance.toFixed(2)}`,
            );
            this.systemState = "IDLE";
          }
        }, 3000);
      }
    } else if (this.systemState === "FALL_SUSPECTED") {
      this.postFallVarianceSum += filterResult.variance;
      this.postFallFrameCount++;
    }
  }

  triggerEmergencyProtocol() {
    this.isAlertActive = true;
    this.ws.send("TRIGGER_BUZZER");

    this.alertTimer = setTimeout(() => {
      if (this.isAlertActive) {
        console.log(
          `\n[DEV: ${this.deviceId}] [ESCALATION] No response. Executing Twilio Voice Call...`,
        );
        logSystemEvent(
          this.deviceId,
          "TWILIO_CALL",
          "Victim unresponsive. Emergency call dispatched.",
        );

        twilioClient.calls
          .create({
            twiml:
              '<Response><Say voice="alice">Critical Alert. Guardian Wave has detected a severe fall. The victim appears unresponsive. Immediate assistance is required.</Say></Response>',
            to: MY_PHONE_NUMBER,
            from: TWILIO_PHONE_NUMBER,
          })
          .catch((err) => console.error(`[TWILIO ERROR] Failed to dial:`, err));

        this.resetState();
      }
    }, 10000);
  }

  cancelAlert() {
    console.log(
      `\n[DEV: ${this.deviceId}] [RESOLVED] Hardware button pressed. Resetting system.`,
    );
    logSystemEvent(
      this.deviceId,
      "ALERT_CANCELED",
      "User physically dismissed the alarm.",
    );
    this.resetState();
  }

  resetState() {
    if (this.alertTimer) clearTimeout(this.alertTimer);
    if (this.observationTimer) clearTimeout(this.observationTimer);
    this.isAlertActive = false;
    this.systemState = "IDLE";
  }
}

// WebSocket Event Listener
wss.on("connection", (ws, req) => {
  const deviceId = req.socket.remoteAddress;
  console.log(`\n[+] ESP32 Connected! Assigned ID: ${deviceId}`);

  const tracker = new DeviceTracker(deviceId, ws);

  ws.on("message", (message) => {
    let dataStr = message.toString();
    let sensorData;
    try {
      sensorData = JSON.parse(dataStr);
    } catch (e) {
      return;
    }

    if (sensorData.event === "sensor_stream") {
      tracker.processSensorData(sensorData);
    } else if (sensorData.event === "cancel_alert") {
      tracker.cancelAlert();
    }
  });

  ws.on("close", () => {
    console.log(`\n[-] Device ${deviceId} Disconnected`);
    logSystemEvent(deviceId, "DISCONNECTED", "Connection closed.");
    tracker.resetState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`===================================================`);
  console.log(`GuardianWave State Machine Online`);
  console.log(`===================================================`);
});
