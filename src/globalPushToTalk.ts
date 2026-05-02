import { GlobalKeyboardListener, IGlobalKeyEvent, IGlobalKeyListener } from 'node-global-key-listener';

export interface GlobalPushToTalkOptions {
  key?: string;
  onStart: () => void;
  onStop: () => void;
  onStatus?: (message: string) => void;
  onError?: (message: string) => void;
}

export interface GlobalPushToTalk {
  close: () => void;
}

export function isPushToTalkKey(event: Pick<IGlobalKeyEvent, 'name' | 'rawKey'>, key = 'V'): boolean {
  const wanted = key.toUpperCase();
  return event.name?.toUpperCase() === wanted || event.rawKey?.name?.toUpperCase() === wanted;
}

export async function startGlobalPushToTalk(options: GlobalPushToTalkOptions): Promise<GlobalPushToTalk> {
  const key = options.key ?? 'V';
  const keyboard = new GlobalKeyboardListener({
    mac: {
      onError: (errorCode) => options.onError?.(`global keyboard mac error: ${errorCode}`),
    },
    windows: {
      onError: (errorCode) => options.onError?.(`global keyboard windows error: ${errorCode}`),
      onInfo: (info) => options.onStatus?.(`global keyboard: ${info}`),
    },
  });

  let active = false;

  const listener: IGlobalKeyListener = (event) => {
    if (!isPushToTalkKey(event, key)) return false;

    if (event.state === 'DOWN' && !active) {
      active = true;
      options.onStart();
    } else if (event.state === 'UP' && active) {
      active = false;
      options.onStop();
    }

    return false;
  };

  await keyboard.addListener(listener);
  options.onStatus?.(`Global push-to-talk armed: hold ${key.toUpperCase()}`);

  return {
    close: () => {
      if (active) {
        active = false;
        options.onStop();
      }
      keyboard.removeListener(listener);
      keyboard.kill();
    },
  };
}
