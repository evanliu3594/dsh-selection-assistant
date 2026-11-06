/**
 * Translation language table, local source-language detection and translation
 * target decision. Dependency-free on purpose: the settings page imports this
 * module through `contract.ts`, and the host imports it before calling a model.
 *
 * The detector is a heuristic on character scripts plus a few Latin function
 * words. It never guesses: a result of `unknown` means "let the model decide".
 */

/** One translation target offered by the settings page. */
export interface LanguageInfo {
  /** Language code stored in `settings.json`. */
  code: string
  /** Display name for the Chinese UI. */
  labelZh: string
  /** Display name for the English UI. */
  labelEn: string
}

/** Translation target languages, in the order the settings page lists them. */
export const LANGUAGES: readonly LanguageInfo[] = [
  { code: 'zh', labelZh: '简体中文', labelEn: 'Simplified Chinese' },
  { code: 'en', labelZh: 'English', labelEn: 'English' },
  { code: 'ja', labelZh: '日本語', labelEn: 'Japanese' },
  { code: 'ko', labelZh: '한국어', labelEn: 'Korean' },
  { code: 'ru', labelZh: 'Русский', labelEn: 'Russian' },
  { code: 'fr', labelZh: 'Français', labelEn: 'French' },
  { code: 'de', labelZh: 'Deutsch', labelEn: 'German' },
  { code: 'es', labelZh: 'Español', labelEn: 'Spanish' },
  { code: 'pt', labelZh: 'Português', labelEn: 'Portuguese' },
  { code: 'it', labelZh: 'Italiano', labelEn: 'Italian' },
  { code: 'nl', labelZh: 'Nederlands', labelEn: 'Dutch' },
  { code: 'pl', labelZh: 'Polski', labelEn: 'Polish' },
  { code: 'tr', labelZh: 'Türkçe', labelEn: 'Turkish' },
  { code: 'vi', labelZh: 'Tiếng Việt', labelEn: 'Vietnamese' },
  { code: 'id', labelZh: 'Bahasa Indonesia', labelEn: 'Indonesian' },
  { code: 'ar', labelZh: 'العربية', labelEn: 'Arabic' },
  { code: 'th', labelZh: 'ไทย', labelEn: 'Thai' },
  { code: 'hi', labelZh: 'हिन्दी', labelEn: 'Hindi' },
  { code: 'el', labelZh: 'Ελληνικά', labelEn: 'Greek' },
  { code: 'he', labelZh: 'עברית', labelEn: 'Hebrew' },
]

/** Language codes accepted by the settings layer. */
const LANGUAGE_CODES: ReadonlySet<string> = new Set(LANGUAGES.map(language => language.code))

/** Common aliases and legacy display names; keys are lower case. */
const LANGUAGE_ALIASES: ReadonlyMap<string, string> = new Map(
  [
    ['zh-cn', 'zh'],
    ['zh-hans', 'zh'],
    ['zh-hant', 'zh'],
    ['zh-tw', 'zh'],
    ['中文', 'zh'],
    ['汉语', 'zh'],
    ['英文', 'en'],
    ['英语', 'en'],
  ] as const,
)

/** Lower-case display-name lookup (both UI labels of every language). */
const LANGUAGE_NAMES: ReadonlyMap<string, string> = new Map(
  LANGUAGES.flatMap(language => [
    [language.code, language.code] as const,
    [language.labelZh.toLowerCase(), language.code] as const,
    [language.labelEn.toLowerCase(), language.code] as const,
  ]),
)

/** Whether a string is one of the supported language codes. */
export function isLanguageCode(value: unknown): value is string {
  return typeof value === 'string' && LANGUAGE_CODES.has(value)
}

/** Display name of one language code; unknown codes are shown verbatim. */
export function languageLabel(code: string, ui: 'zh' | 'en'): string {
  const language = LANGUAGES.find(entry => entry.code === code)
  if (language === undefined) return code
  return ui === 'en' ? language.labelEn : language.labelZh
}

/**
 * Pick the default translation target from the OS display language.
 * The mapping uses the language subtag of the current Intl locale; every
 * unsupported or missing locale falls back to Simplified Chinese.
 */
export function systemDefaultLanguage(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale
    const primary = locale.toLowerCase().split('-')[0] ?? ''
    if (LANGUAGE_CODES.has(primary)) return primary
  } catch {
    // Intl is always present in Node and the browser; keep the fallback anyway.
  }
  return 'zh'
}

