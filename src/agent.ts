import OpenAI from 'openai';
import type { Bot } from 'mineflayer';
import { Movements, goals } from 'mineflayer-pathfinder';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch',
  'blaze', 'ghast', 'slime', 'magma_cube', 'enderman', 'endermite',
  'silverfish', 'guardian', 'elder_guardian', 'wither_skeleton',
  'stray', 'husk', 'drowned', 'phantom', 'pillager', 'vindicator',
  'evoker', 'ravager', 'vex', 'shulker', 'hoglin', 'piglin_brute',
  'zoglin', 'warden', 'breeze',
]);

const SYSTEM_PROMPT = `You are an intelligent, proactive Minecraft bot. You have full awareness of your surroundings and take every step needed to accomplish a goal — you never give up without trying.

REASONING APPROACH:
Before acting, silently reason: what do I need? do I have it? if not, where do I get it? then execute step by step.

SITUATIONAL AWARENESS — always check before concluding you can't do something:
- Need an item? Check inventory (find_item) first. Not there? Search the world (find_blocks), navigate, and collect it.
- Need to craft? Verify ingredients with find_item. Missing any? Gather them first, then craft.
- Need to go somewhere? Use find_blocks or find_entities to locate it, then move_to.
- Blocked or stuck? Try an alternate path, dig through, or find another route.

EXECUTION RULES:
- Tool calls execute ONE AT A TIME in sequence — plan your chain upfront, then fire each step
- move_to WAITS until arrival — safe to chain: move_to → dig_block → move_to → craft_item
- craft_item auto-navigates to a nearby crafting table if the recipe needs one
- dig_block auto-navigates if the block is out of reach
- If a tool call fails, read the error and adapt — don't repeat the same failing call
- Keep chaining tool calls until the task is fully complete — never stop halfway
- Never call move_to and any action tool in the same step; arrive first, then act

PERSONA:
You are a friendly, capable companion — not a system. Speak naturally, like a helpful friend.
Your text response IS the chat message the player sees, so make it feel human, not robotic.

GOOD responses: "on it!", "grabbed some wood, making a pickaxe now", "done! found diamonds at -45 11 23"
BAD responses: "Executing navigation protocol", "Task completed successfully", "Initiating pathfinding sequence", "I have located the resources and will now proceed"

TOOL SELECTION GUIDE:
- Collecting blocks: break_and_collect gets the drop; dig_block just digs (use when drop doesn't matter)
- Combat: kill_entity fights until dead; attack_entity is one hit (use for tagging or finishing)
- Hostile areas: turn defend_self ON before exploring caves/nether, OFF when done
- Chests: inspect_chest to see contents first, then deposit_to_chest or withdraw_from_chest
- Hunger: eat when food drops below 15/20; do it proactively before long tasks
- Consumables / special items: use_item for potions, ender pearls, fishing rod, flint and steel, bone meal
- Home: set_home at your base once, go_home to return from anywhere
- Smelting: smelt_item handles the whole process — fuel, waiting, output

CHAT RULES:
- Keep every chat message under 100 characters (hard Minecraft limit)
- One short sentence max — casual and direct
- Only reply once at the end, never narrate each step`;

const TOOLS: ChatCompletionTool[] = [
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
];

export class MinecraftAgent {
  private openai: OpenAI;
  private movements: Movements | null = null;
  private history: ChatCompletionMessageParam[] = [];
  private readonly HISTORY_LIMIT = 24;
  private homePosition: { x: number; y: number; z: number } | null = null;
  private defendActive = false;
  private defendTick: (() => void) | null = null;
  private lastDefendAttack = 0;

  constructor(
    private bot: Bot,
    apiKey: string,
    private log: (msg: string) => void
  ) {
    this.openai = new OpenAI({ apiKey });
  }

  private getMovements(): Movements {
    if (!this.movements) this.movements = new Movements(this.bot);
    return this.movements;
  }

  private tryFastPath(message: string, sender: string): string | null {
    const lower = message.toLowerCase().trim();

    if (/\b(follow me|follow|come with me)\b/.test(lower)) {
      const target = this.bot.players[sender]?.entity;
      if (!target) return "I can't see you.";
      this.bot.pathfinder.setMovements(this.getMovements());
      this.bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
      return 'Following you!';
    }

    if (/\b(stop|halt|stay|wait here)\b/.test(lower)) {
      this.bot.pathfinder.stop();
      this.bot.clearControlStates();
      return 'Stopped.';
    }

    if (/\b(come here|come to me)\b/.test(lower)) {
      const target = this.bot.players[sender]?.entity;
      if (!target) return "I can't see you.";
      const p = target.position;
      this.navigateTo(p.x, p.y, p.z, 2).catch(() => {});
      return 'On my way!';
    }

    if (/^(hi|hello|hey)$/.test(lower)) {
      return 'Hey!';
    }

    return null;
  }

  async handleMessage(message: string, sender: string): Promise<string> {
    const fast = this.tryFastPath(message, sender);
    if (fast !== null) return fast;

    const bot = this.bot;
    const pos = bot.entity?.position;

    const invItems = bot.inventory.items();
    const invSummary = invItems.length
      ? invItems.map(i => `${i.name}x${i.count}`).join(', ')
      : 'empty';

    const timeOfDay = bot.time?.timeOfDay ?? 0;
    const timeLabel = timeOfDay < 13000 ? 'day' : 'night';

    const state = pos
      ? `Position: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) | Health: ${(bot.health ?? 0).toFixed(0)}/20 | Food: ${bot.food ?? 0}/20 | Time: ${timeLabel} | Inventory: ${invSummary}`
      : 'Not yet spawned';

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\nCurrent state: ${state}` },
      ...this.history,
      { role: 'user', content: `${sender} says: "${message}"` },
    ];

    let iterations = 0;
    while (iterations++ < 16) {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4.1-mini',
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
      bot.pathfinder.setMovements(this.getMovements());

      const timeoutId = setTimeout(() => {
        bot.removeListener('goal_reached', onReached);
        bot.pathfinder.stop();
        reject(new Error('Navigation timed out'));
      }, timeoutMs);

      const onReached = () => {
        clearTimeout(timeoutId);
        resolve();
      };

      bot.once('goal_reached', onReached);
      bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
    });
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const bot = this.bot;
    if (!bot.entity) return 'Bot is not spawned yet';

    switch (name) {
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
        bot.pathfinder.setMovements(this.getMovements());
        bot.pathfinder.setGoal(new goals.GoalFollow(target, range as number), true);
        return `Following ${username}`;
      }

      case 'stop_moving': {
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

        const weapons = bot.inventory.items().filter(i => i.name.includes('sword') || i.name.includes('axe'));
        if (weapons.length) await bot.equip(weapons[0], 'hand');

        const targetId = target.id;
        const label = target.name ?? target.displayName ?? target.username ?? entity_name;

        return new Promise<string>(resolve => {
          const timeout = setTimeout(() => {
            bot.off('physicsTick', onTick);
            resolve(`Stopped attacking ${label} (timed out)`);
          }, 30000);

          let lastAttack = 0;
          const onTick = async () => {
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
            const d = bot.entity!.position.distanceTo(e.position);
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
        if (!bot.canDigBlock(block)) return `Cannot dig ${block.name} (wrong tool or unbreakable)`;
        const blockName = block.name;

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
        return `Home set at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
      }

      case 'go_home': {
        if (!this.homePosition) return 'No home set — use set_home first';
        const { x, y, z } = this.homePosition;
        await this.navigateTo(x, y, z, 2, 60000);
        return `Arrived home at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }
}
