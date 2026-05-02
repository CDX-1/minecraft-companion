import OpenAI from 'openai';
import type { Bot } from 'mineflayer';
import { Movements, goals } from 'mineflayer-pathfinder';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

const SYSTEM_PROMPT = `You are a smart, helpful Minecraft bot companion. You can perceive and interact with the Minecraft world using your tools.

Rules:
- Keep ALL chat responses under 100 characters (hard Minecraft limit)
- Use tools proactively and in sequence to accomplish complex tasks
- move_to WAITS until you arrive, so chaining move_to → dig_block works
- Use get_position and find_blocks to get coordinates before moving or digging
- If asked to gather resources, find them first with find_blocks, then navigate and dig
- Be friendly and brief — the player can see what you're doing`;

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
];

export class MinecraftAgent {
  private openai: OpenAI;
  private movements: Movements | null = null;

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

  async handleMessage(message: string, sender: string): Promise<string> {
    const pos = this.bot.entity?.position;
    const state = pos
      ? `Position: x=${pos.x.toFixed(1)}, y=${pos.y.toFixed(1)}, z=${pos.z.toFixed(1)} | Health: ${(this.bot.health ?? 0).toFixed(0)}/20 | Food: ${this.bot.food ?? 0}/20`
      : 'Not yet spawned';

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\nCurrent state: ${state}` },
      { role: 'user', content: `${sender} says: "${message}"` },
    ];

    let iterations = 0;
    while (iterations++ < 12) {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: 200,
      });

      const choice = response.choices[0];
      messages.push(choice.message);

      if (!choice.message.tool_calls?.length) {
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

      default:
        return `Unknown tool: ${name}`;
    }
  }
}