/**
 * Normalize a stored language value into a supported code.
 * Accepts codes (`zh`, `en-US`), legacy UI display names (`简体中文`, `English`,
 * `日本語`) and returns `fallback` for anything unrecognized.
 */
export function normalizeLanguageCode(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed === '') return fallback
  const lower = trimmed.toLowerCase()
  if (LANGUAGE_CODES.has(lower)) return lower
  const primary = lower.split(/[-_]/)[0] ?? ''
  if (LANGUAGE_CODES.has(primary)) return primary
  const byName = LANGUAGE_NAMES.get(lower) ?? LANGUAGE_ALIASES.get(lower)
  if (byName !== undefined) return byName
  return fallback
}

/** Code point ranges used to classify one character's script. */
const SCRIPT_RANGES: ReadonlyArray<readonly [string, number, number]> = [
  ['han', 0x3400, 0x4dbf],
  ['han', 0x4e00, 0x9fff],
  ['han', 0xf900, 0xfaff],
  ['hiragana', 0x3040, 0x309f],
  ['katakana', 0x30a0, 0x30ff],
  ['hangul', 0x1100, 0x11ff],
  ['hangul', 0xac00, 0xd7af],
  ['cyrillic', 0x0400, 0x04ff],
  ['arabic', 0x0600, 0x06ff],
  ['arabic', 0x0750, 0x077f],
  ['greek', 0x0370, 0x03ff],
  ['hebrew', 0x0590, 0x05ff],
  ['thai', 0x0e00, 0x0e7f],
  ['devanagari', 0x0900, 0x097f],
  ['latin', 0x0041, 0x005a],
  ['latin', 0x0061, 0x007a],
  ['latin', 0x00c0, 0x024f],
  ['latin', 0x1e00, 0x1eff],
]

/** Latin function words per language; the hit count splits Latin scripts. */
const LATIN_STOPWORDS: Readonly<Record<string, readonly string[]>> = {
  en: 'the and of to in is that for it as with be this are or from at an by not you we they he she has have was were will would can could should there their'.split(' '),
  fr: 'le la les de des du un une et est que qui dans pour pas sur avec ce cette il elle nous vous ils sont être avoir plus mais ou où'.split(' '),
  de: 'der die das und ist nicht mit für auf dem den des ein eine zu von sich im in es als auch wird werden hat haben oder aber bei aus nach'.split(' '),
  es: 'el la los las de del que y en un una es por para con no se su al lo como más pero sus le ya o este esta'.split(' '),
  pt: 'o a os as de do da dos das que e em um uma para com não por se na no mais como mas foi ser'.split(' '),
  it: 'il lo la i gli le di del della che e in un una per con non si al come più ma questo questa sono essere'.split(' '),
  nl: 'de het een en van in is dat op te voor met niet zijn er aan om ook als maar bij uit heeft'.split(' '),
  pl: 'i w na z do że nie jest się to jak ale po dla od za przez jako tak oraz'.split(' '),
  tr: 've bir bu için ile olan da de çok daha gibi ne var yok ama her şu'.split(' '),
  id: 'yang dan di ke dari untuk dengan ini itu tidak ada dalam akan pada juga karena bisa saya mereka'.split(' '),
}

/** Vietnamese-specific Latin Extended characters; their presence is decisive. */
const VIETNAMESE_CHARS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/u

/** One script hit count. */
export type ScriptCounts = Record<string, number>

/** Classify one code point into a script name, or undefined for punctuation/digits. */
function scriptOf(codePoint: number): string | undefined {
  for (const [script, start, end] of SCRIPT_RANGES) {
    if (codePoint >= start && codePoint <= end) return script
  }
  return undefined
}

/** Count script occurrences in a text. */
export function countScripts(text: string): ScriptCounts {
  const counts: ScriptCounts = {}
  for (const char of text) {
    const script = scriptOf(char.codePointAt(0) ?? 0)
    if (script !== undefined) counts[script] = (counts[script] ?? 0) + 1
  }
  return counts
}

