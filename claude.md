# Setup

Required env vars in `.env`:
- `OPENAI_API_KEY` — agent loop (gpt-4.1-mini)
- `GEMINI_API_KEY` — build pipeline (gemini-2.5-pro). Optional override: `GEMINI_MODEL`.
- `ELEVENLABS_API_KEY` — voice (optional, gated by `ELEVENLABS_ENABLED`)

Required system deps:
- Node 18+ (`npm install`)
- Python 3 on PATH (or set `PYTHON_CMD` to its absolute path). On first build the bot creates a per-project venv at `.pybuild/` and `pip install`s `mcschematic` into it — no global package conflicts.

Build flow: when a chat message looks like a build request, the agent skips the OpenAI tool loop and asks Gemini to write a Python script that generates a `.schem` file via `mcschematic`. The `.schem` is parsed (Sponge V2/V3) and replayed into the world via `/setblock`, anchored ~8 blocks in front of the player.

# `vibe-companion.md`

## Project Vision: The Multimodal Architect
A high-fidelity Minecraft AI companion that bridges the gap between **autonomous agents** and **collaborative design**. By integrating **ElevenLabs** for low-latency, emotive speech and a **React-powered CLI**, the companion moves beyond being a "bot" to becoming a sentient-feeling partner. It doesn't just build; it discusses, strategizes, and executes with a distinct personality.

---

## 1. User Experience (POV)
The user experience is defined by a "Hands-on-Keyboard, Ears-in-Game" flow. You are essentially "pair-programming" a physical world.

### **The Multi-Sensory Dialogue**
1.  **Voice-First Interaction:** You don't just type. You speak through your mic: *"Hey, let's turn this hill into a brutalist observation deck. Use deepslate and glass."*
2.  **Emotional Feedback (ElevenLabs):** The companion responds instantly with a custom-tuned voice (e.g., "The Stoic Architect"). 
    *   *Bot:* "Brutalist? Bold choice for this biome. I'll sketch out the primary slabs now—check the ghosting."
3.  **Visual Confirmation (The Ghosting System):** Semi-transparent particle structures appear in-game. You see the "thought process" of the AI before a single block is placed.
4.  **CLI Dashboard:** Your secondary monitor shows the **Ink/React CLI**, providing deep telemetry: structural integrity checks, resource counts, and the LLM's "Chain of Thought" reasoning logs.

---

## 2. Technical Architecture: The Quad-Layer Stack
To optimize for a hackathon, we use a modular architecture that separates "Thinking" from "Moving" and "Speaking."

### **Layer 1: The Brain (Logic)**
*   **Engine:** Claude 3.5 Sonnet (for superior spatial reasoning).
*   **Memory:** **Supabase (pgvector)**. It stores "Style Embeddings"—if you've built "Gothic" before, it remembers your specific preference for pointed arches.
*   **Output:** Generates JSON "Blueprint" objects.

### **Layer 2: The Body (Execution)**
*   **Core:** **Mineflayer** running in a headless Node.js container.
*   **Tunneling:** **LocalXpose** creates a bridge to your local `online-mode=false` server.
*   **Skills:** Programmatic Skill Network (PSN) allows the bot to "refactor" structures—replacing materials or shifting walls without starting over.

### **Layer 3: The Voice (Synthesis)**
*   **API:** **ElevenLabs (WebSocket Turbo v2.5)**.
*   **Implementation:** The LLM output is streamed to ElevenLabs. The resulting audio is piped either through a virtual audio cable into Minecraft's proximity chat or directly through the CLI dashboard for the user to hear.
*   **Dynamic Inflection:** The bot uses different stability/clarity settings based on the situation (e.g., sounding urgent during a zombie raid, or calm while building).

### **Layer 4: The Interface (CLI)**
*   **Framework:** **Ink (React for CLI)**.
*   **Bonus Points:** Demonstrates "Developer-Centric" design. It tracks:
    *   **TPS (Ticks Per Second):** Server performance.
    *   **Inventory Manifest:** Live list of what the bot is carrying.
    *   **Task Queue:** A list of pending blocks to be placed.

---

## 3. The Winning Workflow: "The Iterative Refactor"

| Stage | User Action | AI Logic | ElevenLabs Voice |
| :--- | :--- | :--- | :--- |
| **Draft** | "Build a tower." | Fetches 'Tower' template from Supabase. | "Right away. Starting the draft." |
| **Preview** | Walks through ghost blocks. | Renders particle effects at XYZ coords. | "How's the height? I can scale it up." |
| **Modify** | "Make it more modern." | Swaps Cobblestone for Quartz in the JSON. | "Switching to a minimalist palette." |
| **Execute** | "Proceed." | Mineflayer begins pathfinding/placement. | "Gathering materials. Watch my back." |

