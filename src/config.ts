export interface BotConfig {
  host: string;
  port: number;
  username: string;
  auth: 'offline' | 'microsoft';
  voiceEnabled: boolean;
  ownerUsername?: string;
  voicePort: number;
}
