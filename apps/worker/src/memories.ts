import { MEMORY_LIMIT, type CommandJob } from "@oxyqa/core";
import { repoMemories, type Database } from "@oxyqa/db";
import { and, desc, eq, ilike } from "drizzle-orm";

type RepoScope = Pick<CommandJob, "installationId" | "owner" | "repo">;
// GitHub repository names are case-insensitive; normalize writes and reads.
export function memoryScope(scope: RepoScope) {
  return and(eq(repoMemories.installationId, scope.installationId),
    eq(repoMemories.owner, scope.owner.toLowerCase()), eq(repoMemories.repo, scope.repo.toLowerCase()));
}
export function literalPattern(match: string) {
  return `%${match.replace(/[\\%_]/g, "\\$&")}%`;
}
export function createMemoryStore(db: Database) {
  return {
    async remember(job: CommandJob, content: string) {
      await db.insert(repoMemories).values({
        installationId: job.installationId, owner: job.owner.toLowerCase(), repo: job.repo.toLowerCase(),
        content, source: "command", createdBy: job.actor, sourceCommentId: job.commentId,
      }).onConflictDoNothing({ target: [repoMemories.installationId, repoMemories.sourceCommentId] });
    },
    async forget(scope: RepoScope, match: string) {
      const rows = await db.update(repoMemories).set({ active: false })
        .where(and(memoryScope(scope), eq(repoMemories.active, true), ilike(repoMemories.content, literalPattern(match))))
        .returning({ id: repoMemories.id });
      return rows.length;
    },
    async load(scope: RepoScope) {
      return db.select({ content: repoMemories.content }).from(repoMemories)
        .where(and(memoryScope(scope), eq(repoMemories.active, true)))
        .orderBy(desc(repoMemories.createdAt), desc(repoMemories.id)).limit(MEMORY_LIMIT);
    },
  };
}
