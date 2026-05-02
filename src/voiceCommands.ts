import { parseChatCommand } from './commands';

export interface VoiceCommandActions {
  characterName: string;
  ownerUsername?: string;
  sayHello: () => void;
  follow: (username: string) => void;
}

export function handleVoiceTranscript(transcript: string, actions: VoiceCommandActions): boolean {
  const command = parseChatCommand(transcript, actions.characterName);

  if (command === 'greet') {
    actions.sayHello();
    return true;
  }

  if (command === 'follow') {
    if (!actions.ownerUsername) return false;
    actions.follow(actions.ownerUsername);
    return true;
  }

  return false;
}
