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

// ADVANCED STATE MANAGEMENT
class DeviceTracker {
  constructor(deviceId, ws) {
    this.deviceId = deviceId;
    this.ws = ws;

    this.csiFilter = new HampelFilter(40, 3); // increasing memory filter to catch slower falls
    this.systemState = "IDLE";
    this.alertTimer = null;
    this.observationTimer = null;
    this.isAlertActive = false;

    this.persistentPirState = 0;

    this.postFallVarianceSum = 0;
    this.postFallFrameCount = 0;

    // EMA Smoothing Variables
    this.smoothedAmplitude = null;
    this.emaAlpha = 0.2; // 0.2 means 20% new data, 80% history (heavy smoothing)

    logSystemEvent(this.deviceId, "CONNECTED", "Device initialized tracking.");
  }

  processSensorData(sensorData) {
    this.persistentPirState = sensorData.pir;

    // Apply EMA Smoothing before Variance Calculation
    if (this.smoothedAmplitude === null) {
      this.smoothedAmplitude = sensorData.amplitude;
    } else {
      this.smoothedAmplitude =
        this.emaAlpha * sensorData.amplitude +
        (1 - this.emaAlpha) * this.smoothedAmplitude;
    }

    let filterResult = this.csiFilter.process(this.smoothedAmplitude);

    // HUMAN ACTIVITY CLASSIFIER
    let activityStatus = "EMPTY";

    if (this.systemState === "ALERT") {
      activityStatus = "🚨 FALL DETECTED 🚨";
    } else if (this.systemState === "FALL_SUSPECTED") {
      activityStatus = "⚠️ ANALYZING IMPACT...";
    } else if (this.persistentPirState === 1) {
      // setting threshold according to test
      if (filterResult.variance >= 3.0) {
        activityStatus = "🏃 RUNNING / LARGE MOVEMENT";
      } else if (filterResult.variance >= 1.5) {
        activityStatus = "🚶 WALKING";
      } else {
        activityStatus = "🧍 IDLE / SITTING";
      }
    }

    process.stdout.write(
      `\r[DEV: ${this.deviceId}] [SYS: ${this.systemState}] [Activity: ${activityStatus.padEnd(26)}] PIR: ${this.persistentPirState} | Var: ${filterResult.variance.toFixed(2)}      `,
    );

    // THE MEDICAL STATE MACHINE
    if (this.systemState === "IDLE") {
      if (
        filterResult.variance > 4.0 &&
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

          if (averagePostFallVariance < 1.5) {
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
        }, 8000);
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
    }, 30000);
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
  console.log(`GuardianWave Live Activity Tracker Online`);
  console.log(`===================================================`);
});
