/**
 * Unit checks for the host language module (`src/lang.ts`).
 *
 * Node strips the TypeScript types on the fly, so the source file is imported
 * directly — the build step is not required for this gate.
 *
 *   node --experimental-strip-types scripts/verify-lang.mjs
 *
 * Exits 0 only when every check passes.
 */
import {
  LANGUAGES,
  LanguageOverlapError,
  detectLanguage,
  languageLabel,
  normalizeLanguageCode,
  resolveTranslationTarget,
  systemDefaultLanguage,
} from '../src/lang.ts'

const failures = []
let checks = 0
let group = ''

function startGroup(name) {
  group = name
}
function check(condition, message) {
  checks += 1
  if (!condition) failures.push(`${group}: ${message}`)
}
function equal(actual, expected, message) {
  checks += 1
  if (actual !== expected) failures.push(`${group}: ${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`)
}
function finishGroup() {
  if (failures.some(failure => failure.startsWith(`${group}: `))) return
  console.log(`PASS  ${group}`)
}

// ---------------------------------------------------------------------------
// Language table
// ---------------------------------------------------------------------------
startGroup('LANGUAGES table')
const REQUIRED_CODES = [
  'zh', 'en', 'ja', 'ko', 'ru', 'fr', 'de', 'es', 'pt', 'it',
  'nl', 'pl', 'tr', 'vi', 'id', 'ar', 'th', 'hi', 'el', 'he',
]
check(Array.isArray(LANGUAGES) && LANGUAGES.length >= REQUIRED_CODES.length, `table holds ${LANGUAGES.length} languages, expected at least ${REQUIRED_CODES.length}`)
for (const code of REQUIRED_CODES) {
  check(LANGUAGES.some(language => language.code === code), `missing language ${code}`)
}
check(
  LANGUAGES.every(language => typeof language.labelZh === 'string' && language.labelZh !== '' && typeof language.labelEn === 'string' && language.labelEn !== ''),
  'every language needs non-empty labelZh and labelEn',
)
check(new Set(LANGUAGES.map(language => language.code)).size === LANGUAGES.length, 'language codes must be unique')
finishGroup()

// ---------------------------------------------------------------------------
// Display labels
// ---------------------------------------------------------------------------
startGroup('languageLabel')
equal(languageLabel('zh', 'zh'), '简体中文', 'Chinese label for the Chinese UI')
equal(languageLabel('en', 'zh'), 'English', 'fallback label still reads English in the Chinese UI')
equal(languageLabel('ja', 'en'), 'Japanese', 'Japanese label for the English UI')
equal(languageLabel('hi', 'zh'), 'हिन्दी', 'native label of Hindi')
equal(languageLabel('xx', 'zh'), 'xx', 'unknown codes are shown verbatim')
finishGroup()

// ---------------------------------------------------------------------------
// System default language
// ---------------------------------------------------------------------------
startGroup('systemDefaultLanguage')
const system = systemDefaultLanguage()
check(LANGUAGES.some(language => language.code === system), `systemDefaultLanguage returned ${system}, not in LANGUAGES`)
const localePrimary = (Intl.DateTimeFormat().resolvedOptions().locale ?? '').toLowerCase().split('-')[0]
if (REQUIRED_CODES.includes(localePrimary)) equal(system, localePrimary, `locale ${localePrimary} must map to its own code`)
else equal(system, 'zh', `unsupported locale ${JSON.stringify(localePrimary)} must fall back to zh`)
finishGroup()

// ---------------------------------------------------------------------------
// Source language detection
// ---------------------------------------------------------------------------
startGroup('detectLanguage')
const DETECT_CASES = [
  ['zh', '今天天气很好，我们一起去公园散步吧。'],
  ['en', 'The weather is nice today, so let us take a walk in the park.'],
  ['ja', '今日は天気がいいので、公園を散歩しましょう。'],
  ['ja', 'ひらがなだけでかかれたぶんしょうです。'],
  ['ko', '오늘 날씨가 좋아서 공원을 산책합시다.'],
  ['ru', 'Сегодня хорошая погода, давайте погуляем в парке.'],
  ['fr', 'Le temps est beau aujourd hui, allons nous promener dans le parc.'],
  ['de', 'Das Wetter ist schön, wir gehen im Park spazieren.'],
  ['es', 'El tiempo es bueno hoy, vamos a pasear por el parque.'],
  ['pt', 'O tempo está bom hoje, vamos passear no parque com a nossa família.'],
  ['it', 'Il tempo è bello oggi e andiamo a passeggiare nel parco con gli amici.'],
  ['ar', 'الطقس جميل اليوم، دعنا نتمشى في الحديقة.'],
  ['el', 'Ο καιρός είναι καλός σήμερα, ας πάμε μια βόλτα στο πάρκο.'],
  ['he', 'מזג האוויר נחמד היום, בואו נצא לטייל בפארק.'],
  ['th', 'วันนี้อากาศดีมาก เราไปเดินเล่นที่สวนสาธารณะกันเถอะ'],
  ['hi', 'आज मौसम अच्छा है, चलो पार्क में टहलने चलते हैं।'],
  ['vi', 'Hôm nay thời tiết đẹp, chúng ta đi dạo trong công viên nhé.'],
  ['id', 'Cuaca hari ini bagus, mari kita jalan-jalan di taman karena saya ingin bersantai dengan mereka.'],
]
for (const [expected, text] of DETECT_CASES) {
  const detected = detectLanguage(text)
  equal(detected.language, expected, `detection of ${JSON.stringify(text.slice(0, 24))}`)
  check(detected.ambiguous === false, `detected ${expected} text must not be ambiguous`)
}
for (const text of ['Hello world', 'Hello', 'ok', 'Hi there', 'Hola']) {
  const detected = detectLanguage(text)
  equal(detected.language, 'unknown', `short or ambiguous text ${JSON.stringify(text)} must be unknown`)
  check(detected.ambiguous === true, `unknown text ${JSON.stringify(text)} must be ambiguous`)
}
for (const text of ['这是 mixed 文本 with English words.', 'hello world 你好世界', 'hello world 你好世界你好']) {
  const detected = detectLanguage(text)
  equal(detected.language, 'unknown', `mixed-script text ${JSON.stringify(text)} must be unknown`)
}
const empty = detectLanguage('')
equal(empty.language, 'unknown', 'empty text must be unknown')
equal(empty.script, 'none', 'empty text must report script none')
equal(detectLanguage('12345 !!!').language, 'unknown', 'punctuation and digits must be unknown')
const mixed = detectLanguage('hello world 你好世界你好')
check(mixed.ambiguous === true && mixed.script === 'latin', 'no dominant script must be ambiguous')
finishGroup()

