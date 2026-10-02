/**
 * Comments addressed to the bot. Exact keyword commands are parsed here with no
 * model call; any other text after the mention is `freeform` and is routed by a
 * small model in the worker (llm/route.ts). Ordinary mentions that don't lead
 * the comment never execute.
 */
export type AgentCommand =
  | { type: "remember"; text: string }
  | { type: "forget"; match: string }
  | { type: "regenerate" }
  | { type: "focus"; areas: string }
  | { type: "create-issue" }
  | { type: "freeform"; text: string }
  | { type: "help" };

export const MAX_MEMORY_CHARS = 2000;
export const MAX_FOCUS_CHARS = 1000;
export const MAX_FREEFORM_CHARS = 2000;

export function parseAgentCommand(body: string, slug: string): AgentCommand | null {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Require the mention to lead the comment; quoted examples must not execute.
  const mention = new RegExp(`^\\s*@${escaped}(?:\\[bot\\])?(?=\\s|$)`, "i").exec(body);
  if (!mention) return null;
  const command = body.slice(mention[0].length).trim();
  if (/^regenerate$/i.test(command)) return { type: "regenerate" };
  if (/^create (?:an? |the )?(?:tracking )?issues?$/i.test(command)) return { type: "create-issue" };
  const remember = /^remember:\s*([\s\S]+)$/i.exec(command)?.[1]?.trim();
  if (remember && remember.length <= MAX_MEMORY_CHARS) return { type: "remember", text: remember };
  const forget = /^forget\s+([\s\S]+)$/i.exec(command)?.[1]?.trim();
  if (forget && forget.length <= MAX_MEMORY_CHARS) return { type: "forget", match: forget };
  const focus = /^focus:\s*([\s\S]+)$/i.exec(command)?.[1]?.trim();
  if (focus && focus.length <= MAX_FOCUS_CHARS) return { type: "focus", areas: focus };
  // A keyword command with a missing or oversized argument is a mistake to
  // explain, not text to reinterpret.
  if (!command || /^(?:remember:|focus:|forget$)/i.test(command) || command.length > MAX_FREEFORM_CHARS) return { type: "help" };
  return { type: "freeform", text: command };
}

export function commandHelp(slug: string): string {
  return `Tell me what you need in plain language, or use an exact command (repository write/admin access required):\n\n- \`@${slug} remember: <text>\` — save repository guidance (up to 2,000 characters).\n- \`@${slug} forget <match>\` — deactivate memories containing this literal text (case-insensitive).\n- \`@${slug} regenerate\` — regenerate the current PR head.\n- \`@${slug} focus: <areas>\` — regenerate with one-time emphasis (up to 1,000 characters).\n- \`@${slug} create issue\` — open (or update) one tracking issue with this plan as a checklist.\n\nStart your comment with the mention. Memories apply to future plans; use regenerate to update this one.`;
}