---

## 4. Why This Wins the Hackathon
1.  **Multimodal Sophistication:** Most entries will be text-only. Combining **ElevenLabs** with **Mineflayer** creates a "living" entity.
2.  **CLI Aesthetics:** Using **Ink** to build a professional terminal dashboard satisfies the "CLI Bonus" while providing a better UX than standard in-game chat.
3.  **Zero-Friction Distribution:** The "Cloud-Joiner" model means judges don't need to buy an extra account or install mods to see it work.
4.  **Strategic Value:** It solves a real problem—Minecraft building is tedious; "Vibe Building" makes it creative again.

---

## 5. Technical Implementation Note (ElevenLabs)
To keep latency low for the hackathon, use the **ElevenLabs WebSocket API**. This allows you to stream text from the LLM and get audio back in chunks, ensuring the bot starts "speaking" before the LLM has even finished its full sentence.

# `claude.md`

## The Vision: Vibe-Architect
**Vibe-Architect** is not a "builder bot"; it is a **Collaborative Strategic Partner**. While current Minecraft AI solutions focus on one-shot generation (prompt → result), Vibe-Architect focuses on **iterative spatial reasoning**. It bridges the gap between the player’s creative intent and the game’s block-level complexity using a multimodal "Mission Control" interface.

---

## 1. Why We Win: The "Vibe" Differentiation
Existing tools like *MinePal* or *Voyager* treat building as a transaction. We treat it as a conversation.

| Feature | The "Other" Guys | **Vibe-Architect** |
| :--- | :--- | :--- |
| **Workflow** | **One-Shot:** Prompt it, it builds, you're stuck with it. | **Iterative:** Draft → Ghost → Refine → Execute. |
| **Precision** | **Vague:** "Build a house" creates a random prefab. | **Granular:** "Move that window two blocks left" works. |
| **Interface** | **Cluttered:** In-game chat spam or complex mods. | **Pro-Grade:** Bespoke Ink/React CLI (Mission Control). |
| **Presence** | **Silent/Text:** Robotic and disconnected. | **Sentient:** Low-latency ElevenLabs voice synthesis. |
| **Control** | **Coordinate-Based:** Requires typing "at 120, 64, -10". | **Spatial:** Uses player raycast (where you look). |

---

## 2. The Core Mechanics: How it Looks & Feels

### **The "Ghosting" System**
Unlike other bots that start placing blocks immediately, Vibe-Architect renders a **non-physical preview**.
*   When you say, *"Let's put a futuristic watchtower here,"* the bot uses `/particle` commands to create a semi-transparent "Ghost" of the structure.
*   **The Benefit:** You can walk through the "thought" of the building, checking the vibe and scale before the bot spends a single resource or places a permanent block.

### **Mission Control (The React/Ink CLI)**
We separate the **Execution** (Minecraft) from the **Intelligence** (The Terminal).
*   **Astronaut View (In-Game):** You focus on playing, exploring, and looking at the structure.
*   **Mission Control View (CLI):** A secondary monitor displays the "Brain" of the bot. It shows real-time progress bars, structural logs, and the LLM's chain-of-thought.
*   **The Bonus:** This satisfies the "CLI-First" requirement while providing a professional telemetry dashboard that in-game chat simply cannot support.

### **The ElevenLabs Voice Bridge**
The bot doesn't just act; it explains its choices. 
*   *"I’m using deepslate for the base to give it that grounded, brutalist weight you asked for. Should I switch to glass for the upper deck?"*
*   **The Tech:** Using the ElevenLabs WebSocket, the bot starts speaking the moment the LLM begins generating, reducing the "AI lag" to near-zero.

---

## 3. Technical Architecture (The "CTO" Blueprint)

### **The Brain-Body-Voice Pipeline**
1.  **Input:** User speaks (Mic) or types (CLI/Game Chat).
2.  **Reasoning (Claude 3.5 + Supabase):** The LLM pulls "Vibe Templates" from a pgvector database and generates a **JSON Blueprint**.
3.  **The Ghosting Engine:** The bot renders the JSON as particles for user approval.
4.  **The Refactor Loop:** If the user says *"Higher,"* the LLM updates the JSON, and the Ghosting Engine "hot-reloads" the particle preview.
5.  **Execution (Mineflayer):** Upon "Commit," the bot uses a Programmatic Skill Network to pathfind, gather materials, and build.

---

