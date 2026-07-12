# GuardianWave 🌊 (Citadel 1.0)

GuardianWave is a contactless, privacy-preserving fall detection system designed for elderly care and remote monitoring. It completely eliminates the need for cameras or wearable devices by leveraging Wi-Fi Channel State Information (CSI) and PIR (Passive Infrared) sensors to detect severe impacts and post-fall stillness. If a fall is confirmed and goes unresolved, the system automatically escalates the event by calling an emergency contact via the Twilio Voice API.

**Live Demo**


**Deployed link**


Built by team HackCypher at Citadel 1.0.

## 🌟 Key Features

- **Camera-less fall detection** — uses radio frequency (CSI) variance and PIR motion data to identify sudden falls and subsequent stillness, using a custom **Hampel filter** and **variance/Threshold state.**
- **Real-time web dashboard** — a live, WebSocket-powered UI displaying real-time CSI variance charts, PIR activity status, and alert history.
- **Emergency escalation** — 30-second local buzzer/overlay warning, escalating to an automated Twilio phone call if unattended.
- **Hospital demo mode** — simulates routing to a hospital if the emergency contact does not pick up.
- **User authentication** — SQLite-backed user registration and session persistence, with support for multiple emergency contacts per account.
- **Privacy-first** — processes only radio chaos data; absolutely no audio or video is recorded or streamed.

## 🛠 Channel State Information

How CSI Detects Motion: Amplitude Attenuation & Phase Shift
WiFi signals travel from transmitter to receiver along multiple paths — some direct, some reflected off walls, furniture, and people. Channel State Information (CSI) captures how each of these paths distorts the signal, measured per subcarrier as a complex value with two components:

**Amplitude attenuation** — how much the signal's strength is weakened along a given path. A body moving through or near a signal path absorbs and scatters RF energy, causing a measurable dip (or spike, depending on path geometry) in amplitude compared to the static, undisturbed baseline.

**Phase shift** — how much the signal's timing/waveform is offset, caused by small changes in path length. Since phase is highly sensitive to distance changes on the scale of the WiFi wavelength (a few centimeters), even subtle body movement — breathing, shifting, walking — measurably shifts the phase of affected subcarriers.

Together, amplitude and phase describe how the signal's path was disturbed — not the object itself, but the effect it had on the wave reaching the receiver. GuardianWave uses this by comparing each live frame against a learned baseline (see AdaptiveBackgroundModel): when a person's presence or movement alters either the amplitude or phase profile of the signal, that deviation becomes the raw disturbance signal the fall-detection pipline

## 🛠 Hardware Setup

You will need two ESP32 microcontrollers:

1. **The Wi-Fi based Tripwire (Emitter)** — any standard ESP32 plugged into a wall outlet across the room. It constantly broadcasts UDP packets to act as a radio "metronome."
2. **The Brain (Receiver)** — an ESP32-S3 equipped with a PIR motion sensor (Pin 5) and an active buzzer (Pin 4). It reads the radio waves, applies MAC filtering, calculates signal variance, and streams the data to the Node.js server.


## 💻 Threshold Logic

  1. Baseline Subtraction
What it does: Separates "the room as it normally is" from "something changed."
Static objects (walls, furniture) always distort the WiFi signal the same way, so raw CSI amplitude never sits at zero — it has a large, constant offset from just being in a room. Your AdaptiveBackgroundModel tracks a slowly-updating running average of this static component (via background_alpha) and subtracts it from each incoming frame:
dynamic = raw_amplitude − background_estimate
    2. Deviation Signal Extraction
What it does: Converts the baseline-subtracted signal into a single number representing "how much did this frame just deviate."
After subtraction, you collapse the multi-subcarrier dynamic frame into one scalar per sample:
disturbance_magnitude = mean(|dynamic|).
    3. Threshold Limit
What it does: Decides how large a deviation has to be before it counts as "something happened," using a statistical threshold rather than a fixed number.
Instead of a hardcoded magnitude cutoff (which would break the moment lighting, furniture, or WiFi conditions changed), your FallDetector computes a rolling z-score.
     

Power is supplied via an MB102 breadboard power module (5V rail) rather than directly from a battery, to keep the supply regulated during WiFi transmit current spikes — an unregulated supply was found to cause false PIR triggers and noise spikes in the CSI variance reading during testing.

## 💻 Software Installation

### 1. Clone the repository
```bash
git clone https://github.com/saloni3132007-ui/GUARDIAN_WAVE.git
cd GUARDIAN_WAVE/guardianwave_cloud
```

### 2. Install dependencies
Ensure you have Node.js installed, then run:
```bash
npm install express ws twilio sqlite3 dotenv
```

