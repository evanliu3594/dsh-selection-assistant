/**
 * macOS host-half integration: real HelperManager + real app bundle + fake LLM.
 *
 * `verify-host.mjs` replaces the helper with a stub. This script proves the part
 * the stub cannot: the host compiles (when stale) and launches
 * SelectionAssistant.app through LaunchServices, receives /v1/status, writes
 * command.json for a preview, streams /v1/action through a fake LLM, and stops
 * the app by pid.
 *
 * Accessibility is expected to be missing in an agent shell; the helper stays
 * alive, reports error + permissions.accessibility=false, and preview still
 * runs. The script does not require a granted TCC row.
 *
 *   node scripts/verify-host-macos.mjs [--keep] [--skip-build]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const helperBundleId = 'com.evanliu3594.dsh-selection-assistant.helper'

/** Delete the test-only preference even when an assertion aborts the run. */
function clearLaunchDefaults() {
  for (const key of ['HelperConfigPath', 'SuppressPermissionPrompt']) {
    spawnSync('/usr/bin/defaults', ['delete', helperBundleId, key], { encoding: 'utf8' })
  }
}
process.once('exit', clearLaunchDefaults)
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      if (predicate()) return true
    } catch {
      // Keep polling.
    }
    await sleep(100)
  }
  failures.push(`timeout after ${timeoutMs}ms waiting for ${label}`)
  return false
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

if (process.platform !== 'darwin') {
  console.error('SKIP: verify-host-macos.mjs only runs on macOS.')
  process.exit(0)
}

if (process.argv.includes('--skip-build')) {
  console.log('build: skipped (--skip-build)')
} else {
  const build = spawnSync('sh', ['scripts/build-macos-helper.sh'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  check(build.status === 0, `helper build exited with ${String(build.status)}`)
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.join('; ')}`)
    process.exit(1)
  }
}

const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { SettingsStore, ActionServer, HelperManager, PluginLogger } = mod

// Use the system temporary directory: the app launched by LaunchServices must
// be able to read its config without an extra Desktop-folder TCC prompt.
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-selection-assistant-host-verify-'))
const settings = new SettingsStore(dataDir)
const logger = new PluginLogger(dataDir, 'debug')

const llmCalls = []
const llm = {
  defaults: () => ({ provider: 'mock-provider', model: 'mock-model', reasoningEffort: '' }),
  providers: async () => [],
  complete: async () => '',
  async *runAction(action, text) {
    llmCalls.push({ actionId: action.id, text })
    yield { type: 'meta', provider: 'mock-provider', model: 'mock-model' }
    yield { type: 'delta', text: '宿主链路验证通过' }
    yield { type: 'done', reason: 'stop' }
  },
}

let actionServer
let manager
let helperPid
try {
  const deps = {
    dataDir,
    logPath: join(dataDir, 'helper.log'),
    pluginLogPath: logger.path,
    version: '0.2.1-test',
    settings,
    llm,
    helper: undefined,
    logger,
    helperPath: () => manager?.executablePath ?? '',
    helperKind: () => manager?.kind ?? 'darwin',
    platformSupported: () => true,
    platformReason: () => '',
    openPermissions: async () => {},
    onSettingsSaved: () => {},
  }
  // The host writes HelperConfigPath itself; suppress the AX prompt for this run.
  spawnSync('/usr/bin/defaults', ['write', helperBundleId, 'SuppressPermissionPrompt', '-bool', 'true'])
  actionServer = new ActionServer(deps)
  await actionServer.start()
  manager = new HelperManager({
    dataDir,
    logPath: deps.logPath,
    logger,
    getSettings: () => settings.get(),
    getSubprocess: () => undefined,
    getEndpoint: () => actionServer.endpoint,
  })
  deps.helper = manager

  await manager.start()
  const settled = await waitFor(
    () => ['running', 'error'].includes(manager.getStatus().status),
    150_000,
    'helper status',
  )
  const status = manager.getStatus()
  console.log(`status: ${JSON.stringify(status)} permissions=${JSON.stringify(manager.getPermissions())}`)
  check(settled, 'helper never reported a status')
  const denied = manager.getPermissions().accessibility === 'denied'
  check(status.status === 'running' || (status.status === 'error' && denied),
    `unexpected helper status: ${status.status} / ${String(status.lastError)}`)

  const statePath = join(dataDir, 'helper-state.json')
  check(existsSync(statePath), 'helper-state.json missing')
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    helperPid = state.pid
    check(Number.isInteger(helperPid) && helperPid > 0, `helper pid is ${String(helperPid)}`)
    check(pidAlive(helperPid), 'helper pid is not alive')
  }

  manager.preview('宿主集成验证')
  await waitFor(() => llmCalls.length > 0, 30_000, 'preview action through the fake LLM')
  if (llmCalls.length > 0) {
    check(llmCalls[0].actionId === 'translate', `preview action is ${llmCalls[0].actionId}`)
    console.log(`llm action: ${llmCalls[0].actionId} text=${llmCalls[0].text}`)
  }
} catch (error) {
  failures.push(`macOS host integration threw: ${error.message}`)
} finally {
  try {
    await manager?.dispose()
  } catch (error) {
    failures.push(`dispose failed: ${error.message}`)
  }
  try {
    await actionServer?.close()
  } catch {
    // Server may already be closed.
  }
}

clearLaunchDefaults()
if (helperPid !== undefined) {
  await waitFor(() => !pidAlive(helperPid), 12_000, 'helper exit after manager.dispose()')
  check(!pidAlive(helperPid), 'helper still alive after manager.dispose()')
  if (pidAlive(helperPid)) {
    try {
      process.kill(helperPid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

const logText = (() => {
  try {
    return readFileSync(join(dataDir, 'helper.log'), 'utf8')
  } catch {
    return ''
  }
})()
check(logText.trim() !== '', 'helper.log is empty')
check(!/\[ERROR\]/.test(logText), 'helper.log contains an ERROR line')

if (failures.length > 0) {
  console.error(`
FAIL: ${failures.length} macOS host integration problem(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(`data directory kept: ${dataDir}`)
  process.exit(1)
}
if (!process.argv.includes('--keep')) rmSync(dataDir, { recursive: true, force: true })
console.log('PASS: macOS host launched the app, received status, ran preview SSE, and stopped the app')
process.exit(0)
