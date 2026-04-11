---
name: ccpm-local
description: Project-local copy of CCPM's markdown references for spec-driven, parallelizable task decomposition
---

# CCPM (markdown-only fork)

This directory is a **markdown-only** copy of the [CCPM](https://github.com/automazeio/ccpm) workflow references. We pulled the 6 reference docs from the upstream skill at commit `7d7e462` (2026-03-18) and deliberately **did not import the shell scripts**.

## Why markdown-only

- The real value is the workflow pattern (PRD → Epic → Tasks → Parallel streams), all captured in the 6 markdown files under `references/`.
- The 14 scripts under `skill/ccpm/references/scripts/` in upstream are convenience wrappers around `grep`/`ls`/`gh` — we can re-implement them lazily if we actually miss them.
- Skipping the scripts keeps the audit surface tiny: if upstream ever adds something destructive, we don't inherit it by accident.
- Audit of upstream at `7d7e462` found no destructive operations in any script (grep for `rm`, `git rm`, `git clean`, `git reset --hard`, `find -delete`, `.git` — zero matches).

## How to use it

When planning a non-trivial feature:

1. **Plan** — write a PRD at `.claude/prds/<feature>.md`. See `references/plan.md`.
2. **Structure** — decompose into an epic at `.claude/epics/<feature>/epic.md` and numbered task files (`001.md`, `002.md`, ...) with `depends_on`, `parallel`, `conflicts_with` frontmatter. See `references/structure.md`.
3. **Execute** — for each task, identify parallel streams (DB layer, service, API, UI, tests), launch subagents constrained to their own file scope, coordinate via frequent commits. See `references/execute.md`.
4. **Track** — status/standup/next/blocked reports come from filesystem state. See `references/track.md`.
5. **Sync** — optional GitHub issue sync for team visibility. See `references/sync.md`.

Read `references/conventions.md` first — it has the file layout, frontmatter schemas, datetime rules, and the "never `--force`" git rule.

## Divergences from upstream

- **No shell scripts.** Tracking operations use `grep`/`ls` directly via the Grep/Glob/Bash tools.
- **No GitHub sync required.** The workflow works fully offline using local files; `sync.md` is kept as a reference for when we want it.
- **Datetime field** — we use `date -u +"%Y-%m-%dT%H:%M:%SZ"` as documented.
- **Worktrees are optional** — for features that only touch one area, a single worktree is fine. Worktrees become valuable when ≥2 subagents run in parallel on independent file scopes.

## When NOT to use this

Don't use the full PRD→Epic→Tasks flow for:
- Bug fixes (just fix and commit)
- Single-file refactors
- Config tweaks
- Anything ≤2 hours of work

Use it for features that cross 3+ files, have multiple subsystems, or benefit from parallel subagent execution.
