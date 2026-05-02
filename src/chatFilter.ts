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
  ignoredUsernames: readonly string[] = [],
  ownerUsername?: string
): boolean {
  const normalizedUsername = username.trim().toLowerCase();
  const normalizedOwnerUsername = ownerUsername?.trim().toLowerCase();

  if (normalizedOwnerUsername && normalizedUsername !== normalizedOwnerUsername) {
    return true;
  }

  const ignored = new Set([
    selfUsername.trim().toLowerCase(),
    ...ignoredUsernames.map((ignoredUsername) => ignoredUsername.trim().toLowerCase()),
  ]);

  return ignored.has(normalizedUsername);
}
