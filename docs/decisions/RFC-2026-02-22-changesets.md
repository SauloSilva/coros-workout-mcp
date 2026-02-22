# RFC: Don't Add Changesets

**Date:** 2026-02-22
**Status:** Accepted

## Summary

Decided not to add changesets. The project is early-stage with no publishing pipeline and a handful of users cloning from GitHub — there's no versioning or changelog pain to solve.

## Problem

No current pain around versioning or changelogs. The project is a single-package MCP server, solo-developed, with a small number of users who clone directly from GitHub. The motivation for considering changesets was partly learning, partly future-proofing — but there's no concrete problem to solve today.

## Options Considered

### Option A: Do Nothing / Manual Approach

Bump `version` in package.json by hand when it feels meaningful. When there's something worth announcing to users, create a GitHub Release with notes describing what changed. GitHub Releases are lightweight — no tooling required, just a title and free-text description attached to a git tag. See [GitHub docs on managing releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) for how to create them via the web UI or `gh release create` via the CLI.

This approach has zero overhead, zero new dependencies, and scales fine for a solo project with a small user base. It also gives users a natural place to check for updates without requiring any structured changelog workflow on the developer side.

### Option B: Add Changesets

Add `@changesets/cli`, run `changeset` before each commit, use `changeset version` to bump and generate CHANGELOG.md. Designed for monorepos with multiple packages and contributors. Adds a new workflow step to every change, a `.changeset/` directory, config files, and a learning curve — all for a single-package solo project with no npm publishing.

### Option C: Learn Changesets in a Throwaway Project

Spin up a separate practice repo to learn the tool without adding complexity here. Satisfies the learning goal without burdening this project.

## Decision

Option A: Do nothing.

## Rationale

Changesets solves a problem this project doesn't have. There's no npm publishing, no monorepo, no contributors needing structured changelogs. The handful of users clone `main` directly. Adding changesets would introduce process overhead on every change with no one benefiting from it. Learning tools is most effective when there's a real problem they solve — adopting it now would be premature complexity.

## Next Steps

- [ ] Revisit if the project is published to npm
- [ ] Revisit if users start asking "what changed?"
- [ ] Revisit if a second package is added (monorepo)
