/**
 * macOS helper verification.
 *
 * The DSH host is replaced by a tiny mock HTTP server so this script proves the
 * parts of the macOS helper that do not need a real DeepSeek call:
 *
 *   1. `swiftc` build of helper/macos/Sources
 *   2. `--selftest`: toolbar + result windows render, pin toggles, PNG screenshots
 *   3. normal mode: /v1/status (including Accessibility permission), /v1/log,
 *      command.json preview, /v1/action SSE consumption, helper-state.json
 *   4. LaunchServices launch (the app is the TCC responsible process) and
 *      exit when the mock host stops answering /v1/health
 *
 * Accessibility permission cannot be granted from a terminal. The helper runs
 * with --no-permission-prompt and is expected to report error +
 * permissions.accessibility=false while staying alive; preview still works.
 *
 *   node scripts/verify-macos-helper.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Root of the package (script runs from there). */
const ROOT = resolve(import.meta.dirname, '..')

/** Failure accumulator. */
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

/** Print one labelled line. */
const log = message => console.log(message)

/** Millisecond sleep used only inside this standalone verifier. */
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

/** Whether a pid is alive; EPERM still means the process exists. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Wait until a predicate turns true or the timeout expires. */
async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      if (predicate()) return true
    } catch {
      // Keep polling: files appear after the helper writes them.
    }
    await sleep(100)
  }
  failures.push(`timeout after ${timeoutMs}ms waiting for ${label}`)
  return false
}

/** A PNG size reader for screenshot assertions. */
function pngSize(path) {
  try {
    const bytes = readFileSync(path)
    if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') return undefined
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  } catch {
    return undefined
  }
}

if (process.platform !== 'darwin') {
  console.error('SKIP: verify-macos-helper.mjs only runs on macOS.')
  process.exit(0)
}

// (1) build -----------------------------------------------------------------
if (process.argv.includes('--skip-build')) {
  log('build: skipped (--skip-build)')
} else {
  log('build: swiftc')
  const build = spawnSync('sh', [join(ROOT, 'scripts', 'build-macos-helper.sh')], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  check(build.status === 0, `macOS helper build exited with ${String(build.status)}`)
}
const app = join(ROOT, 'helper', 'macos', 'bin', 'SelectionAssistant.app')
const binary = join(app, 'Contents', 'MacOS', 'SelectionAssistant')
check(existsSync(app), `compiled helper app missing: ${app}`)
check(existsSync(binary), `compiled helper binary missing: ${binary}`)
if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} helper build problem(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

// (2) isolated data directory ----------------------------------------------
const dataDir = join(ROOT, `.verify-macos-helper-${String(process.pid)}`)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
const previewDir = join(dataDir, 'preview')
const selftestDir = join(dataDir, 'selftest')
mkdirSync(previewDir, { recursive: true })
mkdirSync(selftestDir, { recursive: true })
const logPath = join(dataDir, 'helper.log')
const configPath = join(dataDir, 'helper-config.json')
const token = 'verify-token-0123456789abcdef0123456789abcdef'
const bundleId = 'com.evanliu3594.dsh-selection-assistant.helper'

/** Delete the test-only launch defaults even when an assertion aborts the run. */
function clearLaunchDefaults() {
  for (const key of ['HelperConfigPath', 'SuppressPermissionPrompt', 'ScreenshotDir']) {
    spawnSync('/usr/bin/defaults', ['delete', bundleId, key], { encoding: 'utf8' })
  }
}
process.once('exit', clearLaunchDefaults)

// (3) mock host -------------------------------------------------------------
const statusFrames = []
const logFrames = []
const actionFrames = []
let port = 0

/** Write one JSON response. */
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/v1/health') {
    json(res, 200, { ok: true })
    return
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { ok: false })
    return
  }
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8')
    let body = {}
    try {
      body = text === '' ? {} : JSON.parse(text)
    } catch {
      body = { parseError: text }
    }
    if (url.pathname === '/v1/status') {
      statusFrames.push(body)
      json(res, 200, { ok: true })
      return
    }
    if (url.pathname === '/v1/log') {
      logFrames.push(body)
      json(res, 200, { ok: true })
      return
    }
    if (url.pathname === '/v1/action') {
      actionFrames.push(body)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      })
      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      send('meta', { provider: 'mock', model: 'mock-flash', label: '翻译' })
      send('meta', { provider: 'mock', model: 'mock-flash', label: '翻译' })
      send('delta', { text: '**验证**：SSE ' })
      send('delta', { text: '流式输出正常。\n\n- 第一项\n- 第二项\n\n`code`' })
      send('done', { reason: 'stop' })
      res.end()
      return
    }
    json(res, 404, { ok: false })
  })
})

