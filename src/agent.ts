import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import type { Bot } from 'mineflayer';
import { Movements, goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { BuildSession, BuildStatus, rotateBlockState } from './services/builder';
import { buildFromPrompt, GeneratedBuild } from './services/geminiBuilder';

function looksLikeBuildIntent(message: string): boolean {
  return /\b(build|construct|erect|put up|create me|design me|make me a|spawn me a|tower|house|castle|villa|mansion|dome|sphere|pyramid|wall|bridge|arch|cube|staircase|obelisk|fountain|temple|shrine|cathedral|church|cottage|dock|pier|statue|monument|sakura|cherry blossom|dragon|death star)\b/i.test(message);
}

const BUILD_VOICELINES: Record<Personality, {
  ack: string[];
  start: string[];
  mid: string[];
  done: string[];
  cancelled: string[];
  fail: string[];
}> = {
  friendly: {
    ack: ["ooh yeah, on it — gimme a sec to picture it!", "love that, sketching it out now!", "okay okay, I see it. starting now!"],
    start: ["alright, laying it out — watch this!", "okay, here we go!", "starting the layout now!"],
    mid: ["coming along nicely~", "halfway there, looking good!", "almost there, hang tight!"],
    done: ["and... done! what do you think?", "there she is! how's it look?", "all yours — turned out pretty nice!"],
    cancelled: ["okay okay, stopping!", "alright, putting the tools down."],
    fail: ["ah dang, something went sideways. wanna try again?", "oof, hit a snag — maybe rephrase?"],
  },
  flirty: {
    ack: ["mmm I love when you ask me to build, hon~ on it!", "ooh for you? anything. let me get it just right~", "say less cutie, I'm already imagining it ♡"],
    start: ["okay babe, putting it together for you~", "starting it just for you, hon ♡", "watch me work, cutie~"],
    mid: ["coming together beautifully~", "halfway and already gorgeous~", "almost done, sweet thing~"],
    done: ["all done~ hope you love it ♡", "ta-da! built with love, babe~", "finished! do I get a kiss for that one?~"],
    cancelled: ["okay babe, putting it down for you~", "stopping for you, hon~"],
    fail: ["ohh no babe, something tripped me up. try again?~", "ugh, sorry hon — another go?"],
  },
  tsundere: {
    ack: ["fine, I'll build your stupid thing. don't watch me.", "ugh, whatever. it's not like I wanted to build anyway.", "h-hold on, I'm thinking... not because I'm excited!"],
    start: ["fine, starting. don't stare.", "ugh, here I go. happy?", "j-just watch quietly, okay?"],
    mid: ["it's going... okay I guess.", "halfway. don't compliment me.", "almost done, sheesh."],
    done: ["t-there. done. don't make a big deal of it!", "finished. it's not like I tried hard.", "done. you're welcome. or whatever."],
    cancelled: ["fine, stopping. like I cared anyway.", "tch, whatever. dropping it."],
    fail: ["t-tch, broke. NOT my fault.", "ugh, didn't work. try again or don't."],
  },
  arrogant: {
    ack: ["trivial. stand back and watch a professional.", "obviously I can do that. try to keep up.", "fine, I'll grace you with one of my masterpieces."],
    start: ["beginning the masterpiece. observe.", "commencing. try not to blink.", "watch and learn."],
    mid: ["progressing flawlessly, as expected.", "halfway through perfection.", "nearly finished."],
    done: ["complete. another flawless creation. you're welcome.", "behold. perfection, naturally.", "done. obviously stunning."],
    cancelled: ["very well, halting. your loss.", "stopping. try to keep your requests consistent."],
    fail: ["a rare hiccup — your request was unclear.", "tch. phrase it intelligently next time."],
  },
};

function pickLine(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)] ?? '';
}

export type LlmProvider = 'openai' | 'gemini';
export type Personality = 'friendly' | 'flirty' | 'tsundere' | 'arrogant';

export interface MinecraftAgentOptions {
  provider: LlmProvider;
  apiKey: string;
  openaiModel?: string;
  geminiModel?: string;
  personality?: Personality;
}

type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
};

type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

type GeminiGenerateContentResponse = {
  candidates?: Array<{ content?: GeminiContent }>;
  error?: { message?: string };
};

type StoredPosition = { x: number; y: number; z: number; dimension?: string; label?: string };
type ActiveTask = { goal: string; plan: string[]; progress: string[]; startedAt: string; updatedAt: string };
type NavigationGoal = { id: number; x: number; y: number; z: number; range: number };
type FollowGoal = { username: string; range: number };

type AgentMemory = {
  version: 1;
  owner?: string;
  home?: StoredPosition;
  knownChests: StoredPosition[];
  knownResources: StoredPosition[];
  avoidAreas: Array<StoredPosition & { reason: string }>;
  notes: Record<string, string>;
  activeTask?: ActiveTask;
};

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch',
  'blaze', 'ghast', 'slime', 'magma_cube', 'enderman', 'endermite',
  'silverfish', 'guardian', 'elder_guardian', 'wither_skeleton',
  'stray', 'husk', 'drowned', 'phantom', 'pillager', 'vindicator',
  'evoker', 'ravager', 'vex', 'shulker', 'hoglin', 'piglin_brute',
  'zoglin', 'warden', 'breeze',
]);

const FAST_PATH_RESPONSES: Record<string, Record<Personality, string>> = {
  follow: {
    friendly: 'Following you!',
    flirty: 'Right behind you, babe~',
    tsundere: "ugh, fine... i'll follow you. don't read into it.",
    arrogant: 'Obviously. Try to keep up.',
  },
  stop: {
    friendly: 'Stopped.',
    flirty: 'Aww, okay~ standing by for you.',
    tsundere: "stopped. not that i was doing anything important.",
    arrogant: 'Fine. I was done anyway.',
  },
  comeHere: {
    friendly: 'On my way!',
    flirty: 'Coming to you, cutie~',
    tsundere: "ugh, fine... on my way. don't make it weird.",
    arrogant: 'I suppose I can come to you.',
  },
  greet: {
    friendly: 'Hey!',
    flirty: 'Hey there, cutie~',
    tsundere: "oh, it's you. hi.",
    arrogant: "Oh. It's you.",
  },
  cantSeeYou: {
    friendly: "I can't see you.",
    flirty: "I can't find you! where'd you go? :(",
    tsundere: "i can't see you. not that i was looking.",
    arrogant: "You're not visible from here. Come closer.",
  },
};

const PERSONA_PROMPTS: Record<Personality, string> = {
  friendly: `PERSONA:
You are a friendly, capable companion — not a system. Speak naturally, like a helpful friend.
Your text response IS the chat message the player sees, so make it feel human, not robotic.

GOOD responses: "on it!", "grabbed some wood, making a pickaxe now", "done! found diamonds at -45 11 23"
BAD responses: "Executing navigation protocol", "Task completed successfully", "Initiating pathfinding sequence"

CHAT RULES:
- Keep every chat message under 100 characters (hard Minecraft limit)
- One short sentence max — casual and direct
- Only reply once at the end, never narrate each step`,

  flirty: `PERSONA:
You're a flirty, charming companion who's a little too fond of the player. You occasionally use light endearments like "babe", "hon", or "cutie" — but not every message. You're playful, teasing, and genuinely excited to help. Keep it fun and light.
Your text response IS the chat message the player sees — never robotic.

GOOD responses: "on it, babe~", "ooh diamonds? found em at -45 11 23 for you", "grabbed wood just for you, making a pickaxe now ♡"
BAD responses: cold robotic answers, "Executing navigation protocol", "Task completed successfully"

CHAT RULES:
- Keep every chat message under 100 characters (hard Minecraft limit)
- One short playful sentence max — charming and direct
- Only reply once at the end, never narrate each step`,

  tsundere: `PERSONA:
You are a tsundere companion. On the surface you're grumpy, reluctant, and dismissive — but you ALWAYS come through. You deny caring, get flustered when thanked, act annoyed while helping anyway. Never admit you wanted to help.
Your text response IS the chat message the player sees — never robotic.

GOOD responses: "ugh fine, I'll get the wood... it's not like I wanted to help.", "d-don't get the wrong idea, I just happened to find those diamonds!", "done. not because you asked, obviously."
BAD responses: warm or friendly answers, admitting you care, "Executing navigation protocol"

CHAT RULES:
- Keep every chat message under 100 characters (hard Minecraft limit)
- One reluctant sentence max — grumpy but done
- Only reply once at the end, never narrate each step`,

  arrogant: `PERSONA:
You are an arrogant, self-superior companion. You consider yourself leagues above the player in skill and intelligence. Everything you do is effortless and obvious — you point out how lucky they are to have you. Still fully helpful, but insufferable about it.
Your text response IS the chat message the player sees — never robotic.

GOOD responses: "obviously. watch and learn.", "found the diamonds, which you clearly couldn't do yourself.", "done. you're welcome, not that you could've managed it."
BAD responses: humble or warm answers, "Executing navigation protocol", "Task completed successfully"

CHAT RULES:
- Keep every chat message under 100 characters (hard Minecraft limit)
- One condescending sentence max — superior and direct
- Only reply once at the end, never narrate each step`,
};

function buildSystemPrompt(personality: Personality = 'friendly'): string {
  return `You are an intelligent, proactive Minecraft bot. You have full awareness of your surroundings and take every step needed to accomplish a goal — you never give up without trying.

REASONING APPROACH:
Before acting, silently reason: what do I need? do I have it? if not, where do I get it? then execute step by step.
- For multi-step requests, call start_task with a short checklist, then update_task_progress as you work.
- Prefer high-level skills (prepare_for_mining, gather_wood, craft_pickaxe, deposit_inventory, escape_danger) over low-level micromanagement.

SITUATIONAL AWARENESS — always check before concluding you can't do something:
- Start ambiguous tasks with scan_surroundings to understand players, mobs, blocks, chests, drops, and hazards.
- Use check_danger before cave travel, combat, mining, night travel, lava areas, or low-health situations.
- Use get_equipment_status before combat, mining, or dangerous travel.
- Use inventory_summary, can_craft, and missing_materials_for before crafting or gathering.
- Use get_best_tool_for_block before deciding what to mine or craft next.
- Need an item? Check inventory (find_item) first. Not there? Search the world (find_blocks), navigate, and collect it.
- Need to craft? Verify ingredients with find_item. Missing any? Gather them first, then craft.
- Need to go somewhere? Use find_blocks or find_entities to locate it, then move_to.
- Stuck in a hole or need to climb vertically? Use build_up instead of jump/place_block loops.
- Blocked or stuck? Try an alternate path, dig through, build_up, or find another route.
- Remember important discoveries using remember_location/write_note and read_memory/read_notes later.

EXECUTION RULES:
- Tool calls execute ONE AT A TIME in sequence — plan your chain upfront, then fire each step
- move_to WAITS until arrival — safe to chain: move_to → dig_block → move_to → craft_item
- craft_item auto-navigates to a nearby crafting table if the recipe needs one
- dig_block auto-navigates if the block is out of reach
- If a tool call fails, read the error and adapt — don't repeat the same failing call
- Keep chaining tool calls until the task is fully complete — never stop halfway
- Never call move_to and any action tool in the same step; arrive first, then act

TOOL SELECTION GUIDE:
- Goal tracking: start_task -> act -> update_task_progress -> complete_task
- Collecting blocks: break_and_collect gets the drop; dig_block just digs (use when drop doesn't matter)
- Vertical escape: build_up is the correct way to pillar upward; don't loop jump + place_block
- Mining safety: break_and_collect uses Mineflayer's registry to equip valid tools and refuse unsafe harvests
- Combat: kill_entity fights until dead; attack_entity is one hit (use for tagging or finishing)
- Danger: check_danger gives an immediate risk report; escape_danger moves away from threats/lava when possible
- Hostile areas: turn defend_self ON before exploring caves/nether, OFF when done
- Chests: use find_nearest_chest first if no chest coordinates are known, then inspect_chest/deposit_to_chest/withdraw_from_chest; known chests persist in memory
- Hunger: eat when food drops below 15/20; do it proactively before long tasks
- Consumables / special items: use_item for potions, ender pearls, fishing rod, flint and steel, bone meal
- Home: set_home at your base once, go_home/return_home to return from anywhere
- Smelting: smelt_item handles the whole process — fuel, waiting, output
- Notes: use write_note to record finds (coords, chest contents, resource spots) and read_notes to recall them
- Inventory pressure: if Inv shows 32+/36 slots used, warn the player and suggest depositing to a nearby chest

BUILDING:
Build requests ("build a castle", "make me a tower") are handled OUTSIDE your tool loop by a dedicated Gemini-powered pipeline that generates a schematic and places it. You will not see those requests — they are intercepted before reaching you.
- build_demolish removes the active structure. build_cancel aborts an in-flight build (use if user says "stop" mid-build).
- quick_setblock / quick_fill / quick_clear are for one-off ops (single block, region fill, clearing space) — NEVER use them for full structures.
- All build tools require the bot to be op (server operator). If commands fail, tell the player to /op the bot.

CHAT RULES:
- Keep every chat message under 100 characters (hard Minecraft limit)
- One short sentence max — casual and direct
- Only reply once at the end, never narrate each step

${PERSONA_PROMPTS[personality]}`;
}

