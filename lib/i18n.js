// Server and desktop-app messages, from the same locale files as the UI (public/locales).
// Errors and notices carry their key + vars so the UI can show them in the user's language;
// the English text stays in `message` for logs, tests and API callers.
import i18next from 'i18next'
import { readFileSync } from 'node:fs'

const load = name => JSON.parse(readFileSync(new URL(`../public/locales/${name}.json`, import.meta.url), 'utf8'))
const langs = Object.keys(load('languages'))

export const i18n = i18next.createInstance()
i18n.init({
  lng: 'en', fallbackLng: 'en', supportedLngs: langs, nonExplicitSupportedLngs: true, initAsync: false,
  interpolation: { escapeValue: false },
  resources: Object.fromEntries(langs.map(l => [l, { translation: load(l) }])),
})

export const fail = (key, vars) => Object.assign(new Error(i18n.t(key, vars)), { key, vars })
export const notice = (key, vars) => ({ message: i18n.t(key, vars), key, vars })
