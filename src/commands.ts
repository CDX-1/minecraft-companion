export type ChatCommand = 'greet' | 'follow';

export function parseChatCommand(message: string, characterName?: string): ChatCommand | null {
  const normalizedMessage = message.trim().toLowerCase();
  const normalizedCharacterName = characterName?.trim().toLowerCase();

  if (
    normalizedMessage === 'hi' ||
    normalizedMessage === 'hello' ||
    (normalizedCharacterName ? normalizedMessage === `hey ${normalizedCharacterName}` : false)
  ) {
    return 'greet';
  }

  if (normalizedMessage === 'follow me') {
    return 'follow';
  }

  return null;
}