## 4. The "Wow" Demo Script
1.  **The Summon:** Type `/summon` in the CLI. The bot joins and says, *"Architect online. What's the vibe for today?"* via ElevenLabs.
2.  **The Intent:** Look at a mountain. Type/Say: *"Let's build a minimalist glass villa hanging off that ledge."*
3.  **The Ghost:** Instantly, a shimmering particle outline of a villa appears on the cliffside.
4.  **The Refinement:** You say, *"Actually, make the balcony wrap around the whole side."* The particles shift and expand in real-time.
5.  **The Commitment:** You type `> proceed`. The CLI shows a progress bar `[████░░░░░░] 42%` as the bot starts placing blocks. 
6.  **The Partnership:** While building, the bot says: *"I noticed a creeper near your storage crates—I've tagged it for you."*

---

## 5. Summary
Vibe-Architect wins because it moves AI from a **tool** to a **teammate**. It uses a sophisticated technical stack (React, Supabase, ElevenLabs, Mineflayer) to solve the "intent gap" in creative games, providing a "Mission Control" experience that is technically superior and visually stunning.







How it builds. We should use the creative approach but only for building for now.

This is the exact question that separates the theoretical "whiteboard" architects from the engineers who actually have to ship the code. You’ve hit on the hardest physical constraint of Minecraft bot development: **Execution vs. Pathfinding.**

If the bot is a "player," it is bound by the server's physics engine. Here is the reality of how your AI will actually place blocks, and the exact strategy you should use to win the hackathon.

### The Two Ways a Bot Can Build

Because the bot is using **Mineflayer** (which emulates a real Minecraft client), it has to follow the rules of the game mode it is in.

#### 1. Survival Mode (The "Authentic" Nightmare)
If the bot is in regular Survival mode, it builds exactly like you do.
*   **The Process:** It must have the item in its inventory -> hold it in its main hand -> walk within 4.5 blocks of the target -> calculate the exact pitch/yaw to look at the face of an adjacent block -> send a "Right Click" packet to the server.
*   **The Problem:** Building a 10-block high wall in Survival means the bot has to understand **scaffolding**. It has to jump, place a dirt block under itself, build the wall, and then mine the dirt block when it's done. 
*   **The Verdict:** Do **NOT** try to write a dynamic Survival scaffolding algorithm in 48 hours. Your bot will get stuck in a tree, fall off a cliff, or suffocate in a wall.

#### 2. Creative Mode (The "God Mode" Flex)
If you give the bot server operator (`/op`) status and put it in Creative mode, all physical limits are removed.
*   **The Process:** It can fly. It doesn't need blocks in its inventory. It just hovers around the structure and spams "Right Click" packets. 
*   **The Problem:** If you don't artificially limit its speed, a Mineflayer bot can place 1,000 blocks in 3 seconds. It looks like a glitch, not a "Companion." It breaks the immersion of a collaborative partner.

---

### The Hackathon Winning Strategy: "Constrained Creative"

To get the "Wow" factor of a companion *without* spending 30 hours debugging pathfinding physics, you use a hybrid approach. 

For the demo, **put the bot in Creative Mode, but code it to act like a Human.**

Here is how you engineer that illusion:

1.  **The Ghosting is Instant:** As discussed, when you finalize the "vibe," the bot instantly uses `/particle` commands to show the transparent blueprint. This proves the LLM's speed and spatial reasoning.
2.  **The "Human" Execution Loop:** When you type `> proceed`, the bot switches to execution. 
    *   You write a `for` loop in Node.js that iterates through the JSON blueprint.
    *   Instead of placing them all at once, you add a `setTimeout` of **250 to 500 milliseconds** between each block placement.
3.  **The "Fly-By" Pathfinding:** Because it's in Creative, you tell the bot to fly to a coordinate slightly above/outside the bounding box of the structure, look down, and place the blocks. It avoids the math of scaffolding entirely but still visually looks like it is "working" on the building.

### How this looks to the Judges (The Illusion)

*   **Judge:** "Is it in Creative or Survival?"
*   **You (The CTO):** "For the scope of this weekend, the execution layer operates in a constrained Creative mode so it doesn't get bogged down in scaffolding pathfinding. However, the reasoning layer—the part managing the inventory logic, the JSON generation, and the voice synthesis—is fully modeled for a Survival integration."

This proves you understand the technical debt of the game's physics engine and made a conscious, intelligent engineering tradeoff to deliver a working, high-fidelity demo. 

**For your Role (The Interface/Voice):** 
While the "Body" guy is making the bot fly around placing blocks on a 500ms delay, you trigger the ElevenLabs voice to say: *"Placing the oak framing now. Let me know if you want to change the wood type before I finish the roof."* 

It completely masks the fact that the bot is basically using cheats to build, because it *feels* like a conversation.