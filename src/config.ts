export type Personality = 'friendly' | 'flirty' | 'tsundere' | 'arrogant';

export interface BotConfig {
  host: string;
  port: number;
  username: string;
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
}
