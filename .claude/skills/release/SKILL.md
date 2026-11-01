---
name: release
description: Publish a new Aiguillage version (bump, tag, GitHub release picked up by the in-app updater). Use whenever the user wants to release, ship, publish or tag a version, or says "faire une release", "sortir une version", "publier".
---

# Release Aiguillage

A pushed `v*` tag runs `.github/workflows/release.yml`: it checks the tag matches `package.json`, runs `npm test`, builds the `.dmg` + `-mac.zip`, and publishes the GitHub release. Installed apps find it within 4 hours (`lib/update.js`), download the `.zip` and offer "Restart to update". A release reaches every user: get it right before pushing.

## Steps

1. **Start from main, clean and current.** The release is cut from the main checkout's `main`, not from a workspace branch.
   `git -C <repo> status --short` must be empty; `git fetch origin && git status` must show `main` up to date with `origin/main`. Otherwise stop and tell the user.
2. **Pick the version.** Read the current `version` in `package.json` and the commits since the last tag (`git log $(git describe --tags --abbrev=0 2>/dev/null)..HEAD --oneline`, or all of them for the first release). Propose semver: patch for fixes only, minor for features, major for breaking changes (state format, config). Show the proposal and the commit list; the user confirms the number.
3. **Check it works.** `npm test` (and `npm run test:e2e` when the UI changed). Any failure stops the release.
4. **Bump.** `npm version <x.y.z> --no-git-tag-version` (updates `package.json` and `package-lock.json`), then
   `git commit -am "Release v<x.y.z>"` and `git tag v<x.y.z>`.
5. **Push: ask first.** Show the commit and tag, then on the user's go: `git push origin main v<x.y.z>`.
6. **Follow the build.** `gh run list --workflow release.yml --limit 1`, then `gh run watch <id> --exit-status`. On failure, read `gh run view <id> --log-failed`, fix on `main`, delete the tag (`git tag -d v<x.y.z> && git push origin :refs/tags/v<x.y.z>`) and start again from step 3.
7. **Verify the release.** `gh release view v<x.y.z> --json assets --jq '.assets[] | {name, digest}'` must list a `.dmg` and an `Aiguillage-<x.y.z>-arm64-mac.zip` whose `digest` starts with `sha256:`. Without that zip and its digest, the in-app updater falls back to "Download".
8. **Report** to the user: the release URL, and the generated notes (offer to edit them with `gh release edit v<x.y.z> --notes-file …` if they read poorly).

## Don'ts

- Never move or reuse a published tag: apps compare versions, so a fix ships as the next patch version.
- Don't publish pre-releases expecting the updater to pick them up: it only reads `releases/latest`.
- Builds from CI are not Apple-signed (no certificate in the repo secrets): a `.dmg` downloaded from a browser may need right-click → Open. In-app updates are not affected.
