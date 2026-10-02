/** Explicit commands only: ordinary mentions and malformed commands get help. */
export type AgentCommand =
  | { type: "remember"; text: string }
  | { type: "forget"; match: string }
  | { type: "regenerate" }
  | { type: "focus"; areas: string }
  | { type: "help" };

export function parseAgentCommand(body: string, slug: string): AgentCommand | null {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Require the mention to lead the comment; quoted examples must not execute.
  const mention = new RegExp(`^\\s*@${escaped}(?:\\[bot\\])?(?=\\s|$)`, "i").exec(body);
  if (!mention) return null;
  const command = body.slice(mention[0].length).trim();
  if (/^regenerate$/i.test(command)) return { type: "regenerate" };
  const remember = /^remember:\s*([\s\S]+)$/i.exec(command)?.[1]?.trim();
  if (remember && remember.length <= 2000) return { type: "remember", text: remember };
  const forget = /^forget\s+([\s\S]+)$/i.exec(command)?.[1]?.trim();
  if (forget && forget.length <= 2000) return { type: "forget", match: forget };
  const focus = /^focus:\s*([\s\S]+)$/i.exec(command)?.[1]?.trim();
  if (focus && focus.length <= 1000) return { type: "focus", areas: focus };
  return { type: "help" };
}

export function commandHelp(slug: string): string {
  return `Commands (repository write/admin access required):\n\n- \`@${slug} remember: <text>\` — save repository guidance (up to 2,000 characters).\n- \`@${slug} forget <match>\` — deactivate memories containing this literal text (case-insensitive).\n- \`@${slug} regenerate\` — regenerate the current PR head.\n- \`@${slug} focus: <areas>\` — regenerate with one-time emphasis (up to 1,000 characters).\n\nStart your comment with the mention. Memories apply to future plans; use regenerate to update this one.`;
}
