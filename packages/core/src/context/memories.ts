export const MEMORY_LIMIT = 20;
export const MEMORY_TOKEN_BUDGET = 2000;

/** Input is newest first. The budget includes separators and truncation notice. */
export function formatRepoMemories(memories: readonly { content: string }[]): string | undefined {
  if (!memories.length) return undefined;
  const text = memories.slice(0, MEMORY_LIMIT).map((m) => `- ${m.content}`).join("\n");
  const maxChars = MEMORY_TOKEN_BUDGET * 4;
  const notice = "\n[Repository memories truncated to the context budget.]";
  return text.length <= maxChars ? text : text.slice(0, maxChars - notice.length) + notice;
}
