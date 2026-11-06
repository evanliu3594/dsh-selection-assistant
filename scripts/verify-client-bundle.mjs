/**
 * Client-half verification: the built `lib/client.js` must be loadable by the
 * boot protocol and must register the selection-assistant settings section.
 * It also guards the advanced-row layout rules: `.sa-row-text` must keep
 * `flex:1 1 auto` and `.sa-row-hint` must keep `overflow-wrap:anywhere`, so a
 * long detected pwsh path wraps inside the text column instead of sliding
 * under the input control on its right.
 *
 *   node scripts/verify-client-bundle.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

/** Mirrors deepseek-harness/packages/client/web/src/platform.ts. */
const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

// (1) manifest
check(pkg.dsh?.client?.platform === 'web', 'package.json: dsh.client.platform must be "web"')
const clientExport = pkg.exports?.['./client']
const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
check(typeof clientRel === 'string', 'package.json: exports["./client"] must resolve to the built bundle')
if (typeof clientRel !== 'string') {
  console.error(`FAIL: ${failures.join('\n  ')}`)
  process.exit(1)
}
const clientPath = resolve(clientRel.replace(/^\.\//, ''))
let code
try {
  code = readFileSync(clientPath, 'utf8')
} catch (error) {
  console.error(`FAIL: cannot read ${clientPath} — run \`node scripts/build.mjs\` first (${error.message})`)
  process.exit(1)
}
console.log(`bundle: ${clientRel} (${code.length} bytes)`)

// (2) layout regression guard: the advanced "PowerShell 路径" row renders the
// detected path in `.sa-row-hint`. Without these declarations the no-space path
// overflows the text column and is covered by the 300px input on its right.
const rowTextRule = /\.sa-row-text\{([^}]*)\}/.exec(code)
const rowHintRule = /\.sa-row-hint\{([^}]*)\}/.exec(code)
check(rowTextRule !== null, 'bundle has no `.sa-row-text` CSS rule')
check(/flex:\s*1\s+1\s+auto/.test(rowTextRule?.[1] ?? ''), '`.sa-row-text` must declare flex:1 1 auto so the text column can shrink')
check(rowHintRule !== null, 'bundle has no `.sa-row-hint` CSS rule')
check(/overflow-wrap:\s*anywhere/.test(rowHintRule?.[1] ?? ''), '`.sa-row-hint` must declare overflow-wrap:anywhere so a long pwsh path wraps')
check(/word-break:\s*break-word/.test(rowHintRule?.[1] ?? ''), '`.sa-row-hint` must declare word-break:break-word so a long pwsh path breaks inside the column')

// (3) registration shape
const registration = /window\.__ModuleLoader__\.load\(\{([\s\S]*?)factory:/.exec(code)
check(registration !== null, 'bundle does not call window.__ModuleLoader__.load({ id, factory })')
const idMatch = /id:\s*("(?:[^"\\]|\\.)*")/.exec(registration?.[1] ?? '')
check(idMatch !== null, 'bundle registration has no id')
check(idMatch?.[1] === JSON.stringify(pkg.name), `bundle id ${idMatch?.[1]} must equal package name ${JSON.stringify(pkg.name)}`)

// (4) module table
const required = new Set([...code.matchAll(/(?<![\w.])require\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]))
for (const specifier of required) {
  check(PLATFORM_MODULES.has(specifier), `require("${specifier}") is not a platform module — it would miss the module table`)
}
console.log(`requires: ${required.size === 0 ? '(none)' : [...required].join(', ')}`)

// (5) behavior: run the bundle and the factory the way the module system does
const captured = []
const windowStub = { __ModuleLoader__: { load: (value) => captured.push(value) } }
const documentStub = {
  createElement: () => ({ textContent: '', remove: () => {}, setAttribute: () => {} }),
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
}
new Function('window', 'document', code)(windowStub, documentStub)
check(captured.length === 1, `bundle registered ${captured.length} factories, expected 1`)

/** Any primitive name resolves to an inert component so module-scope destructuring works. */
const primitives = new Proxy({}, {
  get: (_target, property) => (typeof property === 'string' ? () => null : undefined),
})
const reactStub = new Proxy({
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  createElement: () => null,
  Fragment: Symbol('Fragment'),
}, {
  get: (target, property) => (property in target ? target[property] : () => null),
})
const moduleStubs = {
  'react': reactStub,
  'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') },
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
}
const exports = captured[0]?.factory((specifier) => {
  if (specifier in moduleStubs) return moduleStubs[specifier]
  throw new Error(`require("${specifier}") missed the module table`)
}) ?? {}

check(typeof exports.apply === 'function', 'bundle exports no apply()')
check(!('default' in exports), 'bundle exports a default — the loader would discard the namespace, inject included')
check(Array.isArray(exports.inject), 'bundle exports no inject array')
check(exports.inject?.includes('slots'), 'bundle inject does not declare the slots service')

if (typeof exports.apply === 'function') {
  const registrations = []
  const injections = []
  const dictionaries = []
  const ctx = {
    effect: (callback) => { callback(); return () => {} },
    get: () => undefined,
    on: () => () => {},
    inject: (_names, callback) => { callback(ctx); return () => {} },
    locale: {
      register: (ns, value) => { dictionaries.push({ ns, value }); return () => {} },
      bind: (ns) => (key) => `${ns}.${key}`,
    },
    slots: {
      inject: (name, callback) => { injections.push(name); return callback() },
      register: (spec, component) => { registrations.push({ ...spec, component }); return () => {} },
    },
  }
  exports.apply(ctx)
  check(injections.includes('settings.section'), `apply did not inject into settings.section (got: ${injections.join(', ') || 'nothing'})`)
  const section = registrations.find((spec) => spec.name === 'settings.section')
  check(section !== undefined, 'apply registered no settings.section')
  check(section?.id === 'selection-assistant', `settings.section id is ${JSON.stringify(section?.id)}, expected "selection-assistant"`)
  check(typeof section?.label === 'function' && String(section.label()).length > 0, 'settings.section has no resolvable label')
  check(typeof section?.component === 'function' || typeof section?.Component === 'function' || typeof section?.render === 'function', 'settings.section registration has no component')
  check(dictionaries.length > 0, 'apply registered no locale dictionary')
  console.log(`section: id=${section?.id} order=${section?.order} label=${String(section?.label?.())}`)
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} client-bundle problem(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log('PASS: client bundle registers the selection-assistant settings section and requires only platform modules')
process.exit(0)
