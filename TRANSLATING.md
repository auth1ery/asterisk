# Contributing Translations

This is for people who don't want to use Weblate for translations.

Copy `frontend/locales/en.json` to `frontend/locales/[lang-code].json`
(e.g. `fr.json` for French) and translate the values, not the keys.

Then add your language to the `AVAILABLE_LANGS` array in `app.html` (find it with CTRL + F or use your mobile browser's "Find In Page" button) and open a PR!

**Rules:**
- Keep {placeholder} tokens exactly as-is
- Don't translate the keys (left side)
- If unsure about a string, leave the English value
