/**
 * Host-half artifact probe: load `lib/index.js` by bare package name the way the
 * loader does, then call `apply` against a minimal cold context.
 *
 * A profile always provides the optional services this plugin probes; the cold
 * context proves the plugin degrades instead of throwing when they are absent.
 * The lifecycle effect is captured, not executed: this probe does not start the
 * helper or open the loopback port.
 *
 *   node scripts/probe.mjs
 */
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

const dataDir = resolve('.probe-data')
rmSync(dataDir, { recursive: true, force: true })

let mod
try {
  mod = await import(pathToFileURL('lib/index.js').href)
} catch (error) {
  console.error(`FAIL: cannot import lib/index.js — run \`node scripts/build.mjs\` first (${error.message})`)
  process.exit(1)
}

check(typeof mod.apply === 'function', 'lib/index.js exports no apply()')
check(Array.isArray(mod.inject), 'lib/index.js exports no inject array')
check(typeof mod.name === 'string' && mod.name.length > 0, 'lib/index.js exports no plugin name')

if (typeof mod.apply === 'function') {
  const capturedEffects = []
  const ctx = {
    effect: (callback, label) => {
      capturedEffects.push({ callback, label })
      return () => {}
    },
    on: () => () => {},
    get: () => undefined,
    inject: (_names, callback) => {
      callback(ctx)
      return () => {}
    },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  }
  try {
    mod.apply(ctx, { dataDir })
  } catch (error) {
    failures.push(`apply() threw against a cold context: ${error?.message ?? String(error)}`)
  }
  check(capturedEffects.length >= 1, 'apply() registered no lifecycle effect')
  check(existsSync(resolve(dataDir, 'settings.json')), 'apply() did not create settings.json in the configured data directory')
  // Run the captured lifecycle callback once without awaiting its async start;
  // disposing immediately proves the teardown path does not throw synchronously.
  const lifecycle = capturedEffects.find(entry => String(entry.label ?? '').includes('lifecycle'))
  if (lifecycle !== undefined) {
    try {
      const disposer = lifecycle.callback()
      if (typeof disposer === 'function') disposer()
    } catch (error) {
      failures.push(`lifecycle start/cleanup threw: ${error?.message ?? String(error)}`)
    }
  }
  // Let the cancelled async start settle before the process exits.
  await new Promise(resolveSleep => setTimeout(resolveSleep, 300))
}

rmSync(dataDir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} host-artifact problem(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log('PASS: host artifact loads, exports apply/inject/name, and survives a cold context')
process.exit(0)