### 3. Environment variables (crucial)
Create a `.env` file in the root of the `guardianwave_cloud` directory. Add your Twilio credentials and phone numbers. **Do not commit this file to GitHub.**

```
PORT=3000
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=+1234567890
MY_PHONE_NUMBER=+1987654321
```

| Variable | Purpose |
|---|---|
| `PORT` | The local port for the Node.js server (default: 3000). |
| `TWILIO_ACCOUNT_SID` | Account SID from the Twilio Console (API authentication). |
| `TWILIO_AUTH_TOKEN` | Auth Token from Twilio (API authorization). |
| `TWILIO_PHONE_NUMBER` | Virtual phone number provided by Twilio for outbound calls. |
| `MY_PHONE_NUMBER` | The emergency contact's real-world phone number. |

## 🚀 Running the System

1. **Start the backend server:**
   ```bash
   node server.js
   ```
   The server will automatically generate the `guardianwave.db` SQLite database if it doesn't exist.
2. **Access the dashboard:** open your browser and navigate to `http://localhost:3000`. You'll land on the marketing/landing page. Sign up for an account (including at least one emergency contact) to access the live dashboard.
3. **Power the hardware:** plug in the Emitter ESP32, followed by the Brain ESP32. The Brain will automatically connect to the WebSocket server and begin streaming data to the UI.

## 📂 Project Structure

```
GUARDIAN_WAVE/
│
├── guardianwave_firmware/          # Hardware code (ESP-IDF)
│   ├── main/
│   │   └── main.c                  # Brain ESP32 logic (CSI callback, WebSockets, PIR)
│   └── CMakeLists.txt              # Firmware build config
│
└── guardianwave_cloud/             # Backend server & frontend UI
    ├── .env                        # (Ignored) Environment variables & Twilio keys
    ├── package.json                # Node.js dependencies
    ├── server.js                   # Core backend (Express routes, WebSocket server, DSP logic)
    ├── guardianwave.db             # (Ignored) Auto-generated SQLite database
    ├── alert_history.log           # (Ignored) Persistent logging for system anomalies
    │
    └── public/                     # Frontend static assets
        ├── landing.html            # Marketing page — hero, features, workflow diagram, gallery
        ├── signin.html             # Sign in, with a tab to switch to sign up
        ├── signup.html             # Sign up — account details + multiple emergency contacts
        ├── index.html              # Live dashboard — status ring, breathing rate, CSI + breathing charts, fall alert overlay
        │
        ├── css/
        │   └── custom.css          # Design tokens, animations, and Tailwind-inspired styling
        │
        └── js/
            ├── socketClient.js     # WebSocket connection manager (pub/sub pattern)
            ├── chartConfig.js      # Chart.js initialization and live data feeding
            └── main.js             # DOM manipulation, alert overlays, and auth guards
```

## 🎨 Frontend design system — "Night Nurse"

The dashboard and marketing pages share a calm, clinical-safety visual language — closer to a warm hospital bedside monitor than a cold data tool, since the real audience is both the monitored person's family and (during the hackathon) the judges.

- **Palette:** deep teal-navy background (`#0F1B1E` / `#080F11`), card surface `#16262A` / `#12211F`, calm/breathing accent `#4FD1A5`, alert accent `#FF7A59` (fall/escalation), decision accent `#E8A33D` (in-progress/buzzer state), text `#E8F0EE` / muted `#7C9490`.
- **Typography:** IBM Plex Sans for UI and labels, IBM Plex Mono for numeric readouts (breathing rate, timestamps) — gives a precise, medical-monitor feel.
- **Motion:** ambient drifting glow blobs, staggered fade/blur-in entrances, a continuously pulsing "alive" glow on primary CTAs and the breathing waveform, and animated flowing connectors in the workflow diagram to visualize data moving through the pipeline. All animation respects `prefers-reduced-motion`.
- **Dashboard layout:** top status bar (connection + device) → status ring (calm ✓ / alert ⚠) + breathing rate → three status cards (Breathing / PIR / Fall alert) → CSI signal variance chart → breathing waveform chart → full-screen fall alert overlay with a 30-second countdown and a "mark as checked" resolve action.
- **Auth flow:** sign up collects name, email, password, and an expandable list of emergency contacts (name + phone each, first one marked primary and non-removable). Successful sign in or sign up redirects straight into the live dashboard.


## 👥 Team

**HackCypher — Citadel 1.0 Hackathon**
1. Saloni Gupta(Team lead)- Hardware and Research
2. Narayan Shaw- Backend and Database
3. Saurav Choubey- Frontend
