# Contributing to Aiguillage

Thanks for your interest! A few simple rules keep the project easy to read.

## Before you code

- **Bug:** open an issue with steps to reproduce, plus your Node, `claude` and OS versions.
- **New feature:** open an issue first to discuss it. Read [docs/DNA.md](docs/DNA.md): some ideas (accounts, cloud, a front-end framework, a build step) are out of scope.

## Develop

```bash
npm install
npm start          # http://127.0.0.1:4317
npm run test:all   # unit + integration + e2e
```

The tests never call the real Claude: `test/fake-claude.mjs` mimics the CLI. To test a new agent behavior, add a command to this fake CLI instead of calling the API.

## Rules

- **Node + vanilla JS, no build.** No new dependency when a few lines will do.
- **Nothing from a CDN.** Everything is served locally, fonts included.
- **The server listens on `127.0.0.1` only.**
- **No hard-coded UI text.** Every user-facing string goes through i18next (see below), with English as the base.
- **One PR, one topic**, with a test that fails without your change.
- Visual changes follow [DESIGN.md](DESIGN.md); include a before/after screenshot.

## Translations

All UI text lives in `public/locales/`, one JSON file per language. `en.json` is the base: every other file must have exactly the same keys and the same `{{placeholders}}`. `npm test` checks this.

- **In markup** (`public/index.html`): `data-i18n="key"` sets an element's text; `data-i18n-title`, `data-i18n-placeholder` and `data-i18n-aria-label` set those attributes.
- **In the UI code** (`public/app.js`): `t('key', { name })`. Plurals use i18next suffixes (`_one`, `_other`, plus `_few` or `_many` where the language needs them) with a `count` variable.
- **On the server:** throw `fail('errors.key', vars)` and return `notice('messages.key', vars)` from `lib/i18n.js`. The response carries the English text plus the key and vars, and the UI shows it in the user's language.

### Adding a language

1. Copy `public/locales/en.json` to `public/locales/<code>.json` (for example `de.json`) and translate the values. Leave the keys and `{{placeholders}}` as they are.
2. Add the language to `public/locales/languages.json`, with its name in that language: `"de": "Deutsch"`.
3. Run `npm test` to check the keys, then open the app and pick the language in the sidebar.

## Security

If you find a vulnerability (escaping the worktree sandbox, reaching the server from another origin…), please don't open a public issue: report it through a [private GitHub security advisory](https://github.com/xeewi/aiguillage/security/advisories/new).