await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen)
  server.listen(0, '127.0.0.1', () => {
    server.off('error', rejectListen)
    resolveListen()
  })
})
port = server.address().port
log(`mock host: http://127.0.0.1:${String(port)}`)

const config = {
  version: 1,
  endpoint: `http://127.0.0.1:${String(port)}`,
  token,
  dataDir,
  logPath,
  locale: 'zh',
  trigger: { mode: 'selection', longPressMs: 500, shortcut: 'Ctrl+Alt+Q', captureDelayMs: 120 },
  toolbar: { compact: false, maxVisibleActions: 6, scale: 1 },
  result: {
    followToolbar: true,
    rememberSize: true,
    autoClose: true,
    alwaysOnTop: true,
    opacity: 0.96,
    width: 500,
    height: 400,
  },
  appFilter: { mode: 'off', processes: [] },
  actions: [
    { id: 'translate', kind: 'llm', label: '翻译', icon: 'translate', enabled: true, order: 10, searchUrl: '' },
    { id: 'copy', kind: 'copy', label: '复制', icon: 'copy', enabled: true, order: 20, searchUrl: '' },
  ],
  debug: true,
}
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

// (4) --selftest: windows + pin + screenshots -------------------------------
log('selftest: windows, pin, screenshots')
const selftest = spawnSync(binary, ['--config', configPath, '--selftest', '--screenshot-dir', selftestDir], {
  cwd: dataDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 40_000,
  encoding: 'utf8',
})
if (selftest.status !== 0) {
  console.error('selftest stdout:', selftest.stdout?.slice(-3000) ?? '')
  console.error('selftest stderr:', selftest.stderr?.slice(-3000) ?? '')
}
check(selftest.status === 0, `--selftest exited with ${String(selftest.status)}`)
const selftestFile = join(dataDir, 'selftest-result.json')
check(existsSync(selftestFile), `selftest-result.json missing: ${selftestFile}`)
if (existsSync(selftestFile)) {
  try {
    const result = JSON.parse(readFileSync(selftestFile, 'utf8'))
    check(result.ok === true, `selftest ok is ${String(result.ok)}`)
    check(result.clicked === true, `selftest clicked is ${String(result.clicked)}`)
    check(result.pinToggled === true, `selftest pinToggled is ${String(result.pinToggled)}`)
    check(result.resizeOk === true, `selftest resizeOk is ${String(result.resizeOk)}`)
    check(result.done === true, `selftest done is ${String(result.done)}`)
    const toolbarSize = pngSize(join(selftestDir, 'toolbar.png'))
    const resultSize = pngSize(join(selftestDir, 'result.png'))
    check(toolbarSize !== undefined && toolbarSize.width > 100 && toolbarSize.height > 20,
      `toolbar.png is missing or too small: ${JSON.stringify(toolbarSize)}`)
    check(resultSize !== undefined && resultSize.width > 200 && resultSize.height > 150,
      `result.png is missing or too small: ${JSON.stringify(resultSize)}`)
    log(`selftest: ok=${String(result.ok)} toolbar=${JSON.stringify(toolbarSize)} result=${JSON.stringify(resultSize)}`)
  } catch (error) {
    failures.push(`selftest-result.json is unreadable: ${error.message}`)
  }
}

// (5) normal mode launched through LaunchServices -------------------------
log('normal mode: LaunchServices + status + preview + SSE + health teardown')
let helperPid
// macOS 27 drops `open --args`; the app reads these keys from UserDefaults.
for (const [key, value, type] of [
  ['HelperConfigPath', configPath, 'string'],
  ['SuppressPermissionPrompt', 'true', 'bool'],
  ['ScreenshotDir', previewDir, 'string'],
]) {
  const write = spawnSync('/usr/bin/defaults', ['write', bundleId, key, `-${type}`, value], { encoding: 'utf8' })
  check(write.status === 0, `defaults write ${key} failed: ${write.stderr ?? ''}`)
}
// The selftest runs in the same dataDir and writes its own pid into
// helper-state.json. Remove that state before launching the normal instance so
// its single-instance guard does not mistake the finished selftest for a peer.
rmSync(join(dataDir, 'helper-state.json'), { force: true })
rmSync(join(dataDir, 'command.json'), { force: true })
const launch = spawnSync('/usr/bin/open', ['-n', '-a', app], {
  cwd: dataDir,
  encoding: 'utf8',
  timeout: 15_000,
})
check(launch.status === 0, `open LaunchServices failed: status=${String(launch.status)} stderr=${launch.stderr ?? ''}`)

