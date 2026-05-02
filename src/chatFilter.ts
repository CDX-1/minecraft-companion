export function parseIgnoredUsernames(value?: string): string[] {
  if (!value) return [];

  return value
    .split(',')
    .map((username) => username.trim())
    .filter(Boolean);
}

export function shouldIgnoreChatSender(
  username: string,
  selfUsername: string,
  ignoredUsernames: readonly string[] = []
): boolean {
  const normalizedUsername = username.trim().toLowerCase();
  const ignored = new Set([
    selfUsername.trim().toLowerCase(),
    ...ignoredUsernames.map((ignoredUsername) => ignoredUsername.trim().toLowerCase()),
  ]);

  return ignored.has(normalizedUsername);
}
