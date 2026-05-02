export type Personality = 'friendly' | 'flirty' | 'tsundere' | 'arrogant';
export type AutonomyLevel = 'passive' | 'balanced' | 'proactive';

export interface BotConfig {
  host: string;
  port: number;
  username: string;
  companionName?: string;
  companionBio?: string;
  autonomyLevel: AutonomyLevel;
  personality: Personality;
  ignoredUsernames: string[];
  auth: 'offline' | 'microsoft';
  voiceEnabled: boolean;
  ownerUsername?: string;
  voicePort: number;
  elevenLabsEnabled: boolean;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsModelId?: string;
  elevenLabsStability: number;
  elevenLabsSimilarityBoost: number;
  elevenLabsStreaming: boolean;
  elevenLabsLatency: number;
  buildCrewEnabled: boolean;
  buildCrewSize: number;
  skinUsername?: string;
}

export function isVoiceEnabledFromEnv(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== 'false';
}
