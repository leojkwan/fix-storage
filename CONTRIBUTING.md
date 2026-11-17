# Contributing to fix-storage

> This fork is read-only: it does not delete, move or clear anything. Text below that describes removal applies to the upstream project only.

Thanks for helping. fix-storage deletes things on people's disks, so the bar for anything that removes files is high, and the bar for everything else is low.

## Getting set up

```bash
git clone https://github.com/leojkwan/fix-storage && cd fix-storage
npm install
npm run demo       # made-up disk, deletes nothing
npm run typecheck
```

To work against your real disk without risk, use `npm start -- --dry-run`. Clearing and deleting only pretend in that mode.

You need macOS and Node.js 20.11+. For the graphical view, use a terminal with kitty graphics (Ghostty, kitty, WezTerm, iTerm2); `PIXEL_RENDERER=cells` forces the character view if you want to check that.

## Good first contributions

- **New junk patterns.** Add a rule to [`src/core/classify.ts`](src/core/classify.ts) with a short, lowercase reason that tells the user *why* it is safe, e.g. `"rebuilds with pod install"`. Prefer `unused` over `junk` when the thing cannot be regenerated with one command.
- **Culprit stop points.** Add bundle types that should be treated as one unit to `isWhole` in the same file.
- **Folders the scan misses.** Add them to `roots()` in [`src/core/categories.ts`](src/core/categories.ts).

## Rules for anything that removes files

1. Removal goes through `cannotRemove` in [`src/core/browse.ts`](src/core/browse.ts). If a new path could ever be dangerous, add it to `protectedPaths` there.
2. Only caches and things already in the Trash are deleted for good. Everything else is moved to the Trash.
3. Every removal needs two presses. Don't add a way around that.
4. `--dry-run` and `--demo` must never touch the disk.

## Pull requests

- Keep each PR to one change, and describe what you tried it on (demo, dry run, real disk).
- Run `npm run typecheck` before pushing; CI runs it too.
- For UI changes, include a screenshot or short recording.
- Write UI text in plain, lowercase terminal style, and keep it short.

## Releasing (maintainers)

1. Bump `version` in `package.json` and add an entry to [`CHANGELOG.md`](CHANGELOG.md).
2. Commit, then tag and push: `git tag v0.2.0 && git push origin main --tags`.
3. The [release workflow](.github/workflows/release.yml) builds the package, attaches `fix-storage.tgz` to a GitHub release, and the curl installer picks it up as the latest version.

## Code of conduct

Be kind and assume good intent. Harassment or personal attacks aren't tolerated; maintainers may remove comments or contributors that break this. Report problems privately to the maintainers (see [SECURITY.md](SECURITY.md) for how to reach them).
