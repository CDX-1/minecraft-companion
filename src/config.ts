export interface BotConfig {
  host: string;
  port: number;
  username: string;
  auth: 'offline' | 'microsoft';
}
