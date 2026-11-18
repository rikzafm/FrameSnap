# Repository policies

1. **No Claude attribution or authorship anywhere in this repo.** Do not add `Co-Authored-By: Claude`, "Generated with Claude Code", or any similar credit to commit messages, PR descriptions, code comments, docs, or files. This applies to sub-agents too. Commits are authored solely by the user.
2. `.claude/` and `.agent/` are git-ignored. Never commit or force-add them.

## Agent skills

### Issue tracker

Issues and specs are local markdown files under `.scratch/<feature>/` (not GitHub Issues). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), recorded as a `Status:` line in each issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