await waitFor(() => statusFrames.length > 0, 15_000, 'POST /v1/status from the launched app')
if (statusFrames.length > 0) {
  const frame = statusFrames.at(-1)
  log(`status: ${JSON.stringify(frame)}`)
  check(frame.state === 'ready' || frame.state === 'error', `unexpected status state: ${String(frame.state)}`)
  if (frame.state === 'error') {
    check(typeof frame.permissions?.accessibility === 'boolean',
      'status error does not carry permissions.accessibility')
  }
}
check(logFrames.length > 0, 'helper never posted /v1/log')
const statePath = join(dataDir, 'helper-state.json')
check(existsSync(statePath), 'helper-state.json was not written')
if (existsSync(statePath)) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    helperPid = state.pid
    check(Number.isInteger(helperPid) && helperPid > 0, `helper-state.json pid is ${String(helperPid)}`)
    if (Number.isInteger(helperPid) && helperPid > 0) log(`helper pid: ${helperPid}`)
  } catch (error) {
    failures.push(`helper-state.json is unreadable: ${error.message}`)
  }
}

writeFileSync(join(dataDir, 'command.json'),
  `${JSON.stringify({ id: 'verify-preview-1', type: 'preview', text: '验证预览文字' })}\n`, 'utf8')
await waitFor(() => actionFrames.length > 0, 15_000, 'POST /v1/action after preview')
if (actionFrames.length > 0) {
  const action = actionFrames[0]
  check(action.actionId === 'translate', `preview requested action ${String(action.actionId)}, expected translate`)
  check(typeof action.text === 'string' && action.text !== '', 'action request has no text')
  check(action.source?.app === 'preview', `preview action app is ${String(action.source?.app)}, expected preview`)
}
await waitFor(
  () => existsSync(join(previewDir, 'toolbar.png')) && existsSync(join(previewDir, 'result.png')),
  20_000,
  'preview screenshots',
)
const previewToolbar = pngSize(join(previewDir, 'toolbar.png'))
const previewResult = pngSize(join(previewDir, 'result.png'))
check(previewToolbar !== undefined, 'normal-mode toolbar.png missing')
check(previewResult !== undefined, 'normal-mode result.png missing')
if (previewToolbar !== undefined && previewResult !== undefined) {
  log(`preview: toolbar=${JSON.stringify(previewToolbar)} result=${JSON.stringify(previewResult)}`)
}

// The helper is a LaunchServices child, so host death is detected through
// /v1/health. Close the mock host and assert the app exits on its own.
server.close()
server.closeAllConnections?.()
if (helperPid !== undefined) {
  await waitFor(() => !pidAlive(helperPid), 15_000, 'helper exit after the mock host stopped')
  check(!pidAlive(helperPid), 'helper did not exit after three failed /v1/health checks')
}

if (existsSync(logPath)) {
  const text = readFileSync(logPath, 'utf8')
  check(!/\[ERROR\]/.test(text), 'helper.log contains an ERROR line')
  const warnings = text.split('\n').filter(line => line.includes('[WARN]')).slice(0, 3)
  if (warnings.length > 0) log(`helper warnings: ${warnings.join(' | ')}`)
} else {
  failures.push('helper.log was not written')
}

// (6) report ---------------------------------------------------------------
clearLaunchDefaults()
if (helperPid !== undefined && pidAlive(helperPid)) {
  try {
    process.kill(helperPid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}
if (failures.length > 0) {
  console.error(`
FAIL: ${failures.length} macOS helper problem(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(`data directory kept for inspection: ${dataDir}`)
  process.exit(1)
}
if (!process.argv.includes('--keep')) rmSync(dataDir, { recursive: true, force: true })
console.log('PASS: macOS helper built as an app bundle, self-tested, streamed SSE, and exited when the host stopped')
process.exit(0)
