require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

// TWILIO CONFIGURATION
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// DATABASE SETUP (SQLite)
const db = new sqlite3.Database("./guardianwave.db");
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT, 
        email TEXT UNIQUE, 
        password TEXT, 
        phone TEXT
    )`);
});

// EXPRESS MIDDLEWARE
app.use(express.json());
app.get("/", (req, res) => {
  res.redirect("/landing.html");
});
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// AUTHENTICATION ROUTES
app.post("/api/signup", (req, res) => {
  const { name, email, password, phone } = req.body;
  db.run(
    `INSERT INTO users (name, email, password, phone) VALUES (?, ?, ?, ?)`,
    [name, email, password, phone],
    function (err) {
      if (err)
        return res.status(400).json({ error: "Email already registered" });
      res.json({ success: true, name: name });
    },
  );
});

app.post("/api/signin", (req, res) => {
  const { email, password } = req.body;
  db.get(
    `SELECT name FROM users WHERE email = ? AND password = ?`,
    [email, password],
    (err, row) => {
      if (row) res.json({ success: true, name: row.name });
      else res.status(401).json({ error: "Invalid email or password" });
    },
  );
});

// UTILITY: Alert Persistence & UI Broadcasting
function logSystemEvent(deviceId, eventType, details) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] DEV:${deviceId} | EVENT:${eventType} | DETAILS:${details}\n`;
  fs.appendFileSync("alert_history.log", logEntry);
}