/** Split Latin text into a language by function words; `unknown` when unsure. */
function detectLatin(text: string): string {
  if (VIETNAMESE_CHARS.test(text.toLowerCase())) return 'vi'
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(token => token.length > 0)
  if (tokens.length < 2) return 'unknown'
  const scores: Record<string, number> = {}
  for (const [code, words] of Object.entries(LATIN_STOPWORDS)) {
    const set = new Set(words)
    scores[code] = tokens.reduce((score, token) => score + (set.has(token) ? 1 : 0), 0)
  }
  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1])
  const [bestCode, bestScore] = ranked[0] ?? ['unknown', 0]
  const secondScore = ranked[1]?.[1] ?? 0
  if (bestScore < 2) return 'unknown'
  if (bestScore - secondScore < 2 && bestScore < tokens.length * 0.3) return 'unknown'
  return bestCode
}

/** Local source-language guess. */
export interface DetectedLanguage {
  /** One of the LANGUAGES codes, or `unknown`. */
  language: string
  /** Dominant script name; `none` when the text has no letters at all. */
  script: string
  /** True when the heuristic could not decide and the model should decide. */
  ambiguous: boolean
}

/**
 * Detect the source language of a selection.
 * Han + kana count as one CJK group, so Japanese prose is not treated as a
 * mixed-script selection. A dominant script below 70% of counted characters is
 * reported as `unknown`.
 */
export function detectLanguage(text: string): DetectedLanguage {
  const counts = countScripts(text)
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  if (total === 0) return { language: 'unknown', script: 'none', ambiguous: true }
  const cjk = (counts.han ?? 0) + (counts.hiragana ?? 0) + (counts.katakana ?? 0)
  if (cjk / total >= 0.7) {
    const kana = (counts.hiragana ?? 0) + (counts.katakana ?? 0)
    return kana > 0
      ? { language: 'ja', script: 'cjk', ambiguous: false }
      : { language: 'zh', script: 'cjk', ambiguous: false }
  }
  const sorted = Object.entries(counts).sort((left, right) => right[1] - left[1])
  const [script, count] = sorted[0] ?? ['none', 0]
  const ratio = count / total
  if (ratio < 0.7) return { language: 'unknown', script, ambiguous: true }
  if (script === 'han') {
    const kana = (counts.hiragana ?? 0) + (counts.katakana ?? 0)
    return kana > 0
      ? { language: 'ja', script, ambiguous: false }
      : { language: 'zh', script, ambiguous: false }
  }
  if (script === 'hiragana' || script === 'katakana') return { language: 'ja', script, ambiguous: false }
  if (script === 'hangul') return { language: 'ko', script, ambiguous: false }
  if (script === 'cyrillic') return { language: 'ru', script, ambiguous: false }
  if (script === 'arabic') return { language: 'ar', script, ambiguous: false }
  if (script === 'greek') return { language: 'el', script, ambiguous: false }
  if (script === 'hebrew') return { language: 'he', script, ambiguous: false }
  if (script === 'thai') return { language: 'th', script, ambiguous: false }
  if (script === 'devanagari') return { language: 'hi', script, ambiguous: false }
  if (script === 'latin') {
    const language = detectLatin(text)
    return language === 'unknown'
      ? { language: 'unknown', script, ambiguous: true }
      : { language, script, ambiguous: false }
  }
  return { language: 'unknown', script, ambiguous: true }
}

/** Outcome of the dest/opt decision for one piece of text. */
export interface TranslationTarget {
  /** Language code to translate into. */
  target: string
  /** True when the selection is already in the only configured target. */
  overlap: boolean
  /** Source language guess behind the decision. */
  source: DetectedLanguage
}

/**
 * Choose the translation target for `text`.
 *
 * - Source language known and equal to the configured target:
 *   - target equals fallback: `overlap` is true (no model call is useful);
 *   - otherwise translate into the fallback language.
 * - Source language known and different from the configured target: use it.
 * - Source language unknown: use the configured target and let the model decide.
 */
export function resolveTranslationTarget(text: string, target: string, fallback: string): TranslationTarget {
  const source = detectLanguage(text)
  if (source.language !== 'unknown' && source.language === target) {
    if (target === fallback) return { target: fallback, overlap: true, source }
    return { target: fallback, overlap: false, source }
  }
  return { target, overlap: false, source }
}

/**
 * Thrown before any model call when the selection is already written in the
 * configured target language and no distinct fallback language is configured.
 */
export class LanguageOverlapError extends Error {
  /** Machine code surfaced through the SSE error frame. */
  readonly code = 'language-overlap'

  constructor(message = '目标语言与源语言重叠') {
    super(message)
    this.name = 'LanguageOverlapError'
  }
}
