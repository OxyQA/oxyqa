import type { Octokit } from "octokit";

/** Paginate and check authorship so a user's copied marker cannot hijack writes. */
export async function writeBotComment(octokit: Octokit, scope: { owner: string; repo: string; prNumber: number }, slug: string, marker: string, body: string) {
  const { owner, repo, prNumber } = scope;
  let existingId: number | undefined;
  for await (const page of octokit.paginate.iterator(octokit.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 })) {
    const comment = page.data.find((c) => c.user?.login === `${slug}[bot]` && c.body?.includes(marker));
    if (comment) { existingId = comment.id; break; }
  }
  if (existingId) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existingId, body });
    return existingId;
  }
  const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  return data.id;
}
