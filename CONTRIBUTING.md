# Contributing

## Status

This is a personal tool I open-sourced because it's useful. I use it daily on my own projects. It's not a community project — I don't have time to triage feature PRs, and most won't get a response. If you want a feature, fork it.

## What's welcome

- Bug reports — open an issue
- Bug fix PRs — any size, these get reviewed quickly
- Tree-sitter language support PRs — open an issue first to coordinate
- Doc fixes and typos

## What's NOT welcome (please don't waste your time)

- Feature PRs without a prior issue — will likely be closed
- "Big rewrites" or sweeping refactors
- Adding new dependencies without discussion

## Running locally

```sh
bun install
bun test
bun run src/index.ts query "..." .
```

## Release process

Maintainer-only. A new version is cut by:

1. PR that bumps `package.json`
2. After merge, tag `v<version>` on `main`
3. GitHub release with a `CHANGELOG` entry