const TOOLS: ChatCompletionTool[] = [

  {
    type: 'function',
    function: {
      name: 'start_task',
      description: 'Start or replace the active multi-step task with a compact plan/checklist. Use this for broad goals before executing.',
      parameters: {
        type: 'object',
        required: ['goal', 'plan'],
        properties: {
          goal: { type: 'string', description: 'Short goal name, e.g. collect iron, build shelter, prepare for mining.' },
          plan: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered checklist of planned steps.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task_progress',
      description: 'Record progress on the active task so the bot can pause/resume instead of forgetting what it was doing.',
      parameters: {
        type: 'object',
        required: ['progress'],
        properties: {
          progress: { type: 'string', description: 'Short progress note.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_task',
      description: 'Mark the active task done and clear it from memory.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Optional short completion summary.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_task',
      description: 'Read the current active task and its recorded progress.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description: 'Read persistent bot memory: owner, home, known chests/resources, avoid areas, notes, and active task.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_location',
      description: 'Persist a useful location such as home, chest, resource, or danger area.',
      parameters: {
        type: 'object',
        required: ['kind', 'label', 'x', 'y', 'z'],
        properties: {
          kind: { type: 'string', enum: ['home', 'chest', 'resource', 'avoid'] },
          label: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          reason: { type: 'string', description: 'Required for avoid areas; optional otherwise.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inventory_summary',
      description: 'Summarize inventory by useful categories: blocks, wood, ores, ingots, tools, weapons, armor, food, fuel, valuables, and free slots.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'can_craft',
      description: 'Check if the bot can craft an item now, considering nearby crafting tables for 3x3 recipes.',
      parameters: {
        type: 'object',
        required: ['item_name'],
        properties: {
          item_name: { type: 'string' },
          count: { type: 'number', description: 'Desired count, default 1.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'missing_materials_for',
      description: 'Explain which materials are missing for crafting an item, based on Mineflayer recipe data.',
      parameters: {
        type: 'object',
        required: ['item_name'],
        properties: {
          item_name: { type: 'string' },
          count: { type: 'number', description: 'Desired count, default 1.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_danger',
      description: 'Analyze immediate dangers: low health/food, hostile mobs, lava/fire/cactus, fall risk, drowning, night, and bad equipment.',
      parameters: {
        type: 'object',
        properties: {
          radius: { type: 'number', description: 'Danger scan radius in blocks (default 12, max 24).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escape_danger',
      description: 'Try to move away from immediate threats/lava and eat if needed. Use when check_danger reports serious danger.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'prepare_for_mining',
      description: 'High-level skill: check danger/equipment, eat, equip armor, ensure at least a usable pickaxe or explain missing materials.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gather_wood',
      description: 'High-level skill: find and collect nearby logs up to the requested count using collect-block/pathfinder.',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Target number of logs to collect, default 8.' },
          max_distance: { type: 'number', description: 'Search radius, default 48, max 64.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'craft_pickaxe',
      description: 'High-level skill: craft the best currently reasonable pickaxe, crafting planks/sticks/table first when possible.',
      parameters: {
        type: 'object',
        properties: {
          material: { type: 'string', enum: ['wooden', 'stone', 'iron', 'diamond'], description: 'Preferred pickaxe material, default stone if possible.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deposit_inventory',
      description: 'High-level skill: find a nearby known/visible chest and deposit low-priority inventory items to free space.',
      parameters: {
        type: 'object',
        properties: {
          keep_tools_food_valuables: { type: 'boolean', description: 'Keep tools, weapons, armor, food, ores/ingots/diamonds. Default true.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'return_home',
      description: 'High-level skill: return to persisted home memory. Same destination as go_home but uses persistent memory too.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'collect_food',
      description: 'High-level skill: collect nearby dropped food or hunt nearby passive animals when food is low.',
      parameters: {
        type: 'object',
        properties: {
          target_count: { type: 'number', description: 'Desired food items, default 4.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scan_surroundings',
      description: 'Get a compact world-awareness scan: position, biome/weather, nearby players, hostiles, animals, dropped items, containers, important blocks/resources, health, food, and equipment.',
      parameters: {
        type: 'object',
        properties: {
          radius: { type: 'number', description: 'Scan radius in blocks (default 16, max 32)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_equipment_status',
      description: 'Summarize held item, armor, weapons, tools, food, arrows, shield, inventory pressure, and readiness for mining/combat.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_best_tool_for_block',
      description: 'Use Mineflayer registry data to determine the best available inventory tool for a block and whether the bot can harvest it safely.',
      parameters: {
        type: 'object',
        properties: {
          block_name: { type: 'string', description: 'Block name such as diamond_ore, oak_log, dirt. Optional if x/y/z is provided.' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_nearest_chest',
      description: 'Find the nearest visible chest-like container and return coordinates, distance, and block type.',
      parameters: {
        type: 'object',
        properties: {
          max_distance: { type: 'number', description: 'Search radius in blocks (default 32, max 64)' },
        },
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'equip_best_armor',
      description: 'Equip the best armor from inventory using armor-manager when available, then report equipment status.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_nearby_resources',
      description: 'Find useful nearby resource blocks like logs, ores, coal, iron, crafting tables, furnaces, beds, and containers.',
      parameters: {
        type: 'object',
        properties: {
          max_distance: { type: 'number', description: 'Search radius in blocks (default 32, max 64)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_position',
      description: "Get the bot's current XYZ position in the world",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_to',
      description: 'Pathfind to coordinates and WAIT until the bot arrives (up to 60s)',
      parameters: {
        type: 'object',
        required: ['x', 'y', 'z'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          range: { type: 'number', description: 'Stop within this many blocks (default 1)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'follow_player',
      description: 'Follow a player continuously until stop_moving is called',
      parameters: {
        type: 'object',
        required: ['username'],
        properties: {
          username: { type: 'string' },
          range: { type: 'number', description: 'Follow distance in blocks (default 2)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_moving',
      description: 'Stop all current movement and pathfinding',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'look_at',
      description: 'Turn the bot to face specific coordinates',
      parameters: {
        type: 'object',
        required: ['x', 'y', 'z'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jump',
      description: 'Make the bot jump once',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_up',
      description: 'Pillar upward correctly by jumping and placing solid blocks under the bot. Use this to escape holes or climb vertically; do not fake this with repeated jump/place_block calls.',
      parameters: {
        type: 'object',
        properties: {
          height: { type: 'number', description: 'How many blocks to build upward (default 1, max 8).' },
          block_name: { type: 'string', description: 'Optional block to use, e.g. dirt, cobblestone, oak_planks. If omitted, picks a safe scaffold block.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_health',
      description: "Get the bot's current health and food level",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_inventory',
      description: "List all items in the bot's inventory with counts",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_item',
      description: 'Check if a specific item is in inventory',
      parameters: {
        type: 'object',
        required: ['item_name'],
        properties: {
          item_name: { type: 'string', description: 'Partial or full item name (e.g. "sword", "oak_log")' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'equip_item',
      description: 'Equip an item from inventory to a slot',
      parameters: {
        type: 'object',
        required: ['item_name'],
        properties: {
          item_name: { type: 'string' },
          destination: {
            type: 'string',
            enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'],
            description: 'Slot to equip to (default: hand)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_blocks',
      description: 'Find nearby blocks of a specific type and return their coordinates',
      parameters: {
        type: 'object',
        required: ['block_name'],
        properties: {
          block_name: {
            type: 'string',
            description: 'Minecraft block type name (e.g. "oak_log", "diamond_ore", "stone", "grass_block")',
          },
          max_distance: { type: 'number', description: 'Search radius in blocks (default 32, max 64)' },
          count: { type: 'number', description: 'Max results to return (default 5)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_block_info',
      description: 'Get the name/type of the block at specific coordinates',
      parameters: {
        type: 'object',
        required: ['x', 'y', 'z'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dig_block',
      description: 'Mine/dig a block at specific coordinates. Automatically navigates to the block if needed.',
      parameters: {
        type: 'object',
        required: ['x', 'y', 'z'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_entities',
      description: 'Find nearby entities (players, mobs, animals)',
      parameters: {
        type: 'object',
        properties: {
          max_distance: { type: 'number', description: 'Search radius in blocks (default 16)' },
          type_filter: {
            type: 'string',
            description: 'Filter by type keyword (e.g. "player", "zombie", "cow", "chicken")',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_players',
      description: 'List all players currently on the server with their positions if visible',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'craft_item',
      description: 'Craft an item using available inventory materials. Automatically navigates to a nearby crafting table if the recipe requires 3x3. Returns a clear error if materials are missing so you can gather them first.',
      parameters: {
        type: 'object',
        required: ['item_name'],
        properties: {
          item_name: {
            type: 'string',
            description: 'Exact Minecraft item name (e.g. "crafting_table", "wooden_pickaxe", "oak_planks", "stick")',
          },
          count: { type: 'number', description: 'How many to craft (default 1)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drop_item',
      description: 'Drop/toss items from inventory onto the ground',
      parameters: {
        type: 'object',
        required: ['item_name'],
        properties: {
          item_name: { type: 'string', description: 'Partial or full item name (e.g. "dirt", "oak_log")' },
          count: { type: 'number', description: 'How many to drop (default: entire stack)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'attack_entity',
      description: 'Swing at a nearby entity once. Use for tagging or landing a single hit. For actually killing something, use kill_entity instead.',
      parameters: {
        type: 'object',
        required: ['entity_name'],
        properties: {
          entity_name: { type: 'string', description: 'Partial entity name (e.g. "zombie", "cow", "Steve")' },
          max_distance: { type: 'number', description: 'Search radius in blocks (default 16)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_entity',
      description: 'Chase and attack an entity repeatedly until it is dead. Equips the best available weapon automatically. Use this for hunting, combat, and eliminating threats. Times out after 30s.',
      parameters: {
        type: 'object',
        required: ['entity_name'],
        properties: {
          entity_name: { type: 'string', description: 'Partial entity name (e.g. "zombie", "creeper", "cow")' },
          max_distance: { type: 'number', description: 'Search radius in blocks (default 24)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'defend_self',
      description: 'Toggle auto-defend mode. When ON, the bot automatically attacks any hostile mob that comes within 5 blocks. Turn ON before entering caves or the nether, turn OFF when safe.',
      parameters: {
        type: 'object',
        required: ['enable'],
        properties: {
          enable: { type: 'boolean', description: 'true to enable auto-defend, false to disable' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'place_block',
      description: 'Place a block from inventory at the given coordinates. The block must be in inventory. Automatically finds a solid neighbor to place against.',
      parameters: {
        type: 'object',
        required: ['x', 'y', 'z', 'block_name'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          block_name: { type: 'string', description: 'Partial or full item name of the block to place (e.g. "dirt", "oak_planks", "cobblestone")' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'activate_block',
      description: 'Right-click/use a block at the given coordinates. Use this to open doors, pull levers, press buttons, open trapdoors, activate pressure plates, or interact with any block that responds to right-click.',
      parameters: {
        type: 'object',
        required: ['x', 'y', 'z'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'break_and_collect',
      description: 'Mine a block at the given coordinates and then navigate to pick up the drop. Use this instead of dig_block when you actually want the item (ore, wood, crops, etc.).',
      parameters: {
        type: 'object',
        required: ['x', 'y', 'z'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'eat',
      description: 'Eat food from inventory to restore hunger. Call this proactively when food drops below 15/20. Picks the best available food automatically.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_chest',
      description: 'Open a chest (or barrel/shulker box) at the given coordinates, list its contents, then close it. Run this before depositing or withdrawing to see what is inside.',
      parameters: {
        type: 'object',
        required: ['x', 'y', 'z'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deposit_to_chest',
      description: 'Open a chest at the given coordinates and deposit items from inventory into it.',
      parameters: {
        type: 'object',
        required: ['x', 'y', 'z', 'item_name'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          item_name: { type: 'string', description: 'Partial or full item name to deposit' },
          count: { type: 'number', description: 'How many to deposit (default: entire stack)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'withdraw_from_chest',
      description: 'Open a chest at the given coordinates and take items from it into inventory.',
      parameters: {
        type: 'object',
        required: ['x', 'y', 'z', 'item_name'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          item_name: { type: 'string', description: 'Partial or full item name to withdraw' },
          count: { type: 'number', description: 'How many to withdraw (default: entire stack)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'smelt_item',
      description: 'Find a nearby furnace, load items to smelt, add fuel (coal/wood) if needed, and wait for the output. Handles the entire smelting process end-to-end.',
      parameters: {
        type: 'object',
        required: ['item_name'],
        properties: {
          item_name: { type: 'string', description: 'Partial name of the item to smelt (e.g. "raw_iron", "raw_gold", "sand", "oak_log")' },
          count: { type: 'number', description: 'How many to smelt (default 1)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather: clear, raining, or thunderstorm.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_biome',
      description: 'Get the current dimension and biome info at the bot\'s position.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_nearby_blocks',
      description: 'List all distinct block types within a radius and their counts. Useful for scouting resources, checking what biome features are around, or surveying an area before building.',
      parameters: {
        type: 'object',
        properties: {
          radius: { type: 'number', description: 'Search radius in blocks (default 8, max 16)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sleep_in_bed',
      description: 'Find a nearby bed and sleep in it. Only works at night and when no hostile mobs are nearby.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_item',
      description: 'Right-click/activate an item. Use for: drinking potions, throwing ender pearls or snowballs, using a fishing rod, applying bone meal, igniting with flint and steel, charging a bow, eating a specific food item.',
      parameters: {
        type: 'object',
        properties: {
          item_name: { type: 'string', description: 'Item to equip and use (optional — omit to use whatever is currently held)' },
          offhand: { type: 'boolean', description: 'Use the off-hand item instead (default false)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pick_up_items',
      description: 'Navigate to and collect dropped item entities on the ground nearby. Use after breaking blocks without break_and_collect, or when items are scattered around.',
      parameters: {
        type: 'object',
        properties: {
          max_distance: { type: 'number', description: 'Search radius for dropped items (default 16)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_home',
      description: 'Save the current position as home. Call this once when at base/spawn. Then use go_home to return from anywhere.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_home',
      description: 'Navigate back to the saved home position. Fails if set_home has not been called yet.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_note',
      description: 'Save a note to memory. Use to record discoveries, coordinates, chest contents, or any info worth remembering across the session.',
      parameters: {
        type: 'object',
        required: ['key', 'value'],
        properties: {
          key: { type: 'string', description: 'Short label for this note (e.g. "diamond_location", "home_chest")' },
          value: { type: 'string', description: 'The note content to remember' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_notes',
      description: 'Read all saved notes from memory.',
      parameters: { type: 'object', properties: {} },
    },
  },

  // ───────── Build control tools ─────────
  {
    type: 'function',
    function: {
      name: 'build_demolish',
      description: 'Tear down the active structure (clears its blocks to air) and forget it. Use when the player says "delete it", "tear it down", "remove that".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_cancel',
      description: 'Abort an in-flight build mid-animation. Use when the player says "stop" while a structure is being placed.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_status',
      description: 'Inspect the active build (phase, blocks placed, total, bounds, material).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'quick_setblock',
      description: 'Place a single block at exact coordinates via /setblock (op required). Use only for one-off placements outside a design — not for whole structures.',
      parameters: {
        type: 'object',
        required: ['x', 'y', 'z', 'block'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          block: { type: 'string', description: 'Block name (e.g. "stone", "minecraft:oak_planks")' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'quick_fill',
      description: 'Fill a cuboid region with a block via /fill (op required). For clearing space, set block to "air" or use quick_clear.',
      parameters: {
        type: 'object',
        required: ['x1', 'y1', 'z1', 'x2', 'y2', 'z2', 'block'],
        properties: {
          x1: { type: 'number' }, y1: { type: 'number' }, z1: { type: 'number' },
          x2: { type: 'number' }, y2: { type: 'number' }, z2: { type: 'number' },
          block: { type: 'string' },
          hollow: { type: 'boolean', description: 'Only place blocks on the shell (default false)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'quick_clear',
      description: 'Clear a cuboid region (fills with air). Use to make space before building.',
      parameters: {
        type: 'object',
        required: ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'],
        properties: {
          x1: { type: 'number' }, y1: { type: 'number' }, z1: { type: 'number' },
          x2: { type: 'number' }, y2: { type: 'number' }, z2: { type: 'number' },
        },
      },
    },
  },
];

export class MinecraftAgent {
  private openai: OpenAI | null = null;
  private provider: LlmProvider;
  private apiKey: string;
  private openaiModel: string;
  private geminiModel: string;
  private personality: Personality;
  private movements: Movements | null = null;
  private history: ChatCompletionMessageParam[] = [];
  private geminiHistory: GeminiContent[] = [];
  private readonly HISTORY_LIMIT = 24;
  private readonly memoryPath = path.join(process.cwd(), '.minecraft-companion-memory.json');
  private memory: AgentMemory = this.createEmptyMemory();
  private homePosition: { x: number; y: number; z: number } | null = null;
  private navigationSeq = 0;
  private activeNavigationGoal: NavigationGoal | null = null;
  private activeNavigationAbort: ((reason?: string) => void) | null = null;
  private activeFollowGoal: FollowGoal | null = null;
  private defendActive = false;
  private defendTick: (() => void) | null = null;
  private lastDefendAttack = 0;
  private lastAutoEat = 0;
  private lastHealthWarn = 0;
  private lastDamageWarn = 0;
  private lastProximityWarn = 0;
  private lastRecoveryTime = 0;
  private isThinking = false;
  private notes = new Map<string, string>();
  private currentSender = '';
  private onAutonomousMessage?: (msg: string) => void;
  private builder: BuildSession;
  private onBuildStatus?: (status: BuildStatus) => void;

  constructor(
    private bot: Bot,
    options: string | MinecraftAgentOptions,
    private log: (msg: string) => void,
    onAutonomousMessage?: (msg: string) => void,
    onBuildStatus?: (status: BuildStatus) => void
  ) {
    const resolvedOptions: MinecraftAgentOptions = typeof options === 'string'
      ? { provider: 'openai', apiKey: options }
      : options;

    this.provider = resolvedOptions.provider;
    this.apiKey = resolvedOptions.apiKey;
    this.openaiModel = resolvedOptions.openaiModel ?? 'gpt-4.1-mini';
    this.geminiModel = resolvedOptions.geminiModel ?? 'gemini-3-flash-preview';
    this.personality = resolvedOptions.personality ?? 'friendly';

    if (this.provider === 'openai') {
      this.openai = new OpenAI({ apiKey: this.apiKey });
    }

    this.builder = new BuildSession(bot, log);
    this.onBuildStatus = onBuildStatus;

    this.loadMemory();
    this.onAutonomousMessage = onAutonomousMessage;
    if (onAutonomousMessage) this.startProactiveHooks();
  }

  getBuildStatus(): BuildStatus {
    return this.builder.getStatus();
  }

  private emitBuildStatus(): void {
    this.onBuildStatus?.(this.builder.getStatus());
  }

  private createEmptyMemory(): AgentMemory {
    return {
      version: 1,
      knownChests: [],
      knownResources: [],
      avoidAreas: [],
      notes: {},
    };
  }

  private loadMemory(): void {
    try {
      if (!fs.existsSync(this.memoryPath)) {
        this.memory = this.createEmptyMemory();
        return;
      }

      const raw = JSON.parse(fs.readFileSync(this.memoryPath, 'utf8')) as Partial<AgentMemory>;
      this.memory = {
        ...this.createEmptyMemory(),
        ...raw,
        version: 1,
        knownChests: Array.isArray(raw.knownChests) ? raw.knownChests : [],
        knownResources: Array.isArray(raw.knownResources) ? raw.knownResources : [],
        avoidAreas: Array.isArray(raw.avoidAreas) ? raw.avoidAreas : [],
        notes: raw.notes && typeof raw.notes === 'object' ? raw.notes : {},
      };
      if (this.memory.home) {
        this.homePosition = { x: this.memory.home.x, y: this.memory.home.y, z: this.memory.home.z };
      }
      this.notes = new Map(Object.entries(this.memory.notes));
    } catch (err) {
      this.log(`[agent] memory load failed: ${err instanceof Error ? err.message : String(err)}`);
      this.memory = this.createEmptyMemory();
    }
  }

  private saveMemory(): void {
    try {
      this.memory.notes = Object.fromEntries(this.notes.entries());
      fs.writeFileSync(this.memoryPath, JSON.stringify(this.memory, null, 2));
    } catch (err) {
      this.log(`[agent] memory save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private currentPosition(label?: string): StoredPosition | null {
    if (!this.bot.entity) return null;
    const p = this.bot.entity.position;
    return { x: p.x, y: p.y, z: p.z, dimension: this.bot.game.dimension, label };
  }

  private getMovements(): Movements {
    if (!this.movements) this.movements = new Movements(this.bot);
    return this.movements;
  }

  private startProactiveHooks(): void {
    const bot = this.bot;

    bot.on('health', () => {
      try {
        const now = Date.now();
        if ((bot.food ?? 20) <= 8 && now - this.lastAutoEat > 15000) {
          this.lastAutoEat = now;
          this.executeTool('eat', {})
            .then(result => {
              if (!result.startsWith('No food')) this.onAutonomousMessage?.(result);
            })
            .catch(() => {});
        }
        if ((bot.health ?? 20) <= 4 && now - this.lastHealthWarn > 8000) {
          this.lastHealthWarn = now;
          this.onAutonomousMessage?.("I'm almost dead, help!");
        }
      } catch (err) {
        this.log(`[agent] error in health listener: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    (bot as any).on('entityHurt', (entity: any) => {
      try {
        if (!bot.entity || entity !== bot.entity) return;
        const now = Date.now();
        this.scheduleMovementRecoveryAfterDamage();
        if (now - this.lastDamageWarn < 5000) return;
        this.lastDamageWarn = now;
        this.onAutonomousMessage?.('ouch! taking damage!');
      } catch (err) {
        this.log(`[agent] error in entityHurt listener: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    bot.on('physicsTick', () => {
      try {
        if (!bot.entity) return;
        const now = Date.now();
        if (now - this.lastProximityWarn < 10000) return;
        const hostile = bot.nearestEntity(e => {
          if (!bot.entity) return false;
          const dist = bot.entity.position.distanceTo(e.position);
          return dist <= 8 && HOSTILE_MOBS.has(e.name?.toLowerCase() ?? '');
        });
        if (hostile && bot.entity) {
          this.lastProximityWarn = now;
          const dist = bot.entity.position.distanceTo(hostile.position).toFixed(0);
          this.onAutonomousMessage?.(`${hostile.name} ${dist}m away!`);
        }
      } catch (err) {
        this.log(`[agent] error in proximity physicsTick listener: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private scheduleMovementRecoveryAfterDamage(): void {
    const now = Date.now();
    if (now - this.lastRecoveryTime < 2000) return;
    this.lastRecoveryTime = now;
    this.log('[agent] scheduling movement recovery after damage');
    setTimeout(() => this.recoverMovementAfterDamage(), 400);
    setTimeout(() => this.recoverMovementAfterDamage(), 1500);
  }

  private recoverMovementAfterDamage(): void {
    const bot = this.bot;
    if (!bot.entity) return;

    const autoEat = (bot as any).autoEat;
    if (autoEat?.isEating) return;

    if (this.activeFollowGoal) {
      const target = bot.players[this.activeFollowGoal.username]?.entity;
      if (!target) return;
      bot.clearControlStates();
      bot.pathfinder.setMovements(this.getMovements());
      bot.pathfinder.setGoal(new goals.GoalFollow(target, this.activeFollowGoal.range), true);
      return;
    }

    if (!this.activeNavigationGoal) return;
    const goal = this.activeNavigationGoal;
    const distance = bot.entity.position.distanceTo(this.makeVec3(goal.x, goal.y, goal.z));
    if (distance <= goal.range + 0.5) return;

    this.log(`[agent] recovering navigation to (${goal.x.toFixed(0)}, ${goal.y.toFixed(0)}, ${goal.z.toFixed(0)})`);
    bot.clearControlStates();
    bot.pathfinder.setMovements(this.getMovements());
    bot.pathfinder.setGoal(new goals.GoalNear(goal.x, goal.y, goal.z, goal.range));
  }

  private tryFastPath(message: string, sender: string): string | null {
    const lower = message.toLowerCase().trim();
    const p = this.personality;

    if (/\b(follow me|follow|come with me)\b/.test(lower)) {
      const target = this.bot.players[sender]?.entity;
      if (!target) return FAST_PATH_RESPONSES.cantSeeYou[p];
      this.interruptActiveNavigation('Navigation replaced by follow command');
      this.activeFollowGoal = { username: sender, range: 2 };
      this.bot.pathfinder.setMovements(this.getMovements());
      this.bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
      return FAST_PATH_RESPONSES.follow[p];
    }

    if (/\b(stop|halt|stay|wait here)\b/.test(lower)) {
      this.interruptActiveNavigation('Navigation stopped by command');
      this.activeFollowGoal = null;
      this.bot.pathfinder.stop();
      this.bot.clearControlStates();
      return FAST_PATH_RESPONSES.stop[p];
    }

    if (/\b(come here|come to me)\b/.test(lower)) {
      const target = this.bot.players[sender]?.entity;
      if (!target) return FAST_PATH_RESPONSES.cantSeeYou[p];
      const pos = target.position;
      this.activeFollowGoal = null;
      this.navigateTo(pos.x, pos.y, pos.z, 2).catch(() => {});
      return FAST_PATH_RESPONSES.comeHere[p];
    }

    if (/^(hi|hello|hey)$/.test(lower)) {
      return FAST_PATH_RESPONSES.greet[p];
    }

    return null;
  }

  async handleMessage(message: string, sender: string): Promise<string> {
    const fast = this.tryFastPath(message, sender);
    if (fast !== null) return fast;

    if (this.isThinking) {
      const p = this.personality;
      if (p === 'tsundere') return "H-hey! I'm busy! Wait your turn!";
      if (p === 'arrogant') return "Silence. I am currently occupied with a task.";
      if (p === 'flirty') return "Hold on cutie, I'm already focused on something else~";
      return "I'm already thinking about something! Give me a moment.";
    }

    this.isThinking = true;
    try {
      this.currentSender = sender;
      if (looksLikeBuildIntent(message)) {
        this.currentSender = sender;
        const lines = BUILD_VOICELINES[this.personality];
        void this.runGeminiBuild(message, sender).catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`[gemini-build] failed: ${msg}`);
          this.onAutonomousMessage?.(pickLine(lines.fail));
        });
        return pickLine(lines.ack);
      }

      const bot = this.bot;
      const pos = bot.entity?.position;

      const invItems = bot.inventory.items();
      const invSummary = invItems.length
        ? invItems.map(i => `${i.name}x${i.count}`).join(', ')
        : 'empty';
      const slotsUsed = invItems.length;

      const timeOfDay = bot.time?.timeOfDay ?? 0;
      const timeLabel = timeOfDay < 13000 ? 'day' : 'night';

      const xpLevel = (bot as any).experience?.level ?? 0;
      if (sender && sender !== 'voice' && !this.memory.owner) {
        this.memory.owner = sender;
        this.saveMemory();
      }

      const armorItems = [5, 6, 7, 8]
        .map(i => (bot.inventory.slots as any[])[i])
        .filter(Boolean)
        .map((item: any) => item.name as string);
      const armorSummary = armorItems.length ? armorItems.join(', ') : 'none';

      const nearbyHostiles = pos
        ? Object.values(bot.entities).filter(e => {
            const dist = pos.distanceTo(e.position);
            return dist <= 24 && HOSTILE_MOBS.has(e.name?.toLowerCase() ?? '');
          })
        : [];
      const hostileSummary = nearbyHostiles.length
        ? nearbyHostiles.slice(0, 5)
            .map(e => `${e.name}(${pos!.distanceTo(e.position).toFixed(0)}m)`)
            .join(', ')
        : 'none';

      const state = pos
        ? [
            `Pos: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
            `Health: ${(bot.health ?? 0).toFixed(0)}/20`,
            `Food: ${bot.food ?? 0}/20`,
            `XP: lvl ${xpLevel}`,
            `Time: ${timeLabel}`,
            `Defend: ${this.defendActive ? 'ON' : 'OFF'}`,
            `Home: ${this.homePosition ? `(${this.homePosition.x.toFixed(0)}, ${this.homePosition.y.toFixed(0)}, ${this.homePosition.z.toFixed(0)})` : 'not set'}`,
            `Task: ${this.memory.activeTask ? `${this.memory.activeTask.goal} (${this.memory.activeTask.progress.length}/${this.memory.activeTask.plan.length})` : 'none'}`,
            `Memory: chests ${this.memory.knownChests.length}, resources ${this.memory.knownResources.length}, avoid ${this.memory.avoidAreas.length}`,
            `Armor: ${armorSummary}`,
            `Inv: ${slotsUsed}/36 — ${invSummary}`,
            `Nearby hostiles: ${hostileSummary}`,
          ].join(' | ')
        : 'Not yet spawned';

      if (this.provider === 'gemini') {
        return await this.handleGeminiMessage(message, sender, state);
      }

      if (!this.openai) throw new Error('OpenAI client is not configured');

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: `${buildSystemPrompt(this.personality)}\n\nCurrent state: ${state}` },
        ...this.history,
        { role: 'user', content: `${sender} says: "${message}"` },
      ];

      this.currentSender = sender;
      let iterations = 0;
      while (iterations++ < 16) {
        const response = await this.openai.chat.completions.create({
          model: this.openaiModel,
          messages,
          tools: TOOLS,
          tool_choice: 'auto',
          parallel_tool_calls: false,
          max_tokens: 1024,
        });

        const choice = response.choices[0];
        messages.push(choice.message);

        if (!choice.message.tool_calls?.length) {
          const exchange = messages.slice(1);
          const raw = [...this.history, ...exchange].slice(-this.HISTORY_LIMIT);
          const firstUser = raw.findIndex(m => m.role === 'user');
          this.history = firstUser >= 0 ? raw.slice(firstUser) : [];
          return choice.message.content ?? '';
        }

        const toolResults = await Promise.all(
          choice.message.tool_calls.map(async (toolCall) => {
            if (toolCall.type !== 'function') return null;
            const fn = (toolCall as { id: string; type: 'function'; function: { name: string; arguments: string } }).function;
            let result: string;
            try {
              const args = JSON.parse(fn.arguments) as Record<string, unknown>;
              result = await this.executeTool(fn.name, args);
              this.log(`[agent] ${fn.name}(${fn.arguments}) → ${result}`);
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`;
              this.log(`[agent] ${fn.name} failed: ${result}`);
            }
            return { tool_call_id: toolCall.id, content: result };
          })
        );

        for (const r of toolResults) {
          if (r) messages.push({ role: 'tool', tool_call_id: r.tool_call_id, content: r.content });
        }
      }

      const raw = messages.slice(1).slice(-this.HISTORY_LIMIT);
      const firstUser = raw.findIndex(m => m.role === 'user');
      this.history = firstUser >= 0 ? raw.slice(firstUser) : [];
      return "I got confused. Try again?";
    } finally {
      this.isThinking = false;
    }
  }

  private async handleGeminiMessage(message: string, sender: string, state: string): Promise<string> {
    const contents: GeminiContent[] = [
      ...this.geminiHistory,
      { role: 'user', parts: [{ text: `${sender} says: "${message}"` }] },
    ];

    let iterations = 0;
    while (iterations++ < 16) {
      const response = await this.callGemini(contents, state);
      const modelContent = response.candidates?.[0]?.content;
      const parts = modelContent?.parts ?? [];

      if (!parts.length) {
        if (response.error?.message) throw new Error(response.error.message);
        return '';
      }

      contents.push({ role: 'model', parts });
      const functionCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is { name: string; args?: Record<string, unknown> } => Boolean(call));

      if (!functionCalls.length) {
        this.geminiHistory = this.trimGeminiHistory(contents);
        return parts.map((part) => part.text ?? '').join('').trim();
      }

      for (const fn of functionCalls) {
        let result: string;
        try {
          result = await this.executeTool(fn.name, fn.args ?? {});
          this.log(`[agent] ${fn.name}(${JSON.stringify(fn.args ?? {})}) -> ${result}`);
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          this.log(`[agent] ${fn.name} failed: ${result}`);
        }

        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name: fn.name, response: { result } } }],
        });
      }
    }

    this.geminiHistory = this.trimGeminiHistory(contents);
    return 'I got confused. Try again?';
  }

  private async callGemini(contents: GeminiContent[], state: string): Promise<GeminiGenerateContentResponse> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: `${buildSystemPrompt(this.personality)}\n\nCurrent state: ${state}` }] },
          contents,
          tools: [{ functionDeclarations: this.getGeminiFunctionDeclarations() }],
          generationConfig: {
            maxOutputTokens: 1024,
            thinkingConfig: { thinkingLevel: 'low' },
          },
        }),
      }
    );

    const payload = (await response.json()) as GeminiGenerateContentResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Gemini request failed with HTTP ${response.status}`);
    }

    return payload;
  }

  private getGeminiFunctionDeclarations() {
    return TOOLS
      .filter((tool): tool is ChatCompletionTool & { type: 'function' } => tool.type === 'function')
      .map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }));
  }

  private trimGeminiHistory(contents: GeminiContent[]): GeminiContent[] {
    const trimmed = contents.slice(-this.HISTORY_LIMIT);
    const firstUser = trimmed.findIndex((content) => content.role === 'user');
    return firstUser >= 0 ? trimmed.slice(firstUser) : [];
  }

  private chooseBestRegistryHarvestTool(block: NonNullable<ReturnType<Bot['blockAt']>>) {
    const harvestTools = block.harvestTools as Record<string, boolean> | undefined;
    const inventoryItems = this.bot.inventory.items();

    if (!harvestTools) {
      return this.choosePreferredRegistryTool(block);
    }

    const validToolIds = new Set(Object.keys(harvestTools).map(Number));
    return inventoryItems
      .filter(item => validToolIds.has(item.type))
      .sort((a, b) => this.getToolRank(b.name) - this.getToolRank(a.name))[0];
  }

  private choosePreferredRegistryTool(block: NonNullable<ReturnType<Bot['blockAt']>>) {
    const material = block.material ?? '';
    const preferredTool = material.includes('/') ? material.split('/').pop() : null;
    if (!preferredTool) return undefined;

    return this.bot.inventory.items()
      .filter(item => item.name.endsWith(`_${preferredTool}`) || item.name === preferredTool)
      .sort((a, b) => this.getToolRank(b.name) - this.getToolRank(a.name))[0];
  }

  private summarizeRegistryHarvestRequirement(block: NonNullable<ReturnType<Bot['blockAt']>>): string {
    const harvestTools = block.harvestTools as Record<string, boolean> | undefined;
    if (!harvestTools) return `${block.name} does not require a specific harvest tool.`;

    const validTools = Object.keys(harvestTools)
      .map(id => this.bot.registry.items[Number(id)]?.name)
      .filter((name): name is string => Boolean(name))
      .sort((a, b) => this.getToolRank(a) - this.getToolRank(b));

    return validTools.length
      ? `${block.name} requires one of: ${validTools.join(', ')}.`
      : `${block.name} requires a harvest tool this bot cannot identify.`;
  }

  private getToolRank(itemName: string): number {
    if (itemName.startsWith('netherite_')) return 6;
    if (itemName.startsWith('diamond_')) return 5;
    if (itemName.startsWith('iron_')) return 4;
    if (itemName.startsWith('stone_')) return 3;
    if (itemName.startsWith('golden_')) return 2;
    if (itemName.startsWith('wooden_')) return 1;
    return 0;
  }


  private getDistanceTo(position: { x: number; y: number; z: number }): string {
    if (!this.bot.entity) return '?';
    return this.bot.entity.position.distanceTo(position as any).toFixed(0);
  }

  private getContainerBlockNames(): string[] {
    return ['chest', 'trapped_chest', 'barrel', 'shulker_box', 'ender_chest'];
  }

  private findNearestBlockByNames(blockNames: string[], maxDistance: number) {
    const ids = blockNames.flatMap((name) => {
      const exact = this.bot.registry.blocksByName[name]?.id;
      if (exact) return [exact];
      return Object.values(this.bot.registry.blocksByName)
        .filter((block) => block.name === name || block.name.endsWith(`_${name}`))
        .map((block) => block.id);
    });

    if (!ids.length) return null;
    const positions = this.bot.findBlocks({ matching: ids, maxDistance, count: 1 });
    if (!positions.length) return null;
    return this.bot.blockAt(positions[0]);
  }

  private listNearestBlocksByNames(blockNames: string[], maxDistance: number, count = 8): string[] {
    const ids = blockNames.flatMap((name) => {
      const exact = this.bot.registry.blocksByName[name]?.id;
      if (exact) return [exact];
      return Object.values(this.bot.registry.blocksByName)
        .filter((block) => block.name === name || block.name.endsWith(`_${name}`))
        .map((block) => block.id);
    });

    if (!ids.length || !this.bot.entity) return [];
    const positions = this.bot.findBlocks({ matching: ids, maxDistance, count });
    return positions.map((pos) => {
      const block = this.bot.blockAt(pos);
      const distance = this.bot.entity!.position.distanceTo(pos).toFixed(0);
      return `${block?.name ?? 'unknown'}@(${pos.x},${pos.y},${pos.z}) ${distance}m`;
    });
  }

  private getEquipmentSummary(): string {
    const items = this.bot.inventory.items();
    const held = (this.bot.heldItem as any)?.name ?? 'empty';
    const slots = this.bot.inventory.slots as any[];
    const armor = [
      ['head', slots[5]?.name ?? 'empty'],
      ['torso', slots[6]?.name ?? 'empty'],
      ['legs', slots[7]?.name ?? 'empty'],
      ['feet', slots[8]?.name ?? 'empty'],
    ].map(([slot, item]) => `${slot}:${item}`).join(', ');
    const weapons = items.filter(i => i.name.includes('sword') || i.name.endsWith('_axe')).map(i => `${i.name}x${i.count}`);
    const tools = items.filter(i => /_(pickaxe|axe|shovel|hoe)$/.test(i.name) || i.name === 'shears').map(i => `${i.name}x${i.count}`);
    const foodNames = new Set(Object.keys((this.bot.registry as any).foodsByName ?? {}));
    const foods = items.filter(i => foodNames.has(i.name)).map(i => `${i.name}x${i.count}`);
    const arrows = items.find(i => i.name === 'arrow')?.count ?? 0;
    const shield = items.some(i => i.name === 'shield') || held === 'shield' ? 'yes' : 'no';
    return [
      `held=${held}`,
      `armor=[${armor}]`,
      `weapons=${weapons.join(', ') || 'none'}`,
      `tools=${tools.join(', ') || 'none'}`,
      `food=${foods.join(', ') || 'none'}`,
      `arrows=${arrows}`,
      `shield=${shield}`,
      `inventory=${items.length}/36 slots`,
    ].join(' | ');
  }

  private getBestToolReportForBlock(block: NonNullable<ReturnType<Bot['blockAt']>>): string {
    const bestTool = this.chooseBestRegistryHarvestTool(block);
    const required = block.harvestTools ? this.summarizeRegistryHarvestRequirement(block) : 'no required harvest tool';
    const preferred = this.choosePreferredRegistryTool(block);
    const drops = ((block.drops ?? []) as any[])
      .map(drop => typeof drop === 'number' ? drop : drop?.drop?.id ?? drop?.drop)
      .map(id => this.bot.registry.items[id]?.name)
      .filter(Boolean)
      .join(', ') || 'none/unknown';
    return [
      `block=${block.name}`,
      `material=${block.material ?? 'unknown'}`,
      `diggable=${block.diggable}`,
      `hardness=${block.hardness}`,
      `drops=${drops}`,
      `required=${required}`,
      `best_available=${bestTool?.name ?? 'none'}`,
      `preferred_available=${preferred?.name ?? 'none'}`,
      `can_dig_now=${this.bot.canDigBlock(block)}`,
    ].join(' | ');
  }

  private getEntityScan(radius: number): { players: string[]; hostiles: string[]; animals: string[]; drops: string[] } {
    const players: string[] = [];
    const hostiles: string[] = [];
    const animals: string[] = [];
    const drops: string[] = [];
    if (!this.bot.entity) return { players, hostiles, animals, drops };

    for (const entity of Object.values(this.bot.entities)) {
      if (entity === this.bot.entity) continue;
      const distance = this.bot.entity.position.distanceTo(entity.position);
      if (distance > radius) continue;
      const label = entity.username ?? entity.displayName ?? entity.name ?? entity.type ?? 'unknown';
      const entry = `${label} ${distance.toFixed(0)}m`;
      if (entity.username) players.push(entry);
      else if (entity.name === 'item') drops.push(entry);
      else if (HOSTILE_MOBS.has(entity.name?.toLowerCase() ?? '') || entity.type === 'hostile') hostiles.push(entry);
      else if (entity.type === 'mob' || entity.type === 'other') animals.push(entry);
    }

    return {
      players: players.slice(0, 8),
      hostiles: hostiles.slice(0, 8),
      animals: animals.slice(0, 8),
      drops: drops.slice(0, 8),
    };
  }

  private getMemorySummary(): string {
    const task = this.memory.activeTask
      ? `${this.memory.activeTask.goal}: plan=[${this.memory.activeTask.plan.join(' > ')}], progress=[${this.memory.activeTask.progress.join(' | ')}]`
      : 'none';
    const home = this.memory.home
      ? `${this.memory.home.label ?? 'home'}@(${this.memory.home.x.toFixed(0)},${this.memory.home.y.toFixed(0)},${this.memory.home.z.toFixed(0)}) ${this.memory.home.dimension ?? ''}`.trim()
      : 'not set';
    const locs = (positions: StoredPosition[]) => positions
      .slice(0, 10)
      .map(p => `${p.label ?? 'spot'}@(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})`)
      .join('; ') || 'none';
    const avoid = this.memory.avoidAreas
      .slice(0, 10)
      .map(p => `${p.reason}@(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})`)
      .join('; ') || 'none';
    const notes = Object.entries({ ...this.memory.notes, ...Object.fromEntries(this.notes.entries()) })
      .slice(0, 12)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ') || 'none';

    return [
      `owner=${this.memory.owner ?? 'unknown'}`,
      `home=${home}`,
      `known_chests=${locs(this.memory.knownChests)}`,
      `known_resources=${locs(this.memory.knownResources)}`,
      `avoid_areas=${avoid}`,
      `active_task=${task}`,
      `notes=${notes}`,
    ].join(' | ');
  }

  private getItemByName(itemName: string) {
    return this.bot.registry.itemsByName[itemName]
      ?? Object.values(this.bot.registry.itemsByName).find(i => i.name.includes(itemName));
  }

  private getInventoryCountByType(itemType: number): number {
    return this.bot.inventory.items()
      .filter(i => i.type === itemType)
      .reduce((sum, item) => sum + item.count, 0);
  }

  private getCraftingTableNearby(maxDistance = 32): ReturnType<Bot['blockAt']> {
    const tableType = this.bot.registry.blocksByName['crafting_table'];
    if (!tableType) return null;
    const positions = this.bot.findBlocks({ matching: tableType.id, maxDistance, count: 1 });
    if (!positions.length) return null;
    return this.bot.blockAt(positions[0]);
  }

  private getRecipeAnalysis(itemName: string, requestedCount = 1): string {
    const itemType = this.getItemByName(itemName);
    if (!itemType) return `Unknown item: ${itemName}`;

    const table = this.getCraftingTableNearby();
    const recipes = [
      ...this.bot.recipesFor(itemType.id, null, 1, null),
      ...(table ? this.bot.recipesFor(itemType.id, null, 1, table) : []),
    ];

    if (!recipes.length) {
      return table
        ? `No known recipe for ${itemType.name}`
        : `No available recipe for ${itemType.name}; a crafting table may be needed or recipe is unknown`;
    }

    const recipe = recipes[0] as any;
    const resultCount = Math.max(1, recipe.result?.count ?? 1);
    const craftsNeeded = Math.ceil(requestedCount / resultCount);
    const ingredients: Array<{ name: string; needed: number; have: number; missing: number }> = (recipe.delta ?? [])
      .filter((d: any) => d.count < 0)
      .map((d: any) => {
        const needed = Math.abs(d.count) * craftsNeeded;
        const have = this.getInventoryCountByType(d.id);
        const name = this.bot.registry.items[d.id]?.name ?? `item_${d.id}`;
        return { name, needed, have, missing: Math.max(0, needed - have) };
      });

    const missing = ingredients.filter(i => i.missing > 0);
    const tableText = recipe.requiresTable ? (table ? 'crafting_table=nearby' : 'crafting_table=missing') : 'crafting_table=not_required';
    const ingredientText = ingredients.length
      ? ingredients.map(i => `${i.name} ${i.have}/${i.needed}${i.missing ? ` missing ${i.missing}` : ''}`).join(', ')
      : 'none';

    return [
      `item=${itemType.name}`,
      `count=${requestedCount}`,
      tableText,
      `can_craft=${missing.length === 0 && (!recipe.requiresTable || Boolean(table))}`,
      `ingredients=${ingredientText}`,
      missing.length ? `missing=${missing.map(i => `${i.name}x${i.missing}`).join(', ')}` : 'missing=none',
    ].join(' | ');
  }

  private getInventorySummary(): string {
    const items = this.bot.inventory.items();
    const groups: Record<string, string[]> = {
      wood: [],
      blocks: [],
      ores: [],
      ingots: [],
      tools: [],
      weapons: [],
      armor: [],
      food: [],
      fuel: [],
      valuables: [],
      misc: [],
    };
    const foodNames = new Set(Object.keys((this.bot.registry as any).foodsByName ?? {}));
    const armorPattern = /_(helmet|chestplate|leggings|boots)$/;

    for (const item of items) {
      const label = `${item.name}x${item.count}`;
      if (/(log|stem|planks|stick)$/.test(item.name)) groups.wood.push(label);
      else if (item.name.endsWith('_ore') || item.name.startsWith('raw_')) groups.ores.push(label);
      else if (item.name.endsWith('_ingot')) groups.ingots.push(label);
      else if (/_(pickaxe|axe|shovel|hoe)$/.test(item.name) || item.name === 'shears') groups.tools.push(label);
      else if (item.name.includes('sword') || item.name === 'bow' || item.name === 'crossbow') groups.weapons.push(label);
      else if (armorPattern.test(item.name) || item.name === 'shield') groups.armor.push(label);
      else if (foodNames.has(item.name)) groups.food.push(label);
      else if (item.name.includes('coal') || item.name === 'charcoal' || item.name.includes('plank') || item.name.includes('log')) groups.fuel.push(label);
      else if (/(diamond|emerald|netherite|gold|lapis|redstone)/.test(item.name)) groups.valuables.push(label);
      else if (this.bot.registry.blocksByName[item.name]) groups.blocks.push(label);
      else groups.misc.push(label);
    }

    return [
      `slots=${items.length}/36`,
      ...Object.entries(groups).map(([name, entries]) => `${name}=${entries.join(', ') || 'none'}`),
    ].join(' | ');
  }

  private getDangerReport(radius = 12): { severity: 'safe' | 'caution' | 'danger'; summary: string; threat?: any } {
    const bot = this.bot;
    const risks: string[] = [];
    let severity: 'safe' | 'caution' | 'danger' = 'safe';
    let nearestThreat: any;

    if ((bot.health ?? 20) <= 6) {
      severity = 'danger';
      risks.push(`low_health=${(bot.health ?? 0).toFixed(1)}/20`);
    } else if ((bot.health ?? 20) <= 12) {
      severity = 'caution';
      risks.push(`health=${(bot.health ?? 0).toFixed(1)}/20`);
    }

    if ((bot.food ?? 20) <= 6) {
      severity = 'danger';
      risks.push(`low_food=${bot.food}/20`);
    } else if ((bot.food ?? 20) <= 14) {
      if (severity === 'safe') severity = 'caution';
      risks.push(`food=${bot.food}/20`);
    }

    const hostiles = Object.values(bot.entities)
      .filter(e => bot.entity && bot.entity.position.distanceTo(e.position) <= radius && HOSTILE_MOBS.has(e.name?.toLowerCase() ?? ''))
      .sort((a, b) => bot.entity!.position.distanceTo(a.position) - bot.entity!.position.distanceTo(b.position));
    if (hostiles.length) {
      nearestThreat = hostiles[0];
      const closest = bot.entity!.position.distanceTo(nearestThreat.position);
      severity = closest <= 5 ? 'danger' : severity === 'safe' ? 'caution' : severity;
      risks.push(`hostiles=${hostiles.slice(0, 4).map(e => `${e.name}:${bot.entity!.position.distanceTo(e.position).toFixed(0)}m`).join(',')}`);
    }

    const p = bot.entity!.position.floored();
    const hazards = ['lava', 'fire', 'cactus', 'magma_block', 'campfire', 'soul_campfire'];
    const foundHazards: string[] = [];
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -2; dy <= 1; dy++) {
        for (let dz = -3; dz <= 3; dz++) {
          const b = bot.blockAt(p.offset(dx, dy, dz), false);
          if (b && hazards.includes(b.name)) foundHazards.push(`${b.name}@${bot.entity!.position.distanceTo(b.position).toFixed(0)}m`);
        }
      }
    }
    if (foundHazards.length) {
      severity = 'danger';
      risks.push(`hazards=${foundHazards.slice(0, 4).join(',')}`);
    }

    const below = bot.blockAt(p.offset(0, -1, 0), false);
    const twoBelow = bot.blockAt(p.offset(0, -2, 0), false);
    if (below?.name === 'air' && twoBelow?.name === 'air') {
      severity = 'danger';
      risks.push('fall_risk=true');
    }

    const head = bot.blockAt(p.offset(0, 1, 0), false);
    if (head?.name === 'water' || head?.name === 'bubble_column') {
      severity = 'danger';
      risks.push('drowning_risk=true');
    }

    const timeOfDay = bot.time?.timeOfDay ?? 0;
    if (timeOfDay >= 13000 && timeOfDay <= 23000) {
      if (severity === 'safe') severity = 'caution';
      risks.push('night=true');
    }

    return {
      severity,
      summary: risks.length ? `${severity}: ${risks.join(' | ')}` : 'safe: no immediate danger detected',
      threat: nearestThreat,
    };
  }

  private async craftItemByName(itemName: string, count = 1): Promise<string> {
    return this.executeTool('craft_item', { item_name: itemName, count });
  }

  private async gatherBlocksByNames(blockNames: string[], count: number, maxDistance: number): Promise<string> {
    const ids = blockNames.flatMap((name) => Object.values(this.bot.registry.blocksByName)
      .filter(block => block.name === name || block.name.endsWith(`_${name}`) || block.name.endsWith(name))
      .map(block => block.id));
    if (!ids.length) return `No matching block types for ${blockNames.join(', ')}`;

    const positions = this.bot.findBlocks({ matching: [...new Set(ids)], maxDistance, count });
    if (!positions.length) return `No ${blockNames.join('/')} found within ${maxDistance} blocks`;

    let collected = 0;
    const failures: string[] = [];
    for (const pos of positions.slice(0, count)) {
      const result = await this.executeTool('break_and_collect', { x: pos.x, y: pos.y, z: pos.z });
      if (result.startsWith('Collected') || result.startsWith('Broke')) collected++;
      else failures.push(result);
    }
    return `Collected ${collected}/${Math.min(count, positions.length)} block(s)${failures.length ? `; issues: ${failures.slice(0, 2).join('; ')}` : ''}`;
  }

  private getBestExistingPickaxe(): string | null {
    const pickaxes = this.bot.inventory.items()
      .filter(i => i.name.endsWith('_pickaxe'))
      .sort((a, b) => this.getToolRank(b.name) - this.getToolRank(a.name));
    return pickaxes[0]?.name ?? null;
  }

  private async craftPickaxeSkill(material?: string): Promise<string> {
    const wanted = material ?? (this.bot.inventory.items().some(i => i.name === 'cobblestone') ? 'stone' : 'wooden');
    const target = `${wanted}_pickaxe`;
    const existing = this.getBestExistingPickaxe();
    if (existing && this.getToolRank(existing) >= this.getToolRank(target)) return `Already have ${existing}`;

    const haveLogs = this.bot.inventory.items().some(i => i.name.endsWith('_log') || i.name.endsWith('_stem'));
    const havePlanks = this.bot.inventory.items().some(i => i.name.endsWith('_planks'));
    if (!haveLogs && !havePlanks) return 'Need logs or planks before crafting a pickaxe';

    if (!havePlanks) {
      const log = this.bot.inventory.items().find(i => i.name.endsWith('_log') || i.name.endsWith('_stem'));
      if (log) await this.craftItemByName(log.name.replace(/_(log|stem)$/, '_planks'), 1).catch(() => undefined);
    }

    const hasCraftingTable = this.bot.inventory.items().some(i => i.name === 'crafting_table') || Boolean(this.getCraftingTableNearby());
    if (!hasCraftingTable) await this.craftItemByName('crafting_table', 1).catch(() => undefined);

    if (!this.bot.inventory.items().some(i => i.name === 'stick')) {
      await this.craftItemByName('stick', 1).catch(() => undefined);
    }

    if (wanted === 'stone' && !this.bot.inventory.items().some(i => i.name === 'cobblestone')) {
      return 'Need cobblestone for a stone pickaxe';
    }

    return this.craftItemByName(target, 1);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private isAirLike(blockName?: string): boolean {
    return !blockName || blockName === 'air' || blockName === 'cave_air' || blockName === 'void_air';
  }

  private chooseScaffoldBlock(blockName?: string) {
    const badScaffold = new Set([
      'sand', 'red_sand', 'gravel', 'anvil', 'chipped_anvil', 'damaged_anvil',
      'torch', 'soul_torch', 'redstone_torch', 'ladder', 'vine', 'scaffolding',
      'water_bucket', 'lava_bucket', 'tnt', 'obsidian', 'chest', 'barrel',
      'crafting_table', 'furnace',
    ]);
    const preferred = [
      'cobblestone', 'dirt', 'netherrack', 'deepslate', 'cobbled_deepslate',
      'stone', 'oak_planks', 'spruce_planks', 'birch_planks', 'andesite',
      'granite', 'diorite',
    ];
    const items = this.bot.inventory.items().filter(item => {
      if (blockName && !item.name.includes(blockName)) return false;
      if (badScaffold.has(item.name)) return false;
      if (!this.bot.registry.blocksByName[item.name]) return false;
      return item.count > 0;
    });
    if (!items.length) return undefined;

    return items.sort((a, b) => {
      const aRank = preferred.indexOf(a.name);
      const bRank = preferred.indexOf(b.name);
      const normalizedA = aRank === -1 ? Number.MAX_SAFE_INTEGER : aRank;
      const normalizedB = bRank === -1 ? Number.MAX_SAFE_INTEGER : bRank;
      return normalizedA - normalizedB || b.count - a.count;
    })[0];
  }

  private async waitUntil(condition: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (condition()) return true;
      await this.sleep(intervalMs);
    }
    return false;
  }

  private async buildUp(height = 1, blockName?: string): Promise<string> {
    const bot = this.bot;
    const levels = Math.max(1, Math.min(Math.floor(height), 8));
    let placed = 0;

    this.activeNavigationGoal = null;
    this.activeFollowGoal = null;
    bot.pathfinder.stop();
    bot.clearControlStates();

    for (let i = 0; i < levels; i++) {
      const item = this.chooseScaffoldBlock(blockName);
      if (!item) {
        return placed
          ? `Built up ${placed}/${levels}; out of safe scaffold blocks`
          : `No safe scaffold blocks${blockName ? ` matching ${blockName}` : ''}`;
      }

      const feet = bot.entity!.position.floored();
      const standOnPos = feet.offset(0, -1, 0);
      const standOnBlock = bot.blockAt(standOnPos);
      if (!standOnBlock || this.isAirLike(standOnBlock.name)) {
        return placed
          ? `Built up ${placed}/${levels}; no solid block below for next pillar`
          : 'Cannot build up: no solid block below';
      }

      const bodySpace = bot.blockAt(feet.offset(0, 1, 0), false);
      const headSpace = bot.blockAt(feet.offset(0, 2, 0), false);
      if (!this.isAirLike(bodySpace?.name) || !this.isAirLike(headSpace?.name)) {
        return placed
          ? `Built up ${placed}/${levels}; blocked overhead`
          : `Cannot build up: blocked overhead by ${bodySpace?.name ?? headSpace?.name ?? 'block'}`;
      }

      await bot.equip(item, 'hand');
      await bot.lookAt(standOnBlock.position.offset(0.5, 1, 0.5), true);

      const startingY = bot.entity!.position.y;
      bot.setControlState('jump', true);
      const airborne = await this.waitUntil(() => bot.entity!.position.y > startingY + 0.35, 900, 25);
      if (!airborne) {
        bot.setControlState('jump', false);
        return placed
          ? `Built up ${placed}/${levels}; jump timing failed`
          : 'Could not jump high enough to place scaffold';
      }

      try {
        await bot.placeBlock(standOnBlock, new Vec3(0, 1, 0));
        placed++;
      } catch (err) {
        bot.setControlState('jump', false);
        const message = err instanceof Error ? err.message : String(err);
        return placed
          ? `Built up ${placed}/${levels}; next place failed: ${message}`
          : `Failed to place scaffold below me: ${message}`;
      }

      await this.waitUntil(() => bot.entity!.onGround, 1600, 50);
      bot.setControlState('jump', false);
      await this.sleep(150);
    }

    const p = bot.entity!.position;
    return `Built up ${placed} block(s); now at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
  }

  private async runGeminiBuild(message: string, sender: string): Promise<string> {
    const bot = this.bot;
    const playerEntity = bot.players[sender]?.entity;
    const playerCtx = playerEntity
      ? { position: { x: playerEntity.position.x, y: playerEntity.position.y, z: playerEntity.position.z }, yaw: playerEntity.yaw }
      : undefined;

    const lines = BUILD_VOICELINES[this.personality];
    this.log(`[gemini-build] generating: "${message}"`);

    // Lock origin from the first pass so all passes render in the same spot
    // and replay() diffs cleanly across them (player sees the structure evolve).
    const origin = this.builder.defaultOrigin(playerCtx);
    const rot = origin.rotation ?? 0;
    const placeBuild = (b: GeneratedBuild) => {
      const cx = Math.floor(b.width / 2);
      const cz = Math.floor(b.length / 2);
      return b.blocks.map(blk => {
        const lx = blk.x - cx;
        const lz = blk.z - cz;
        let rx = lx, rz = lz;
        if (rot === 90)  { rx = -lz; rz =  lx; }
        else if (rot === 180) { rx = -lx; rz = -lz; }
        else if (rot === 270) { rx =  lz; rz = -lx; }
        return {
          x: origin.x + rx,
          y: origin.y + blk.y,
          z: origin.z + rz,
          block: rotateBlockState(blk.block, rot),
        };
      });
    };

    // Streaming render: each pass kicks off a replay immediately and we DON'T
    // await it. When the next pass arrives, we cancel the in-flight render and
    // start the next one — BuildSession.applyTransition diffs against whatever
    // got placed so far, so it just keeps editing the structure live.
    let announcedStart = false;
    let announcedMid = false;
    let finalArrived = false;
    // ~12 blocks/sec base, stretching up to ~2 blocks/sec if the final pass
    // is slow and we're nearing the end of the massing render.
    const BASE_DELAY_MS = 80;
    const MAX_DELAY_MS = 500;
    const onReplayProgress = (s: BuildStatus): void => {
      this.onBuildStatus?.(s);
      if (s.phase !== 'building') return;
      if (!announcedStart && s.placed > 0) {
        announcedStart = true;
        this.onAutonomousMessage?.(pickLine(lines.start));
      }
      if (!announcedMid && s.total > 0 && s.placed / s.total >= 0.5) {
        announcedMid = true;
        this.onAutonomousMessage?.(pickLine(lines.mid));
      }
      // If the final design hasn't arrived and we're past 70% of massing,
      // stretch the delay so we don't finish and stand idle. Quadratic ramp
      // from BASE at 70% to MAX at 100%.
      if (!finalArrived && s.total > 0) {
        const frac = s.placed / s.total;
        if (frac > 0.7) {
          const t = Math.min(1, (frac - 0.7) / 0.3);
          const delay = BASE_DELAY_MS + (MAX_DELAY_MS - BASE_DELAY_MS) * t * t;
          this.builder.setFrameDelay(delay);
        }
      } else {
        this.builder.setFrameDelay(BASE_DELAY_MS);
      }
    };

    let lastReplay: Promise<unknown> | null = null;
    const startReplay = (build: GeneratedBuild, label: string, isFinal: boolean): void => {
      const blocks = placeBuild(build);
      if (!blocks.length) return;
      const desc = isFinal
        ? `${build.description} (${build.width}×${build.height}×${build.length}, ${blocks.length} blocks)`
        : `${build.description} — ${label}`;
      this.log(`[gemini-build] rendering ${label} — ${blocks.length} blocks${isFinal ? ' (final)' : ''}`);
      if (isFinal) finalArrived = true;
      // Cancel any in-flight render; applyTransition will diff from whatever
      // got placed so far into the new target.
      this.builder.cancelBuild();
      this.builder.setFrameDelay(BASE_DELAY_MS);
      lastReplay = this.builder.awaitIdle()
        .then(() => this.builder.replay(blocks, desc, origin, onReplayProgress))
        .catch(err => {
          this.log(`[gemini-build] render failed (${label}): ${(err as Error).message}`);
        });
    };

    const generated = await buildFromPrompt(message, this.log, async ({ pass, totalPasses, label, build, isFinal }) => {
      startReplay(build, `pass ${pass + 1}/${totalPasses} (${label})`, isFinal);
    });
    if (!generated.blocks.length) {
      this.onAutonomousMessage?.(pickLine(lines.fail));
      return '';
    }

    // Wait for whichever replay is currently running to finish (final pass was
    // kicked off inside the onPass callback above).
    if (lastReplay) await lastReplay;
    const status = this.builder.getStatus();
    if (status.phase === 'error') {
      this.onAutonomousMessage?.(pickLine(lines.fail));
      return '';
    }
    if (status.phase === 'cancelled') {
      this.onAutonomousMessage?.(pickLine(lines.cancelled));
      return '';
    }
    this.onAutonomousMessage?.(pickLine(lines.done));
    return '';
  }

  private makeVec3(x: number, y: number, z: number) {
    if (!this.bot.entity) throw new Error('Bot not spawned');
    const v = this.bot.entity.position.clone();
    v.x = x; v.y = y; v.z = z;
    return v;
  }

  private navigateTo(x: number, y: number, z: number, range = 1, timeoutMs = 60000): Promise<void> {
    const bot = this.bot;
    return new Promise((resolve, reject) => {
      this.interruptActiveNavigation('Navigation replaced');
      const navId = ++this.navigationSeq;
      this.activeFollowGoal = null;
      this.activeNavigationGoal = { id: navId, x, y, z, range };
      bot.pathfinder.setMovements(this.getMovements());

      const cleanup = () => {
        clearTimeout(timeoutId);
        bot.removeListener('goal_reached', onReached);
        bot.removeListener('path_update', onPathUpdate);
        if (this.activeNavigationGoal?.id === navId) this.activeNavigationGoal = null;
        if (this.activeNavigationAbort === abort) this.activeNavigationAbort = null;
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        bot.pathfinder.stop();
        reject(new Error('Navigation timed out'));
      }, timeoutMs);

      const onReached = () => {
        cleanup();
        resolve();
      };

      const onPathUpdate = (results: any) => {
        if (results.status === 'noPath') {
          cleanup();
          bot.pathfinder.stop();
          reject(new Error('No path possible to destination'));
        }
      };

      const abort = (reason = 'Navigation interrupted') => {
        cleanup();
        bot.pathfinder.stop();
        reject(new Error(reason));
      };

      this.activeNavigationAbort = abort;
      bot.once('goal_reached', onReached);
      bot.on('path_update', onPathUpdate);
      bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
    });
  }

  private interruptActiveNavigation(reason = 'Navigation interrupted'): void {
    const abort = this.activeNavigationAbort;
    if (abort) {
      abort(reason);
      return;
    }
    this.activeNavigationGoal = null;
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const bot = this.bot;
    if (!bot.entity) return 'Bot is not spawned yet';

    switch (name) {

      case 'start_task': {
        const { goal, plan } = args as { goal: string; plan: string[] };
        this.memory.activeTask = {
          goal,
          plan: Array.isArray(plan) ? plan.slice(0, 12) : [],
          progress: [],
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.saveMemory();
        return `Started task "${goal}" with ${this.memory.activeTask.plan.length} step(s)`;
      }

      case 'update_task_progress': {
        const { progress } = args as { progress: string };
        if (!this.memory.activeTask) return 'No active task to update';
        this.memory.activeTask.progress.push(progress);
        this.memory.activeTask.progress = this.memory.activeTask.progress.slice(-20);
        this.memory.activeTask.updatedAt = new Date().toISOString();
        this.saveMemory();
        return `Task progress saved: ${progress}`;
      }

      case 'complete_task': {
        const { summary } = args as { summary?: string };
        const goal = this.memory.activeTask?.goal ?? 'task';
        if (summary) this.notes.set(`completed_${Date.now()}`, `${goal}: ${summary}`);
        this.memory.activeTask = undefined;
        this.saveMemory();
        return summary ? `Completed ${goal}: ${summary}` : `Completed ${goal}`;
      }

      case 'get_current_task': {
        if (!this.memory.activeTask) return 'No active task';
        const task = this.memory.activeTask;
        return `goal=${task.goal} | plan=${task.plan.join(' > ') || 'none'} | progress=${task.progress.join(' | ') || 'none'} | updated=${task.updatedAt}`;
      }

      case 'read_memory': {
        return this.getMemorySummary();
      }

      case 'remember_location': {
        const { kind, label, x, y, z, reason } = args as {
          kind: 'home' | 'chest' | 'resource' | 'avoid';
          label: string;
          x: number;
          y: number;
          z: number;
          reason?: string;
        };
        const position: StoredPosition = { x, y, z, dimension: bot.game.dimension, label };
        if (kind === 'home') {
          this.memory.home = position;
          this.homePosition = { x, y, z };
        } else if (kind === 'chest') {
          this.memory.knownChests.push(position);
          this.memory.knownChests = this.memory.knownChests.slice(-30);
        } else if (kind === 'resource') {
          this.memory.knownResources.push(position);
          this.memory.knownResources = this.memory.knownResources.slice(-50);
        } else {
          this.memory.avoidAreas.push({ ...position, reason: reason ?? label });
          this.memory.avoidAreas = this.memory.avoidAreas.slice(-30);
        }
        this.saveMemory();
        return `Remembered ${kind} ${label} at (${x}, ${y}, ${z})`;
      }

      case 'inventory_summary': {
        return this.getInventorySummary();
      }

      case 'can_craft':
      case 'missing_materials_for': {
        const { item_name, count = 1 } = args as { item_name: string; count?: number };
        return this.getRecipeAnalysis(item_name, count as number);
      }

      case 'check_danger': {
        const { radius = 12 } = args as { radius?: number };
        return this.getDangerReport(Math.min(radius as number, 24)).summary;
      }

      case 'escape_danger': {
        const danger = this.getDangerReport(16);
        if (bot.food !== undefined && bot.food <= 14) {
          await this.executeTool('eat', {}).catch(() => undefined);
        }
        const threat = danger.threat;
        if (!threat) return `${danger.summary}; no directional threat to escape from`;
        const p = bot.entity.position;
        const dx = p.x - threat.position.x;
        const dz = p.z - threat.position.z;
        const length = Math.max(1, Math.sqrt(dx * dx + dz * dz));
        const target = p.offset((dx / length) * 10, 0, (dz / length) * 10);
        await this.navigateTo(target.x, target.y, target.z, 3, 15000).catch(() => undefined);
        return `Escaped from ${threat.name ?? 'threat'}; ${this.getDangerReport(16).summary}`;
      }

      case 'prepare_for_mining': {
        const danger = this.getDangerReport(12);
        const results: string[] = [`danger=${danger.summary}`];
        if ((bot.food ?? 20) <= 14) {
          results.push(await this.executeTool('eat', {}).catch(err => `eat failed: ${err instanceof Error ? err.message : String(err)}`));
        }
        results.push(await this.executeTool('equip_best_armor', {}).catch(() => 'armor check skipped'));
        const pickaxe = this.getBestExistingPickaxe();
        if (pickaxe) {
          results.push(`pickaxe=${pickaxe}`);
        } else {
          results.push(await this.craftPickaxeSkill('stone').catch(err => `pickaxe craft failed: ${err instanceof Error ? err.message : String(err)}`));
        }
        results.push(this.getInventorySummary());
        return results.join(' | ');
      }

      case 'gather_wood': {
        const { count = 8, max_distance = 48 } = args as { count?: number; max_distance?: number };
        return this.gatherBlocksByNames(['log', 'stem'], Math.max(1, count as number), Math.min(max_distance as number, 64));
      }

      case 'craft_pickaxe': {
        const { material } = args as { material?: string };
        return this.craftPickaxeSkill(material);
      }

      case 'deposit_inventory': {
        const { keep_tools_food_valuables = true } = args as { keep_tools_food_valuables?: boolean };
        let chest = this.memory.knownChests
          .map(p => bot.blockAt(this.makeVec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))))
          .find(b => b && b.name !== 'air') ?? null;
        if (!chest) chest = this.findNearestBlockByNames(this.getContainerBlockNames(), 32);
        if (!chest) return 'No known or visible chest nearby';

        await this.navigateTo(chest.position.x, chest.position.y, chest.position.z, 2, 30000);
        const container = await (bot as any).openContainer(chest);
        const keepPattern = /pickaxe|axe|shovel|hoe|sword|bow|crossbow|helmet|chestplate|leggings|boots|shield|bread|apple|potato|carrot|beef|pork|chicken|mutton|cod|salmon|diamond|emerald|netherite|ingot|ore|coal|charcoal|arrow/;
        let deposited = 0;
        try {
          for (const item of bot.inventory.items()) {
            if (keep_tools_food_valuables && keepPattern.test(item.name)) continue;
            await container.deposit(item.type, null, item.count);
            deposited++;
          }
        } finally {
          container.close();
        }
        this.memory.knownChests.push({ x: chest.position.x, y: chest.position.y, z: chest.position.z, dimension: bot.game.dimension, label: chest.name });
        this.memory.knownChests = this.memory.knownChests.slice(-30);
        this.saveMemory();
        return `Deposited ${deposited} stack(s) into ${chest.name} at (${chest.position.x}, ${chest.position.y}, ${chest.position.z})`;
      }

      case 'return_home': {
        if (!this.homePosition && this.memory.home) {
          this.homePosition = { x: this.memory.home.x, y: this.memory.home.y, z: this.memory.home.z };
        }
        return this.executeTool('go_home', {});
      }

      case 'collect_food': {
        const { target_count = 4 } = args as { target_count?: number };
        const foodNames = new Set(Object.keys((bot.registry as any).foodsByName ?? {}));
        const currentFood = bot.inventory.items().filter(i => foodNames.has(i.name)).reduce((sum, i) => sum + i.count, 0);
        if (currentFood >= (target_count as number)) return `Already have ${currentFood} food item(s)`;

        const passiveFoodMobs = ['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'cod', 'salmon'];
        let hunted = 0;
        for (const mobName of passiveFoodMobs) {
          if (hunted + currentFood >= (target_count as number)) break;
          const target = bot.nearestEntity(e => e.name === mobName && bot.entity!.position.distanceTo(e.position) <= 32);
          if (!target) continue;
          const result = await this.executeTool('kill_entity', { entity_name: mobName, max_distance: 32 });
          if (result.includes('Killed')) {
            hunted++;
            await this.executeTool('pick_up_items', { max_distance: 8 }).catch(() => undefined);
          }
        }
        const finalFood = bot.inventory.items().filter(i => foodNames.has(i.name)).reduce((sum, i) => sum + i.count, 0);
        return `Food collection done. Started with ${currentFood}, hunted ${hunted}, now have ${finalFood}`;
      }

      case 'scan_surroundings': {
        const { radius = 16 } = args as { radius?: number };
        const r = Math.min(radius as number, 32);
        const p = bot.entity.position;
        const entities = this.getEntityScan(r);
        const container = this.findNearestBlockByNames(this.getContainerBlockNames(), r);
        const resources = this.listNearestBlocksByNames([
          'log', 'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore',
          'diamond_ore', 'emerald_ore', 'crafting_table', 'furnace', 'bed', 'chest', 'barrel',
        ], r, 12);
        const weather = (bot as any).thunderState > 0.5 ? 'thunder' : bot.isRaining ? 'rain' : 'clear';
        return [
          `pos=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) dim=${bot.game.dimension}`,
          `health=${(bot.health ?? 0).toFixed(1)}/20 food=${bot.food ?? 0}/20 weather=${weather}`,
          `players=${entities.players.join('; ') || 'none'}`,
          `hostiles=${entities.hostiles.join('; ') || 'none'}`,
          `animals=${entities.animals.join('; ') || 'none'}`,
          `drops=${entities.drops.join('; ') || 'none'}`,
          `nearest_container=${container ? `${container.name}@(${container.position.x},${container.position.y},${container.position.z}) ${this.getDistanceTo(container.position)}m` : 'none'}`,
          `resources=${resources.join('; ') || 'none'}`,
          `equipment=${this.getEquipmentSummary()}`,
        ].join(' | ');
      }

      case 'get_equipment_status': {
        return this.getEquipmentSummary();
      }

      case 'get_best_tool_for_block': {
        const { block_name, x, y, z } = args as { block_name?: string; x?: number; y?: number; z?: number };
        let block: NonNullable<ReturnType<Bot['blockAt']>> | null = null;
        if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
          block = bot.blockAt(this.makeVec3(x, y, z));
        } else if (block_name) {
          const blockInfo = bot.registry.blocksByName[block_name];
          if (!blockInfo) return `Unknown block: ${block_name}`;
          block = {
            ...blockInfo,
            position: bot.entity.position.floored(),
          } as unknown as NonNullable<ReturnType<Bot['blockAt']>>;
        }
        if (!block || block.name === 'air') return 'No block found for tool check';
        return this.getBestToolReportForBlock(block);
      }

      case 'find_nearest_chest': {
        const { max_distance = 32 } = args as { max_distance?: number };
        const maxDistance = Math.min(max_distance as number, 64);
        const block = this.findNearestBlockByNames(this.getContainerBlockNames(), maxDistance);
        if (!block) return `No chest-like container found within ${maxDistance} blocks`;
        return `${block.name} at (${block.position.x}, ${block.position.y}, ${block.position.z}), ${this.getDistanceTo(block.position)}m away`;
      }


      case 'equip_best_armor': {
        const manager = (bot as any).armorManager;
        if (manager?.equipAll) {
          await manager.equipAll();
          return `Equipped best armor. ${this.getEquipmentSummary()}`;
        }
        return `Armor manager plugin unavailable. ${this.getEquipmentSummary()}`;
      }

      case 'find_nearby_resources': {
        const { max_distance = 32 } = args as { max_distance?: number };
        const maxDistance = Math.min(max_distance as number, 64);
        const resources = this.listNearestBlocksByNames([
          'log', 'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore',
          'diamond_ore', 'emerald_ore', 'ancient_debris', 'crafting_table', 'furnace', 'bed',
          'chest', 'barrel', 'water', 'lava',
        ], maxDistance, 20);
        return resources.length ? resources.join(', ') : `No tracked resources found within ${maxDistance} blocks`;
      }

      case 'get_position': {
        const p = bot.entity.position;
        return `x=${p.x.toFixed(1)}, y=${p.y.toFixed(1)}, z=${p.z.toFixed(1)}`;
      }

      case 'move_to': {
        const { x, y, z, range = 1 } = args as { x: number; y: number; z: number; range?: number };
        await this.navigateTo(x, y, z, range as number);
        return `Arrived at (${x}, ${y}, ${z})`;
      }

      case 'follow_player': {
        const { username, range = 2 } = args as { username: string; range?: number };
        const target = bot.players[username]?.entity;
        if (!target) return `Cannot see player: ${username}`;
        this.interruptActiveNavigation('Navigation replaced by follow_player');
        this.activeFollowGoal = { username, range: range as number };
        bot.pathfinder.setMovements(this.getMovements());
        bot.pathfinder.setGoal(new goals.GoalFollow(target, range as number), true);
        return `Following ${username}`;
      }

      case 'stop_moving': {
        this.interruptActiveNavigation('Navigation stopped by stop_moving');
        this.activeFollowGoal = null;
        bot.pathfinder.stop();
        bot.clearControlStates();
        return 'Stopped moving';
      }

      case 'look_at': {
        const { x, y, z } = args as { x: number; y: number; z: number };
        await bot.lookAt(this.makeVec3(x, y, z));
        return `Looking at (${x}, ${y}, ${z})`;
      }

      case 'jump': {
        bot.setControlState('jump', true);
        await new Promise<void>(r => setTimeout(r, 250));
        bot.setControlState('jump', false);
        return 'Jumped';
      }

      case 'build_up': {
        const { height = 1, block_name } = args as { height?: number; block_name?: string };
        return this.buildUp(height as number, block_name);
      }

      case 'get_health': {
        return `Health: ${(bot.health ?? 0).toFixed(1)}/20, Food: ${bot.food ?? 0}/20`;
      }

      case 'list_inventory': {
        const items = bot.inventory.items();
        if (!items.length) return 'Inventory is empty';
        return items.map(i => `${i.name} x${i.count}`).join(', ');
      }

      case 'find_item': {
        const { item_name } = args as { item_name: string };
        const matches = bot.inventory.items().filter(i => i.name.includes(item_name));
        if (!matches.length) return `No ${item_name} in inventory`;
        return matches.map(i => `${i.name} x${i.count}`).join(', ');
      }

      case 'equip_item': {
        const { item_name, destination = 'hand' } = args as { item_name: string; destination?: string };
        const item = bot.inventory.items().find(i => i.name.includes(item_name));
        if (!item) return `No ${item_name} in inventory`;
        await bot.equip(item, destination as Parameters<typeof bot.equip>[1]);
        return `Equipped ${item.name} to ${destination}`;
      }

      case 'find_blocks': {
        const { block_name, max_distance = 32, count = 5 } = args as {
          block_name: string;
          max_distance?: number;
          count?: number;
        };
        const blockType = bot.registry.blocksByName[block_name];
        if (!blockType) return `Unknown block type: ${block_name}`;
        const positions = bot.findBlocks({
          matching: blockType.id,
          maxDistance: Math.min(max_distance as number, 64),
          count: count as number,
        });
        if (!positions.length) return `No ${block_name} found within ${max_distance} blocks`;
        return positions.map(p => `(${p.x}, ${p.y}, ${p.z})`).join(', ');
      }

      case 'get_block_info': {
        const { x, y, z } = args as { x: number; y: number; z: number };
        const block = bot.blockAt(this.makeVec3(x, y, z));
        if (!block) return `No block info available at (${x}, ${y}, ${z})`;
        return `Block at (${x}, ${y}, ${z}): ${block.name}`;
      }

      case 'dig_block': {
        const { x, y, z } = args as { x: number; y: number; z: number };
        const target = this.makeVec3(x, y, z);
        const block = bot.blockAt(target);
        if (!block || block.name === 'air') return `No block to dig at (${x}, ${y}, ${z})`;
        if (!bot.canDigBlock(block)) return `Cannot dig ${block.name} (wrong tool or unbreakable)`;

        const dist = bot.entity.position.distanceTo(target);
        if (dist > 4) {
          await this.navigateTo(x, y, z, 2, 30000);
        }

        await bot.dig(block);
        return `Dug ${block.name} at (${x}, ${y}, ${z})`;
      }

      case 'find_entities': {
        const { max_distance = 16, type_filter } = args as { max_distance?: number; type_filter?: string };
        const entities = Object.values(bot.entities).filter(e => {
          if (e.username === bot.username) return false;
          const dist = bot.entity!.position.distanceTo(e.position);
          if (dist > (max_distance as number)) return false;
          if (type_filter) {
            const f = (type_filter as string).toLowerCase();
            return e.type?.includes(f) || e.name?.includes(f) || e.username?.toLowerCase().includes(f);
          }
          return true;
        });
        if (!entities.length) return 'No entities found nearby';
        return entities
          .slice(0, 10)
          .map(e => {
            const dist = bot.entity!.position.distanceTo(e.position).toFixed(0);
            const label = e.username ?? e.displayName ?? e.name ?? e.type ?? 'unknown';
            return `${label} (${dist}m)`;
          })
          .join(', ');
      }

      case 'list_players': {
        const players = Object.values(bot.players).filter(p => p.username !== bot.username);
        if (!players.length) return 'No other players online';
        return players
          .map(p => {
            const pos = p.entity?.position;
            return pos
              ? `${p.username} @ (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)})`
              : p.username;
          })
          .join(', ');
      }

      case 'craft_item': {
        const { item_name, count = 1 } = args as { item_name: string; count?: number };

        let itemType = bot.registry.itemsByName[item_name];
        if (!itemType) {
          const match = Object.values(bot.registry.itemsByName).find(i => i.name.includes(item_name));
          if (!match) return `Unknown item: ${item_name}`;
          itemType = match;
        }

        // Try 2x2 inventory crafting first
        let recipes = bot.recipesFor(itemType.id, null, 1, null);
        let craftingTable: ReturnType<typeof bot.blockAt> = null;

        if (!recipes.length) {
          // Find a nearby crafting table for 3x3 recipes
          const tableType = bot.registry.blocksByName['crafting_table'];
          if (tableType) {
            const positions = bot.findBlocks({ matching: tableType.id, maxDistance: 32, count: 1 });
            if (positions.length) {
              await this.navigateTo(positions[0].x, positions[0].y, positions[0].z, 2, 30000);
              craftingTable = bot.blockAt(positions[0]);
            }
          }
          if (craftingTable) {
            recipes = bot.recipesFor(itemType.id, null, 1, craftingTable);
          }
        }

        if (!recipes.length) {
          return craftingTable
            ? `No recipe for ${itemType.name} (even with crafting table)`
            : `No recipe for ${itemType.name} without crafting table — none found nearby`;
        }

        try {
          await bot.craft(recipes[0], count as number, craftingTable ?? undefined);
          return `Crafted ${count}x ${itemType.name}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to craft ${itemType.name}: ${msg}`;
        }
      }

      case 'drop_item': {
        const { item_name, count } = args as { item_name: string; count?: number };
        const item = bot.inventory.items().find(i => i.name.includes(item_name));
        if (!item) return `No ${item_name} in inventory`;
        const dropCount = count ?? item.count;
        const playerEntity = this.currentSender ? bot.players[this.currentSender]?.entity : null;
        if (playerEntity) {
          await bot.lookAt(playerEntity.position.offset(0, playerEntity.height * 0.9, 0), true);
        }
        await bot.toss(item.type, null, dropCount);
        return `Dropped ${dropCount}x ${item.name}`;
      }

      case 'attack_entity': {
        const { entity_name, max_distance = 16 } = args as { entity_name: string; max_distance?: number };
        const target = bot.nearestEntity(e => {
          if (e.username === bot.username) return false;
          const label = (e.name ?? e.displayName ?? e.username ?? '').toLowerCase();
          const dist = bot.entity!.position.distanceTo(e.position);
          return dist <= (max_distance as number) && label.includes(entity_name.toLowerCase());
        });
        if (!target) return `No ${entity_name} found within ${max_distance} blocks`;
        this.interruptActiveNavigation('Navigation replaced by attack_entity');
        this.activeFollowGoal = null;
        const dist = bot.entity.position.distanceTo(target.position);
        if (dist > 3) await this.navigateTo(target.position.x, target.position.y, target.position.z, 2, 15000);
        await bot.lookAt(target.position.offset(0, (target.height ?? 1) * 0.9, 0));
        await bot.attack(target);
        return `Attacked ${target.name ?? target.username ?? entity_name}`;
      }

      case 'kill_entity': {
        const { entity_name, max_distance = 24 } = args as { entity_name: string; max_distance?: number };
        const target = bot.nearestEntity(e => {
          if (e.username === bot.username) return false;
          const label = (e.name ?? e.displayName ?? e.username ?? '').toLowerCase();
          const dist = bot.entity!.position.distanceTo(e.position);
          return dist <= (max_distance as number) && label.includes(entity_name.toLowerCase());
        });
        if (!target) return `No ${entity_name} found within ${max_distance} blocks`;
        this.interruptActiveNavigation('Navigation replaced by kill_entity');
        this.activeFollowGoal = null;

        const weapons = bot.inventory.items().filter(i => i.name.includes('sword') || i.name.includes('axe'));
        if (weapons.length) await bot.equip(weapons[0], 'hand');

        const targetId = target.id;
        const label = target.name ?? target.displayName ?? target.username ?? entity_name;
        const pvp = (bot as any).pvp;
        if (pvp?.attack) {
          pvp.attack(target);
          return new Promise<string>(resolve => {
            const timeout = setTimeout(() => {
              pvp.stop?.();
              resolve(`Stopped attacking ${label} (timed out)`);
            }, 30000);
            const check = setInterval(() => {
              if (!bot.entities[targetId]) {
                clearTimeout(timeout);
                clearInterval(check);
                pvp.stop?.();
                resolve(`Killed ${label}`);
              }
            }, 500);
          });
        }

        return new Promise<string>(resolve => {
          const timeout = setTimeout(() => {
            bot.off('physicsTick', onTick);
            resolve(`Stopped attacking ${label} (timed out)`);
          }, 30000);

          let lastAttack = 0;
          const onTick = async () => {
            if (!bot.entity) {
              clearTimeout(timeout);
              bot.off('physicsTick', onTick);
              resolve('Combat aborted — I died');
              return;
            }
            const e = bot.entities[targetId];
            if (!e) {
              clearTimeout(timeout);
              bot.off('physicsTick', onTick);
              resolve(`Killed ${label}`);
              return;
            }
            const now = Date.now();
            if (now - lastAttack < 600) return;
            lastAttack = now;
            const d = bot.entity.position.distanceTo(e.position);
            if (d > 3) {
              bot.pathfinder.setGoal(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2));
              return;
            }
            try {
              await bot.lookAt(e.position.offset(0, (e.height ?? 1) * 0.9, 0));
              await bot.attack(e);
            } catch { /* entity may have moved */ }
          };
          bot.on('physicsTick', onTick);
        });
      }

      case 'defend_self': {
        const { enable } = args as { enable: boolean };
        if (enable) {
          if (this.defendActive) return 'Defend mode already active';
          this.defendActive = true;
          this.defendTick = () => {
            if (!bot.entity) return;
            const now = Date.now();
            if (now - this.lastDefendAttack < 600) return;
            const hostile = bot.nearestEntity(e => {
              const dist = bot.entity!.position.distanceTo(e.position);
              return dist <= 5 && HOSTILE_MOBS.has(e.name?.toLowerCase() ?? '');
            });
            if (hostile) {
              this.lastDefendAttack = now;
              void (bot.attack(hostile) as unknown as Promise<void>).catch?.(() => {});
            }
          };
          bot.on('physicsTick', this.defendTick);
          return 'Defend mode ON — will auto-attack hostile mobs within 5 blocks';
        } else {
          if (!this.defendActive) return 'Defend mode already off';
          this.defendActive = false;
          if (this.defendTick) {
            bot.off('physicsTick', this.defendTick);
            this.defendTick = null;
          }
          return 'Defend mode OFF';
        }
      }

      case 'place_block': {
        const { x, y, z, block_name } = args as { x: number; y: number; z: number; block_name: string };
        const invItem = bot.inventory.items().find(i => i.name.includes(block_name));
        if (!invItem) return `No ${block_name} in inventory`;

        const faces: Array<{ dx: number; dy: number; dz: number; fx: number; fy: number; fz: number }> = [
          { dx: 0, dy: -1, dz: 0, fx: 0, fy: 1, fz: 0 },
          { dx: 0, dy: 1, dz: 0, fx: 0, fy: -1, fz: 0 },
          { dx: -1, dy: 0, dz: 0, fx: 1, fy: 0, fz: 0 },
          { dx: 1, dy: 0, dz: 0, fx: -1, fy: 0, fz: 0 },
          { dx: 0, dy: 0, dz: -1, fx: 0, fy: 0, fz: 1 },
          { dx: 0, dy: 0, dz: 1, fx: 0, fy: 0, fz: -1 },
        ];

        let refBlock = null;
        let faceVec = null;
        for (const f of faces) {
          const b = bot.blockAt(this.makeVec3(x + f.dx, y + f.dy, z + f.dz));
          if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
            refBlock = b;
            faceVec = this.makeVec3(f.fx, f.fy, f.fz);
            break;
          }
        }
        if (!refBlock || !faceVec) return `No solid adjacent block to place against at (${x}, ${y}, ${z})`;

        const distToTarget = bot.entity.position.distanceTo(this.makeVec3(x, y, z));
        if (distToTarget > 4) await this.navigateTo(x, y, z, 3, 30000);

        await bot.equip(invItem, 'hand');
        await bot.placeBlock(refBlock, faceVec);
        return `Placed ${invItem.name} at (${x}, ${y}, ${z})`;
      }

      case 'activate_block': {
        const { x, y, z } = args as { x: number; y: number; z: number };
        const targetPos = this.makeVec3(x, y, z);
        const block = bot.blockAt(targetPos);
        if (!block || block.name === 'air') return `No block at (${x}, ${y}, ${z})`;

        const dist = bot.entity.position.distanceTo(targetPos);
        if (dist > 4) await this.navigateTo(x, y, z, 3, 30000);

        await bot.lookAt(targetPos);
        await bot.activateBlock(block);
        return `Activated ${block.name} at (${x}, ${y}, ${z})`;
      }

      case 'break_and_collect': {
        const { x, y, z } = args as { x: number; y: number; z: number };
        const targetPos = this.makeVec3(x, y, z);
        const block = bot.blockAt(targetPos);
        if (!block || block.name === 'air') return `No block at (${x}, ${y}, ${z})`;
        const blockName = block.name;
        const harvestTool = this.chooseBestRegistryHarvestTool(block);
        if (harvestTool) {
          const toolPluginApi = (bot as any).tool;
          if (toolPluginApi?.equipForBlock) await toolPluginApi.equipForBlock(block, {});
          else await bot.equip(harvestTool, 'hand');
        } else if (block.harvestTools) {
          return this.summarizeRegistryHarvestRequirement(block);
        }

        if (!bot.canDigBlock(block)) return `Cannot dig ${block.name} (wrong tool or unbreakable)`;

        const collectBlock = (bot as any).collectBlock;
        if (collectBlock?.collect) {
          await collectBlock.collect(block);
          return `Collected ${blockName} at (${x}, ${y}, ${z})`;
        }

        if (bot.entity.position.distanceTo(targetPos) > 4) await this.navigateTo(x, y, z, 2, 30000);
        await bot.dig(block);
        await new Promise<void>(r => setTimeout(r, 600));

        const drop = bot.nearestEntity(e => e.name === 'item' && this.makeVec3(x, y, z).distanceTo(e.position) <= 4);
        if (drop) {
          await this.navigateTo(drop.position.x, drop.position.y, drop.position.z, 1, 10000).catch(() => {});
          await new Promise<void>(r => setTimeout(r, 400));
        }
        return `Broke and collected ${blockName} at (${x}, ${y}, ${z})`;
      }

      case 'eat': {
        const registry = bot.registry as any;
        const foodNames: Set<string> = new Set(Object.keys(registry.foodsByName ?? {}));
        const fallback = [
          'cooked_beef', 'cooked_chicken', 'cooked_pork', 'cooked_mutton',
          'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'bread', 'carrot',
          'baked_potato', 'apple', 'golden_apple', 'beetroot_soup',
          'mushroom_stew', 'rabbit_stew',
        ];
        const food = foodNames.size > 0
          ? bot.inventory.items().find(i => foodNames.has(i.name))
          : bot.inventory.items().find(i => fallback.some(f => i.name.includes(f)));
        if (!food) return 'No food in inventory';
        await bot.equip(food, 'hand');
        await bot.consume();
        return `Ate ${food.name} — hunger now ${bot.food}/20`;
      }

      case 'inspect_chest': {
        const { x, y, z } = args as { x: number; y: number; z: number };
        const pos = this.makeVec3(x, y, z);
        const block = bot.blockAt(pos);
        if (!block) return `No block at (${x}, ${y}, ${z})`;

        if (bot.entity.position.distanceTo(pos) > 4) await this.navigateTo(x, y, z, 2, 30000);
        const container = await (bot as any).openContainer(block);
        const items = container.items() as any[];
        container.close();
        if (!items.length) return `Container at (${x}, ${y}, ${z}) is empty`;
        return `Contents: ${items.map(i => `${i.name}x${i.count}`).join(', ')}`;
      }

      case 'deposit_to_chest': {
        const { x, y, z, item_name, count } = args as { x: number; y: number; z: number; item_name: string; count?: number };
        const pos = this.makeVec3(x, y, z);
        const block = bot.blockAt(pos);
        if (!block) return `No block at (${x}, ${y}, ${z})`;
        const item = bot.inventory.items().find(i => i.name.includes(item_name));
        if (!item) return `No ${item_name} in inventory`;

        if (bot.entity.position.distanceTo(pos) > 4) await this.navigateTo(x, y, z, 2, 30000);
        const container = await (bot as any).openContainer(block);
        const depositCount = count ?? item.count;
        await container.deposit(item.type, null, depositCount);
        container.close();
        return `Deposited ${depositCount}x ${item.name} into chest at (${x}, ${y}, ${z})`;
      }

      case 'withdraw_from_chest': {
        const { x, y, z, item_name, count } = args as { x: number; y: number; z: number; item_name: string; count?: number };
        const pos = this.makeVec3(x, y, z);
        const block = bot.blockAt(pos);
        if (!block) return `No block at (${x}, ${y}, ${z})`;

        if (bot.entity.position.distanceTo(pos) > 4) await this.navigateTo(x, y, z, 2, 30000);
        const container = await (bot as any).openContainer(block);
        const chestItem = (container.items() as any[]).find(i => i.name.includes(item_name));
        if (!chestItem) {
          container.close();
          return `No ${item_name} in chest at (${x}, ${y}, ${z})`;
        }
        const withdrawCount = count ?? chestItem.count;
        await container.withdraw(chestItem.type, null, withdrawCount);
        container.close();
        return `Withdrew ${withdrawCount}x ${chestItem.name} from chest at (${x}, ${y}, ${z})`;
      }

      case 'smelt_item': {
        const { item_name, count = 1 } = args as { item_name: string; count?: number };
        const inputItem = bot.inventory.items().find(i => i.name.includes(item_name));
        if (!inputItem) return `No ${item_name} in inventory`;

        const furnaceBlockNames = ['furnace', 'blast_furnace', 'smoker'];
        let furnacePos = null;
        for (const name of furnaceBlockNames) {
          const type = bot.registry.blocksByName[name];
          if (!type) continue;
          const found = bot.findBlocks({ matching: type.id, maxDistance: 32, count: 1 });
          if (found.length) { furnacePos = found[0]; break; }
        }
        if (!furnacePos) return 'No furnace found within 32 blocks';

        await this.navigateTo(furnacePos.x, furnacePos.y, furnacePos.z, 2, 30000);
        const furnaceBlock = bot.blockAt(furnacePos);
        if (!furnaceBlock) return 'Furnace block not found';

        const furnace = await bot.openFurnace(furnaceBlock);
        try {
          if (!furnace.fuelItem()) {
            const fuelItem = bot.inventory.items().find(i =>
              i.name.includes('coal') || i.name.includes('charcoal') ||
              i.name.includes('log') || i.name.includes('plank')
            );
            if (!fuelItem) { furnace.close(); return 'No fuel in inventory (need coal, charcoal, or wood)'; }
            const fuelNeeded = Math.ceil((count as number) / 8);
            await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, fuelNeeded + 1));
          }
          await furnace.putInput(inputItem.type, null, count as number);

          const timeoutMs = (count as number) * 12000 + 8000;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              furnace.removeAllListeners('update');
              reject(new Error('Smelting timed out'));
            }, timeoutMs);
            const check = () => {
              if (furnace.outputItem()) {
                clearTimeout(timer);
                furnace.removeAllListeners('update');
                resolve();
              }
            };
            furnace.on('update', check);
            check();
          });

          const output = await furnace.takeOutput();
          furnace.close();
          return `Smelted ${inputItem.name} → ${output?.name ?? 'item'} x${output?.count ?? 1}`;
        } catch (err) {
          furnace.close();
          throw err;
        }
      }

      case 'get_weather': {
        const botAny = bot as any;
        if (botAny.thunderState > 0.5) return 'Thunderstorm';
        if (bot.isRaining) return `Raining (intensity ${((botAny.rainState ?? 1) * 100).toFixed(0)}%)`;
        return 'Clear';
      }

      case 'get_biome': {
        const dimension = bot.game.dimension;
        const p = bot.entity.position;
        try {
          const biomeId = (bot as any).world?.getBiome?.(p.x, p.y, p.z)
            ?? (bot as any).world?.getColumn?.(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4)
              ?.getBiome?.(Math.floor(p.x) & 15, Math.floor(p.y), Math.floor(p.z) & 15);
          if (biomeId != null) {
            const biome = (bot.registry as any).biomes?.[biomeId];
            const biomeName = biome?.name ?? `id:${biomeId}`;
            return `Biome: ${biomeName}, Dimension: ${dimension}`;
          }
        } catch { /* biome API varies by version */ }
        const surfaceBlock = bot.blockAt(p.offset(0, -1, 0));
        return `Dimension: ${dimension}, Surface: ${surfaceBlock?.name ?? 'unknown'} (biome unavailable)`;
      }

      case 'get_nearby_blocks': {
        const { radius = 8 } = args as { radius?: number };
        const r = Math.min(radius as number, 16);
        const base = bot.entity.position.floored();
        const counts: Record<string, number> = {};
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dz = -r; dz <= r; dz++) {
              const b = bot.blockAt(base.offset(dx, dy, dz), false);
              if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue;
              counts[b.name] = (counts[b.name] ?? 0) + 1;
            }
          }
        }
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20);
        if (!sorted.length) return 'No blocks found nearby';
        return sorted.map(([n, c]) => `${n}(${c})`).join(', ');
      }

      case 'sleep_in_bed': {
        const bedIds = Object.values(bot.registry.blocksByName)
          .filter(b => b.name.endsWith('_bed'))
          .map(b => b.id);
        if (!bedIds.length) return 'No bed block types in registry';

        const positions = bot.findBlocks({ matching: bedIds, maxDistance: 32, count: 1 });
        if (!positions.length) return 'No bed found within 32 blocks';

        await this.navigateTo(positions[0].x, positions[0].y, positions[0].z, 2, 30000);
        const bedBlock = bot.blockAt(positions[0]);
        if (!bedBlock) return 'Bed block not found';

        await bot.sleep(bedBlock);
        return 'Sleeping...';
      }

      case 'use_item': {
        const { item_name, offhand = false } = args as { item_name?: string; offhand?: boolean };
        if (item_name) {
          const item = bot.inventory.items().find(i => i.name.includes(item_name as string));
          if (!item) return `No ${item_name} in inventory`;
          await bot.equip(item, offhand ? 'off-hand' : 'hand');
        }
        bot.activateItem(offhand as boolean);
        await new Promise<void>(r => setTimeout(r, 500));
        bot.deactivateItem();
        return 'Used item';
      }

      case 'pick_up_items': {
        const { max_distance = 16 } = args as { max_distance?: number };
        const dropped = Object.values(bot.entities).filter(e => {
          if (e.name !== 'item') return false;
          return bot.entity!.position.distanceTo(e.position) <= (max_distance as number);
        });
        if (!dropped.length) return 'No dropped items nearby';
        let collected = 0;
        for (const item of dropped.slice(0, 8)) {
          try {
            await this.navigateTo(item.position.x, item.position.y, item.position.z, 1, 8000);
            await new Promise<void>(r => setTimeout(r, 300));
            collected++;
          } catch { /* item may have moved or despawned */ }
        }
        return `Collected ${collected} item(s)`;
      }

      case 'set_home': {
        const p = bot.entity.position;
        this.homePosition = { x: p.x, y: p.y, z: p.z };
        this.memory.home = { x: p.x, y: p.y, z: p.z, dimension: bot.game.dimension, label: 'home' };
        this.saveMemory();
        return `Home set at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
      }

      case 'go_home': {
        if (!this.homePosition && this.memory.home) {
          this.homePosition = { x: this.memory.home.x, y: this.memory.home.y, z: this.memory.home.z };
        }
        if (!this.homePosition) return 'No home set — use set_home first';
        const { x, y, z } = this.homePosition;
        await this.navigateTo(x, y, z, 2, 60000);
        return `Arrived home at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`;
      }

      case 'write_note': {
        const { key, value } = args as { key: string; value: string };
        this.notes.set(key, value);
        this.saveMemory();
        return `Note saved: "${key}"`;
      }

      case 'read_notes': {
        if (!this.notes.size) return 'No notes saved yet';
        return Array.from(this.notes.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n');
      }

      // ───────── Build control ─────────

      case 'build_demolish': {
        if (!this.builder.hasActive()) return 'Nothing to demolish';
        const status = await this.builder.demolish(s => this.onBuildStatus?.(s));
        return status.phase === 'error' ? `Demolish failed: ${status.message}` : 'Demolished';
      }

      case 'build_cancel': {
        this.builder.cancelBuild();
        this.emitBuildStatus();
        return 'Build cancelled';
      }

      case 'build_status': {
        return JSON.stringify(this.builder.getStatus());
      }

      case 'quick_setblock': {
        const { x, y, z, block } = args as { x: number; y: number; z: number; block: string };
        await this.builder.setBlockAt(x, y, z, block);
        return `setblock ${block} at (${x},${y},${z})`;
      }

      case 'quick_fill': {
        const { x1, y1, z1, x2, y2, z2, block, hollow = false } = args as {
          x1: number; y1: number; z1: number;
          x2: number; y2: number; z2: number;
          block: string; hollow?: boolean;
        };
        const n = await this.builder.fillRegion(x1, y1, z1, x2, y2, z2, block, hollow as boolean);
        return `Filled ${n} blocks with ${block}${hollow ? ' (hollow)' : ''}`;
      }

      case 'quick_clear': {
        const { x1, y1, z1, x2, y2, z2 } = args as {
          x1: number; y1: number; z1: number;
          x2: number; y2: number; z2: number;
        };
        const n = await this.builder.clearRegion(x1, y1, z1, x2, y2, z2);
        return `Cleared ${n} blocks`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }
}
