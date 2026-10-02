# OxyQA privacy note

> **Draft for the owner's review before publishing.** Written from what the
> code does as of October 2026. Items marked **[owner]** need a decision or a
> real contact detail. This is a plain-language description, not legal advice.

OxyQA is a GitHub App that writes QA test plans for pull requests. This page
says what it reads, where that goes, what it keeps, and how to remove it.

## What OxyQA reads from your repository

Only on repositories you install it on, and only when a pull request is opened
or updated or someone addresses the bot in a PR comment:

- the pull request's title, description, branch name and **diff** (changed lines);
- `.oxyqa/context.md` and `.oxyqa/config.yml` if present, otherwise the README;
- GitHub issues the PR links to (up to three, same repository);
- comments that start with the bot's @mention;
- 👍/👎 reactions on the bot's own plan comment, when the PR closes.

It does not clone your repository, read files the PR didn't touch (other than
the two `.oxyqa` files and the README), or read other repositories.

## Where it is sent

| Recipient | What | Why |
|---|---|---|
| **Anthropic** (model provider) | PR title/description, the diff (up to ~60,000 characters, large PRs are trimmed), repository context, saved guidance, linked issues; and the text of comments addressed to the bot | To generate the test plan and to understand plain-language requests |
| **Langfuse** (LLM tracing) — *only if the operator has enabled it* **[owner: state whether enabled in production]** | The same prompt content and the generated plan | To measure and improve plan quality |
| **Sentry** (error tracking) — *only if enabled* | Error type, stack trace of OxyQA's own code, and ids (installation, repository name, PR number). **No diff, prompt, comment or file content** | To find and fix failures |
| **GitHub** | The plan comment, replies, and — if you ask for one — a tracking issue | The product's output |

Anthropic's handling of API data is described in its commercial terms and
privacy policy (https://www.anthropic.com/legal). **[owner: confirm the
retention/training terms that apply to your Anthropic account and state them
here.]**

## What OxyQA stores

In its own database (Postgres):

- your installation's account name and type, and when it was installed,
  suspended or removed;
- each generated plan: repository, PR number, commit, status, summary and test
  cases (these describe your change, so treat them as derived from your code);
- guidance saved with "remember" and who saved it (GitHub username);
- per-plan token counts, for limits and billing;
- 👍/👎 counts with the reacting user's numeric GitHub id.

**The diff itself is not stored** by OxyQA. Job queue entries (Redis) hold ids
and the text of bot commands, and expire as the queue rotates.

## How long, and how to delete

- **Uninstall the app** and its data is deleted automatically **30 days** later
  (plans, test cases, saved guidance, usage, feedback). Reinstalling within that
  window does not restore access to the old data.
- To delete saved guidance now: `@<bot> forget <text>` deactivates it; it is
  removed with the rest on uninstall.
- For earlier deletion or a copy of your data, contact **[owner: support email]**.

## Limits and control

- Only collaborators with write access can give the bot commands.
- `skipPaths` in `.oxyqa/config.yml` excludes matching files from what is sent
  to the model (for example `secrets/**`).
- The free tier generates up to 50 plans per installation per month.

## Self-hosted

OxyQA can run entirely in your own infrastructure with your own model provider
key. In that mode nothing is sent to OxyQA's operators.

Contact: **[owner: support email]**
