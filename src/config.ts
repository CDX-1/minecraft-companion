export interface BotConfig {
  host: string;
  port: number;
  username: string;
  ignoredUsernames: string[];
  auth: 'offline' | 'microsoft';
  voiceEnabled: boolean;
  ownerUsername?: string;
  voicePort: number;
  voiceAutoOpen: boolean;
  elevenLabsEnabled: boolean;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsModelId?: string;
  elevenLabsStability: number;
  elevenLabsSimilarityBoost: number;
  elevenLabsStreaming: boolean;
  elevenLabsLatency: number;
}
