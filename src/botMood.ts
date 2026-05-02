/** Classify picked-up stacks and classify damage mood impact. Keeps companion mood 0–100. */

export interface MoodTracker {
  readonly getScore: () => number;
  /** Apply a delta (-100…100-ish, clamped) and optionally log once. */
  readonly bump: (delta: number, reason: string) => void;
  /** Call when inventory picks up something (gift vs junk vs nasty). */
  readonly onCollectedItemId: (itemId: string | undefined) => void;
  dispose: () => void;
}

const FLOWERISH =
  /_tulip|_orchid|dandelion|poppy|cornflower|blue_orchid|allium|azure_bluet|oxeye_daisy|lily_of_the_valley|sunflower|wither_rose|torchflower|pitcher_|eyeblossom|spore_blossom|azalea|mangrove_propagule|flowering_azalea/;

export function classifyGiftMoodDelta(itemId: string | undefined): number {
  const n = (itemId ?? '').replace(/^minecraft:/i, '').toLowerCase();
  if (!n) return 0;

  if (
    [
      'rotten_flesh',
      'poisonous_potato',
      'spider_eye',
      'pufferfish',
      'suspicious_stew',
    ].includes(n)
  ) {
    return -18;
  }
  if (/wither_rose/i.test(n)) return 12;

  if (FLOWERISH.test(n) || /_flowers$/i.test(n)) return 20;
  if (/_sapling$/i.test(n) || n === 'bamboo' || n === 'sweet_berries') return 14;
  if (n.endsWith('_banner_pattern') || n.includes('gift')) return 15;

  if (
    ['cake', 'cookie', 'bread', 'pumpkin_pie', 'honeycomb', 'honey_bottle'].includes(n) ||
    /^cooked_/.test(n) ||
    /^golden_/.test(n) ||
    n === 'enchanted_golden_apple' ||
    n === 'beetroot_soup' ||
    n === 'mushroom_stew' ||
    n === 'rabbit_stew'
  ) {
    return 16;
  }

  if (
    [
      'diamond',
      'emerald',
      'gold_ingot',
      'nether_star',
      'totem_of_undying',
      'amethyst_shard',
    ].includes(n) ||
    n.endsWith('_ore')
  ) {
    return 12;
  }

  if (/^raw_(iron|copper|gold)$/.test(n) || ['coal', 'charcoal'].includes(n)) return 6;
  if (['oak_log', 'spruce_log', 'birch_log', 'snowball', 'string'].includes(n)) return 4;

  /** Common mined junk — avoids mood maxing during collect-block sessions. */
  if (
    [
      'cobblestone',
      'stone',
      'dirt',
      'andesite',
      'diorite',
      'granite',
      'gravel',
      'sand',
      'netherrack',
      'end_stone',
      'deep_slate',
      'coal_ore',
      'iron_ore',
      'nether_brick',
      'brown_terracotta',
    ].includes(n) ||
    n.endsWith('_planks')
  ) {
    return 0;
  }

  return 10;
}

export function classifyDamageMoodDelta(lostHp: number, _maxHp: number): number {
  if (lostHp <= 0) return 0;
  const scaled = -Math.ceil(lostHp * 6 + 4);
  return Math.max(scaled, -35);
}

export function createMoodTracker(options?: {
  log?: (message: string) => void;
  initial?: number;
  decayIntervalMs?: number;
  onScoreChange?: (score: number) => void;
}): MoodTracker {
  let mood = clampScore(options?.initial ?? 54);
  let decayTimer: NodeJS.Timeout | null = null;
  const interval = options?.decayIntervalMs ?? 90_000;

  function clampScore(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function pushScore(reason: string) {
    mood = clampScore(mood);
    options?.log?.(`mood ${mood}${reason ? ` (${reason})` : ''}`);
    options?.onScoreChange?.(mood);
  }

  decayTimer = setInterval(() => {
    if (mood === 50) return;
    const step = mood > 50 ? -1 : 1;
    mood = clampScore(mood + step);
    options?.onScoreChange?.(mood);
  }, interval);

  return {
    getScore: () => mood,
    bump(delta, reason) {
      const next = clampScore(mood + delta);
      if (next === mood) return;
      mood = next;
      pushScore(reason);
    },
    onCollectedItemId(itemId) {
      const delta = classifyGiftMoodDelta(itemId);
      if (!delta) return;
      const next = clampScore(mood + delta);
      if (next === mood) return;
      mood = next;
      const label = itemId?.replace(/^minecraft:/i, '') ?? '?';
      pushScore(`${delta >= 0 ? '+' : ''}${delta} pickup ${label}`);
    },
    dispose() {
      if (decayTimer) clearInterval(decayTimer);
      decayTimer = null;
    },
  };
}