function broadcastToUI(payload) {
  wss.clients.forEach((client) => {
    if (client.isUI && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });
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
let activeDashboardUser = null;

class DeviceTracker {
  constructor(deviceId, ws) {
    this.deviceId = deviceId;
    this.ws = ws;

    this.csiFilter = new HampelFilter(15, 3);
    this.systemState = "IDLE";
    this.alertTimer = null;
    this.observationTimer = null;
    this.isAlertActive = false;

    this.persistentPirState = 0;
    this.postFallVarianceSum = 0;
    this.postFallFrameCount = 0;

    this.smoothedAmplitude = null;
    this.emaAlpha = 0.5;

    logSystemEvent(
      this.deviceId,
      "CONNECTED",
      "ESP32 Device initialized tracking.",
    );
  }

  processSensorData(sensorData) {
    this.persistentPirState = sensorData.pir;

    if (this.smoothedAmplitude === null) {
      this.smoothedAmplitude = sensorData.amplitude;
    } else {
      this.smoothedAmplitude =
        this.emaAlpha * sensorData.amplitude +
        (1 - this.emaAlpha) * this.smoothedAmplitude;
    }

    let filterResult = this.csiFilter.process(this.smoothedAmplitude);

    let activityStatus = "Room is empty";
    if (this.systemState === "ALERT") {
      activityStatus = "FALL DETECTED";
    } else if (this.systemState === "FALL_SUSPECTED") {
      activityStatus = "Analyzing impact...";
    } else if (this.persistentPirState === 1) {
      if (filterResult.variance >= 3.0) {
        activityStatus = "Large movement / Running";
      } else if (filterResult.variance >= 1.5) {
        activityStatus = "Walking detected";
      } else {
        activityStatus = "Presence confirmed (Idle)";
      }
    }

    broadcastToUI({
      event: "csiVariance",
      value: filterResult.variance,
      timestamp: Date.now(),
    });
    broadcastToUI({
      event: "pirStatus",
      value: this.persistentPirState,
      message: activityStatus,
      timestamp: Date.now(),
    });

    process.stdout.write(
      `\r[DEV: ${this.deviceId}] [SYS: ${this.systemState}] [Activity: ${activityStatus.padEnd(26)}] PIR: ${this.persistentPirState} | Var: ${filterResult.variance.toFixed(2)}      `,
    );

    if (this.systemState === "IDLE") {
      if (
        filterResult.variance > 5.0 &&
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
    broadcastToUI({
      event: "fallAlert",
      status: "detected",
      timestamp: Date.now(),
    });

    this.alertTimer = setTimeout(() => {
      if (this.isAlertActive) {
        console.log(
          `\n[DEV: ${this.deviceId}] [ESCALATION] No response. Executing Twilio Voice Call...`,
        );
        logSystemEvent(
          this.deviceId,
          "TWILIO_CALL",
          "Victim unresponsive. Fetching registered number...",
        );
        broadcastToUI({
          event: "fallAlert",
          status: "escalated",
          timestamp: Date.now(),
        });

        const fallbackNumber = process.env.MY_PHONE_NUMBER;

        db.get(
          `SELECT phone FROM users WHERE name = ?`,
          [activeDashboardUser],
          (err, row) => {
            const targetPhoneNumber =
              row && row.phone ? row.phone : fallbackNumber;

            console.log(
              `[DEV: ${this.deviceId}] Dialing emergency contact: ${targetPhoneNumber}`,
            );

            twilioClient.calls
              .create({
                twiml:
                  '<Response><Say voice="alice">Critical Alert. Guardian Wave has detected a severe fall. The victim appears unresponsive. Immediate assistance is required.</Say></Response>',
                to: targetPhoneNumber,
                from: TWILIO_PHONE_NUMBER,
              })
              .then((call) => {
                let checkStatus = setInterval(async () => {
                  try {
                    let currentCall = await twilioClient
                      .calls(call.sid)
                      .fetch();
                    if (
                      ["no-answer", "busy", "failed", "canceled"].includes(
                        currentCall.status,
                      )
                    ) {
                      clearInterval(checkStatus);
                      broadcastToUI({
                        event: "hospitalFallback",
                        timestamp: Date.now(),
                      });
                      logSystemEvent(
                        this.deviceId,
                        "HOSPITAL_ESCALATION",
                        "Contact unavailable. Hospital notified.",
                      );
                    } else if (currentCall.status === "completed") {
                      clearInterval(checkStatus);
                      logSystemEvent(
                        this.deviceId,
                        "CALL_ANSWERED",
                        "Contact answered the emergency call.",
                      );
                    }
                  } catch (e) {
                    console.error("Error fetching call status", e);
                  }
                }, 3000);
              })
              .catch((err) =>
                console.error(`[TWILIO ERROR] Failed to dial:`, err),
              );
          },
        );

        this.resetState();
      }
    }, 30000); // 30 seconds to match the UI Countdown
  }

  cancelAlert() {
    console.log(
      `\n[DEV: ${this.deviceId}] [RESOLVED] Alert cancelled. Resetting system.`,
    );
    logSystemEvent(this.deviceId, "ALERT_CANCELED", "Alarm dismissed.");
    broadcastToUI({
      event: "fallAlert",
      status: "resolved",
      timestamp: Date.now(),
    });
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
let activeTracker = null;

wss.on("connection", (ws, req) => {
  ws.on("message", (message) => {
    let dataStr = message.toString();
    let payload;
    try {
      payload = JSON.parse(dataStr);
    } catch (e) {
      return;
    }

    if (payload.event === "ui_connect") {
      ws.isUI = true;
      console.log(`\n[+] Web Dashboard UI Connected`);
      return;
    }

    if (payload.event === "set_active_user") {
      activeDashboardUser = payload.user;
      console.log(`\n[+] Dashboard linked to user: ${activeDashboardUser}`);
      return;
    }

    if (payload.event === "cancel_alert" && activeTracker) {
      activeTracker.cancelAlert();
      return;
    }

    if (payload.event === "sensor_stream") {
      if (!activeTracker || activeTracker.ws !== ws) {
        const deviceId = req.socket.remoteAddress;
        console.log(`\n[+] ESP32 Connected! Assigned ID: ${deviceId}`);
        activeTracker = new DeviceTracker(deviceId, ws);
      }
      activeTracker.processSensorData(payload);
    }
  });

  ws.on("close", () => {
    if (!ws.isUI && activeTracker && activeTracker.ws === ws) {
      console.log(`\n[-] ESP32 Disconnected`);
      logSystemEvent(
        activeTracker.deviceId,
        "DISCONNECTED",
        "Connection closed.",
      );
      activeTracker.resetState();
      activeTracker = null;
    } else if (ws.isUI) {
      console.log(`\n[-] Web Dashboard UI Disconnected`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`===================================================`);
  console.log(`GuardianWave Server Online at http://localhost:${PORT}`);
  console.log(`===================================================`);
});
