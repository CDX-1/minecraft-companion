export type LlmProvider = 'openai' | 'gemini';
export type Personality = 'friendly' | 'flirty' | 'tsundere' | 'arrogant';
export type AutonomyLevel = 'passive' | 'balanced' | 'proactive';

export interface MinecraftAgentOptions {
  provider: LlmProvider;
  apiKey: string;
  openaiModel?: string;
  geminiModel?: string;
  personality?: Personality;
  companionName?: string;
  companionBio?: string;
  autonomyLevel?: AutonomyLevel;
  ownerUsername?: string;
  buildCrew?: {
    enabled: boolean;
    host: string;
    port: number;
    auth: 'offline' | 'microsoft';
    mainUsername: string;
    size: number;
  };
}

export type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
};

export type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

export type GeminiGenerateContentResponse = {
  candidates?: Array<{ content?: GeminiContent }>;
  error?: { message?: string };
};

export type StoredPosition = { x: number; y: number; z: number; dimension?: string; label?: string };
export type ActiveTask = { goal: string; plan: string[]; progress: string[]; startedAt: string; updatedAt: string };
export type NavigationGoal = { id: number; x: number; y: number; z: number; range: number };
export type FollowGoal = { username: string; range: number };

export type AgentMemory = {
  version: 1;
  owner?: string;
  home?: StoredPosition;
  knownChests: StoredPosition[];
  knownResources: StoredPosition[];
  avoidAreas: Array<StoredPosition & { reason: string }>;
  notes: Record<string, string>;
  activeTask?: ActiveTask;
};

export const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch',
  'blaze', 'ghast', 'slime', 'magma_cube', 'enderman', 'endermite',
  'silverfish', 'guardian', 'elder_guardian', 'wither_skeleton',
  'stray', 'husk', 'drowned', 'phantom', 'pillager', 'vindicator',
  'evoker', 'ravager', 'vex', 'shulker', 'hoglin', 'piglin_brute',
  'zoglin', 'warden', 'breeze',
]);

export const FAST_PATH_RESPONSES: Record<string, Record<Personality, string>> = {
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
