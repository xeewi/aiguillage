// UI translations with i18next. Adding a language: copy locales/en.json to locales/<code>.json,
// translate the values, and list the code in locales/languages.json.
import i18next from '/vendor/i18next.js'
import LanguageDetector from '/vendor/i18next-languagedetector.js'

const get = name => fetch(`/locales/${name}.json`).then(r => r.json())
export const LANGS = await get('languages')
// ponytail: every locale is fetched at startup; switch to i18next-http-backend once there are many.
const resources = Object.fromEntries(await Promise.all(Object.keys(LANGS).map(async l => [l, { translation: await get(l) }])))

await i18next.use(LanguageDetector).init({
  resources, fallbackLng: 'en', supportedLngs: Object.keys(LANGS), nonExplicitSupportedLngs: true,
  interpolation: { escapeValue: false }, // the UI writes text with textContent
  detection: { order: ['localStorage', 'navigator'], caches: ['localStorage'] },
})

export const t = (key, vars) => i18next.t(key, vars)
export const lang = () => i18next.resolvedLanguage
export const setLang = l => i18next.changeLanguage(l)

// Static markup: data-i18n sets the text; data-i18n-title / -placeholder / -aria-label set those attributes.
export function translateDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const a of ['title', 'placeholder', 'aria-label'])
    for (const el of root.querySelectorAll(`[data-i18n-${a}]`)) el.setAttribute(a, t(el.getAttribute(`data-i18n-${a}`)))
  document.documentElement.lang = lang()
}
