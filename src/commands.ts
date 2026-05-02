export type ChatCommand = 'greet' | 'follow';

export function parseChatCommand(message: string): ChatCommand | null {
  const normalizedMessage = message.trim().toLowerCase();

  if (normalizedMessage === 'hi' || normalizedMessage === 'hello') {
    return 'greet';
  }

  if (normalizedMessage === 'follow me') {
    return 'follow';
  }

  return null;
}
