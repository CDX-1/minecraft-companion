# Minecraft Companion

An AI-powered Minecraft bot that acts as a living, personality-driven companion — one that listens, builds, fights, and remembers.

**🥉 3rd Place Overall — EurekaHacks 2026**

---

## What It Does

Minecraft Companion is an intelligent bot that joins your Minecraft server and responds to natural language commands via chat or voice. It understands what you want, takes action in-game, and reacts with personality. You can ask it to build a house, gather resources, follow you into combat, or just have a conversation — all in plain English.

The bot isn't just reactive. Depending on its autonomy level, it proactively helps, remembers your preferences, tracks your home base, and adapts its tone based on how the session is going.

---

## Features

### AI Agent
- Natural language command understanding via **OpenAI GPT** or **Google Gemini**
- Persistent memory: remembers your home, known chests, active tasks, and past interactions
- Mood system that shifts based on damage taken, idleness, and player behavior

### Building System
- AI-generated structure designs via Gemini, executed block-by-block in-game
- **Builder Crew** — spawns temporary helper bots to parallelize large builds
- Safe foundation checking, material tracking, and phased build progress reporting

### In-Game Capabilities
- Pathfinding and navigation around terrain and obstacles
- Combat with PvP support and auto-armor equipping
- Auto-eating and health management
- Block collection and inventory awareness

### Personality System
Four selectable personalities, each with distinct tone, voice lines, and behavior:

| Personality | Description |
|-------------|-------------|
| **Friendly** | Warm, casual, eager to help |
| **Flirty** | Playful, charming, affectionate |
| **Tsundere** | Grumpy on the surface, secretly caring |
| **Arrogant** | Confident, witty, slightly superior |

Each personality has unique voice lines for greetings, combat, building milestones, and more.

### Voice Integration
- **Push-to-talk** via global keyboard shortcut
- **Text-to-speech** via ElevenLabs with streaming support
- Browser-based voice control interface

### Autonomy Levels
- **Passive** — responds only to direct commands
- **Balanced** — takes some initiative when appropriate
- **Proactive** — actively assists and makes suggestions

### Hardware (Optional)
- **ESP32 LED status light** — RGB strip reflecting bot health (green / yellow / red) over serial

### Terminal UI
- Blessed-based TUI dashboard with live chat log, telemetry, build progress, and mood indicators

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript / Node.js |
| Minecraft | Mineflayer + pathfinder, pvp, collectblock, auto-eat |
| AI | OpenAI GPT, Google Gemini |
| Voice In | Browser-based microphone input |
| Voice Out | ElevenLabs TTS |
| Terminal UI | Blessed |
| Hardware | ESP32 via SerialPort |
| Build | tsc + ts-node |

---

## Getting Started

### Prerequisites

- Node.js 18+
- A running Minecraft Java Edition server (local or remote)
- At least one of: OpenAI API key or Gemini API key
- (Optional) ElevenLabs API key for voice output

### Install

```bash
git clone https://github.com/CDX-1/minecraft-companion
cd minecraft-companion
npm install
```

### Configure

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `MC_HOST` | Minecraft server hostname |
| `MC_PORT` | Minecraft server port (default: `25565`) |
| `MC_USERNAME` | Bot's in-game username |
| `OPENAI_API_KEY` | OpenAI API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `GEMINI_MODEL` | Gemini model ID |
| `ELEVENLABS_API_KEY` | ElevenLabs API key (optional) |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice UUID (optional) |
| `LED_SERIAL_PORT` | Serial port for ESP32 LED (optional) |

### Run

```bash
npm run dev
```

An interactive setup wizard will guide you through server connection, bot personality, autonomy level, voice settings, and API configuration on first launch.

---

## Example Commands

Once the bot is in your Minecraft world, just chat to it:

```
Build me a small wooden cabin
Follow me
Stop what you're doing
Come home
Attack the nearest zombie
Collect all the wood around here
What's in your inventory?
Go to my home base
```

---

## Project Structure

```
src/
├── index.ts              # Entry point & setup wizard
├── agent.ts              # Core AI agent loop and tool definitions
├── bot.ts                # Mineflayer bot creation
├── ui.ts                 # Terminal dashboard
├── config.ts             # Configuration types
├── botMood.ts            # Mood tracking
├── voiceServer.ts        # Browser voice control server
├── globalPushToTalk.ts   # Keyboard PTT listener
├── ledStatus.ts          # ESP32 serial control
├── agent/
│   ├── MemoryManager.ts  # Persistent memory
│   └── StateMachine.ts   # Agent state machine
└── services/
    ├── builder.ts         # Structure building
    ├── builderCrew.ts     # Multi-bot build coordination
    ├── elevenLabs.ts      # TTS integration
    └── geminiBuilder.ts   # AI structure generation
arduino/
└── esp32-status-led/     # ESP32 firmware for hardware LED
```

---

## Hardware Setup (Optional)

The bot can drive an RGB LED strip via an ESP32 to show its health state at a glance:

- **Green** — healthy and active
- **Yellow** — taking damage / low health warning
- **Red** — critical / offline

Flash the firmware in `arduino/esp32-status-led/` to your ESP32 and set `LED_SERIAL_PORT` in your `.env`.

---

## Running Tests

```bash
npm test
```

---

## Built With

- [Mineflayer](https://github.com/PrismarineJS/mineflayer) — Minecraft bot API
- [OpenAI](https://platform.openai.com/) — Language model
- [Google Gemini](https://ai.google.dev/) — Structure generation
- [ElevenLabs](https://elevenlabs.io/) — Text-to-speech
- [Blessed](https://github.com/chjj/blessed) — Terminal UI

---

## License

MIT
