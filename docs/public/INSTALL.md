# Getting started with OxyQA

OxyQA adds a QA test plan to every pull request: concrete cases a person can
run, written from the diff and what your team has told it about the project.

## 1. Install

Install the GitHub App on the repositories you want covered:
**[owner: install link — https://github.com/apps/<slug>/installations/new once the production App exists]**

Permissions it asks for, and why:

| Permission | Why |
|---|---|
| Pull requests: read & write | Read the diff; post and update the plan comment |
| Contents: read | Read `.oxyqa/context.md`, `.oxyqa/config.yml`, README |
| Issues: read & write | Read issues a PR links to; open a tracking issue when asked |
| Metadata: read | Required by GitHub for every App |

## 2. Open a pull request

Within about a minute OxyQA comments with a test plan. Pushing new commits
updates the same comment. Draft PRs are skipped until marked ready.

## 3. Make the plans yours (optional, recommended)

**`.oxyqa/context.md`** — what a new tester would need to know: what the product
is, who uses it, environments, domain terms, and how your team tests. Plain
prose. This is the single biggest quality lever.

**`.oxyqa/config.yml`** — behavior:

```yaml
maxCases: 8                 # 1–15, default 10
commentStyle: grouped       # grouped (by priority) or flat
focusAreas:
  - accessibility of forms
  - billing edge cases
skipPaths:                  # never sent to the model
  - "**/*.lock"
  - "docs/**"
```

**Link the issue.** `Fixes #123` in the PR description (or a branch named
`123-add-lockout`) gives OxyQA the requirement, so the plan checks the
acceptance criteria and not just the code.

## 4. Talk to it

Start a PR comment with the bot's mention and say what you want:

- "from now on, always include a Safari case for checkout changes" — saved for
  every future plan in this repository
- "stop doing the Safari thing" — removes that guidance
- "try again, focus on error handling" — regenerates this plan with that emphasis
- "turn this into an issue" — one tracking issue with the plan as a checklist

It replies with what it understood. Only people with write access can do this.
Exact commands also work: `remember: …`, `forget …`, `regenerate`,
`focus: …`, `create issue`.

## 5. Tell us how it did

React 👍 or 👎 on the plan comment. That is the main signal we use.

## Good to know

- **Large PRs:** the most relevant ~60,000 characters of the diff are analyzed,
  source files first. The plan's footer says when a PR was only partly analyzed.
- **Free tier:** 50 plans per installation per month; a notice appears on the
  PR when the limit is reached, with the reset date.
- **If something fails:** the comment says so, with a one-line reason and how
  to retry.
- **Your data:** see [PRIVACY.md](PRIVACY.md). Uninstalling deletes everything
  after 30 days.