// ---------------------------------------------------------------------------
// Translation target decision
// ---------------------------------------------------------------------------
startGroup('resolveTranslationTarget')
const CHINESE = '今天天气很好，我们一起去公园散步吧。'
const ENGLISH = 'The weather is nice today, so let us take a walk in the park.'
{
  const result = resolveTranslationTarget(CHINESE, 'zh', 'en')
  equal(result.target, 'en', 'Chinese source with target zh must translate into the fallback language')
  equal(result.overlap, false, 'Chinese source with a distinct fallback is not an overlap')
  equal(result.source.language, 'zh', 'source language is reported')
}
{
  const result = resolveTranslationTarget(CHINESE, 'en', 'zh')
  equal(result.target, 'en', 'Chinese source with target en keeps the target')
  equal(result.overlap, false, 'different target language is not an overlap')
}
{
  const result = resolveTranslationTarget(ENGLISH, 'en', 'en')
  equal(result.overlap, true, 'English source with target=en fallback=en is an overlap')
}
{
  const result = resolveTranslationTarget(ENGLISH, 'en', 'zh')
  equal(result.target, 'zh', 'English source with target en must translate into the fallback language')
  equal(result.overlap, false, 'English source with a distinct fallback is not an overlap')
}
{
  const result = resolveTranslationTarget(ENGLISH, 'zh', 'en')
  equal(result.target, 'zh', 'English source with target zh keeps the target')
}
{
  const result = resolveTranslationTarget('Hello world', 'ja', 'en')
  equal(result.target, 'ja', 'unknown source uses the configured target')
  equal(result.overlap, false, 'unknown source never reports an overlap')
  equal(result.source.ambiguous, true, 'unknown source is marked ambiguous')
}
{
  const result = resolveTranslationTarget('Hello world', 'en', 'en')
  equal(result.target, 'en', 'unknown source with equal target and fallback keeps the target')
  equal(result.overlap, false, 'unknown source must not be rejected locally')
}
finishGroup()

// ---------------------------------------------------------------------------
// Legacy value normalization
// ---------------------------------------------------------------------------
startGroup('normalizeLanguageCode')
const NORMALIZE_CASES = [
  ['zh', 'zh'],
  ['EN', 'en'],
  [' zh ', 'zh'],
  ['zh-CN', 'zh'],
  ['en-US', 'en'],
  ['pt_BR', 'pt'],
  ['简体中文', 'zh'],
  ['English', 'en'],
  ['日本語', 'ja'],
  ['한국어', 'ko'],
  ['Français', 'fr'],
  ['Deutsch', 'de'],
  ['Japanese', 'ja'],
]
for (const [input, expected] of NORMALIZE_CASES) {
  equal(normalizeLanguageCode(input, 'zh'), expected, `normalization of ${JSON.stringify(input)}`)
}
for (const input of ['', '   ', 'klingon', 'xx-YY', null, undefined, 42, {}]) {
  equal(normalizeLanguageCode(input, 'en'), 'en', `unrecognized value ${JSON.stringify(input)} falls back`)
}
finishGroup()

// ---------------------------------------------------------------------------
// Overlap error
// ---------------------------------------------------------------------------
startGroup('LanguageOverlapError')
const overlapError = new LanguageOverlapError()
check(overlapError instanceof Error, 'overlap error must extend Error')
equal(overlapError.code, 'language-overlap', 'overlap error code')
equal(overlapError.message, '目标语言与源语言重叠', 'overlap error message')
equal(new LanguageOverlapError('自定义').message, '自定义', 'overlap error accepts a custom message')
finishGroup()

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('')
if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} language check(s) failed (of ${checks}):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`PASS: language module verified (${checks} checks)`)
process.exit(0)
