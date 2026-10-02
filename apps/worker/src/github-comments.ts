import type { Octokit } from "octokit";

type PrScope = { owner: string; repo: string; prNumber: number };

/** Paginate and check authorship so a user's copied marker cannot hijack writes. */
export async function findBotComment(octokit: Octokit, scope: PrScope, slug: string, marker: string) {
  const { owner, repo, prNumber } = scope;
  for await (const page of octokit.paginate.iterator(octokit.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 })) {
    const comment = page.data.find((c) => c.user?.login === `${slug}[bot]` && c.body?.includes(marker));
    if (comment) return { id: comment.id, body: comment.body ?? "" };
  }
  return null;
}

export async function writeBotComment(octokit: Octokit, scope: PrScope, slug: string, marker: string, body: string, existingId?: number) {
  const { owner, repo, prNumber } = scope;
  const id = existingId ?? (await findBotComment(octokit, scope, slug, marker))?.id;
  if (id) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: id, body });
    return id;
  }
  const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  return data.id;
}
