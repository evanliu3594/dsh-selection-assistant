/**
 * Integration verification of the Host half without a running DSH profile.
 *
 * Builds an isolated plugin instance out of the shipped bundle exports and a
 * fake `llm` service, then exercises:
 *   - settings sanitize/patch persistence (clamping, array replace, atomic file)
 *   - prompt templating and chunk interpretation
 *   - the loopback action server (bearer auth, SSE stream, error frame)
 *   - every settings route through a real HTTP listener
 *
 *   node scripts/verify-host.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import http from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const traceFile = resolve('verify-trace.log')
const trace = message => {
  if (process.env.VERIFY_TRACE !== '1') return
  appendFileSync(traceFile, `${new Date().toISOString()} ${message}\n`, 'utf8')
}
trace('start')

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const dataDir = resolve(`.verify-data-${process.pid}`)
rmSync(dataDir, { recursive: true, force: true })

const mod = await import(pathToFileURL('lib/index.js').href)
trace('bundle imported')
const {
  SettingsStore,
  LlmBridge,
  ActionServer,
  createSettingsHandler,
  buildState,
  buildActionPrompt,
  interpretChunk,
  createDefaultSettings,
  helperKindForPlatform,
  PREVIEW_TEXT,
} = mod

// ---------------------------------------------------------------------------
// Fake llm service: two providers, streaming text, one route that fails.
// ---------------------------------------------------------------------------
function makeLlmService(options = {}) {
  return {
    listProviders: () => [
      { id: 'other', name: 'Other' },
      { id: 'deepseek-account', name: 'DeepSeek' },
    ],
    listModels: async provider => (provider === 'deepseek-account' ? [{ id: 'deepseek-flash', name: 'Flash' }] : []),
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'max', name: 'max' }], defaultEffort: 'max' } }),
    prepareCall: async config => ({
      config,
      stream: async function* () {
        if (options.fail === true) throw Object.assign(new Error('boom'), { code: 'AUTH' })
        yield { type: 'text-delta', index: 0, text: '你好' }
        yield { type: 'text-delta', index: 0, text: '，世界' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
}

const fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }) }

/** Helper stub matching the surface buildState/routes use. */
const helperStub = {
  calls: [],
  getStatus: () => ({ status: 'running', pid: 1234, restarts: 0 }),
  restart: async () => {
    helperStub.calls.push('restart')
  },
  preview: text => {
    helperStub.calls.push(`preview:${text.length}`)
  },
  scriptPresent: true,
  pwshPath: 'C:/Program Files/PowerShell/7/pwsh.exe',
  getPermissions: () => ({ accessibility: 'unknown' }),
  setAccessibility: granted => {
    helperStub.calls.push(`accessibility:${String(granted)}`)
  },
  markReady: () => {
    helperStub.calls.push('ready')
  },
  markError: message => {
    helperStub.calls.push(`error:${message}`)
  },
}

// (1) settings store ---------------------------------------------------------
{
  const store = new SettingsStore(dataDir)
  check(store.get().trigger.mode === 'ctrl', 'default trigger mode is not ctrl')
  check(store.get().actions.length === 6, `default action count is ${store.get().actions.length}, expected 6`)
  const saved = store.patch({ trigger: { longPressMs: 99_999, mode: 'ctrl' }, enabled: false, actions: [createDefaultSettings().actions[0]] })
  check(saved.trigger.longPressMs === 1500, `longPressMs was not clamped: ${saved.trigger.longPressMs}`)
  check(saved.enabled === false, 'enabled patch did not apply')
  check(saved.actions.length === 1, 'actions patch did not replace the array')
  check(saved.actions[0]?.id === 'translate', 'first default action is not translate')
  const raw = JSON.parse(readFileSync(resolve(dataDir, 'settings.json'), 'utf8'))
  check(raw.trigger.longPressMs === 1500, 'settings.json was not written with the clamped value')
  check(raw.version === 1, 'settings.json version is not 1')
  const reloaded = new SettingsStore(dataDir)
  check(reloaded.get().actions.length === 1, 'settings did not reload from disk')
}
rmSync(dataDir, { recursive: true, force: true })
trace('settings store done')

// (1b) platform dispatch + 0.1 -> 0.2 settings migration
{
  check(helperKindForPlatform('win32') === 'powershell', 'win32 must use the PowerShell helper')
  check(helperKindForPlatform('darwin') === 'swift', 'darwin must use the Swift helper')
  check(helperKindForPlatform('linux') === 'none', 'unsupported platforms must report kind=none')
  const legacyDir = resolve(dataDir, 'legacy')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(
    resolve(legacyDir, 'settings.json'),
    JSON.stringify({ version: 1, advanced: { pwshPath: 'C:\\Tools\\pwsh.exe', logLevel: 'debug' } }),
    'utf8',
  )
  const legacy = new SettingsStore(legacyDir)
  check(legacy.get().advanced.helperPath === 'C:\\Tools\\pwsh.exe', 'pwshPath did not migrate to helperPath')
  rmSync(legacyDir, { recursive: true, force: true })
}
trace('platform + migration done')

// (2) prompt + chunk logic
{
  const settings = createDefaultSettings()
  const translate = settings.actions.find(action => action.id === 'translate')
  const prompt = buildActionPrompt(translate, settings, 'Hello world')
  check(prompt.user.includes('Hello world'), 'prompt does not include the selection')
  check(prompt.user.includes('简体中文'), 'default translate prompt lost the target language')
  check(prompt.user.includes('English'), 'default translate prompt lost the fallback language')
  check(prompt.system.length > 0, 'default translate system prompt is empty')
  const custom = buildActionPrompt({ ...translate, prompt: '只回答：{{text}}' }, settings, 'X')
  check(custom.user === '只回答：X', `custom prompt rendered as ${custom.user}`)
  const appended = buildActionPrompt({ ...translate, prompt: '解释一下' }, settings, 'Y')
  check(appended.user.includes('Y'), 'prompt without a placeholder did not append the selection')
  const delta = interpretChunk({ type: 'text-delta', index: 0, text: 'abc' })
  check(delta?.type === 'delta' && delta.text === 'abc', 'text-delta was not interpreted')
  const done = interpretChunk({ type: 'finish', reason: { kind: 'stop' } })
  check(done?.type === 'done' && done.reason === 'stop', 'finish was not interpreted')
  let threw = false
  try {
    interpretChunk({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad' } } })
  } catch {
    threw = true
  }
  check(threw, 'error finish did not throw')
  trace('prompt logic done')
}

// (3) helper surface via settings routes ------------------------------------
const settingsStore = new SettingsStore(dataDir)
const llm = new LlmBridge(() => makeLlmService(), () => fakeDefaultModel)
const deps = {
  dataDir,
  logPath: resolve(dataDir, 'helper.log'),
  pluginLogPath: resolve(dataDir, 'plugin.log'),
  version: '0.1.0-test',
  settings: settingsStore,
  llm,
  helper: helperStub,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setLevel: () => {}, log: () => {}, path: 'x' },
  helperPath: () => helperStub.pwshPath,
  helperKind: () => 'powershell',
  platformSupported: () => true,
  platformReason: () => '',
  openPermissions: async () => {
    helperStub.calls.push('open-permissions')
  },
  onSettingsSaved: () => {},
}

const settingsServer = createServer((req, res) => {
  void createSettingsHandler(deps)(req, res)
})
await new Promise(resolveListen => settingsServer.listen(0, '127.0.0.1', resolveListen))
trace('settings server listening')

/** Minimal HTTP client for loopback tests; undici fetch rejects some ephemeral ports. */
function httpRequest(port, method, path, options = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = http.request(
      { host: '127.0.0.1', port, method, path, headers: options.headers ?? {} },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          resolveRequest({
            status: response.statusCode,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    request.on('error', rejectRequest)
    request.setTimeout(20_000, () => request.destroy(new Error('request timeout')))
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

async function getJson(path) {
  const response = await httpRequest(settingsServer.address().port, 'GET', path)
  return { status: response.status, body: JSON.parse(response.text) }
}
async function postJson(path, body) {
  const response = await httpRequest(settingsServer.address().port, 'POST', path, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: JSON.parse(response.text) }
}

{
  const state = await getJson('/selection-assistant/state')
  check(state.status === 200 && state.body.ok === true, 'GET state did not succeed')
  check(state.body.state?.settings?.trigger?.mode === 'ctrl', 'state settings missing')
  check(state.body.state?.helper?.status === 'running', 'state helper status missing')
  check(state.body.state?.platform?.helper !== '', 'state platform helper path missing')
  check(state.body.state?.platform?.helperKind === 'powershell', 'state platform helperKind missing')
  check(state.body.state?.platform?.permissions?.accessibility === 'unknown', 'state platform permissions missing')
  check(state.body.state?.defaults?.provider === 'deepseek-account', 'state defaults missing')
  check(state.body.state?.version === '0.1.0-test', 'state version missing')

  const saved = await postJson('/selection-assistant/settings', { patch: { toolbar: { compact: true } } })
  check(saved.status === 200 && saved.body.ok === true, 'POST settings did not succeed')
  check(saved.body.state?.settings?.toolbar?.compact === true, 'saved settings not reflected in the response')
  check(saved.body.state?.settings?.trigger?.longPressMs === 500, 'unrelated defaults were lost on a nested patch')
  const onDisk = JSON.parse(readFileSync(resolve(dataDir, 'settings.json'), 'utf8'))
  check(onDisk.toolbar.compact === true, 'saved settings not written to disk')

  const bad = await postJson('/selection-assistant/settings', { nope: 1 })
  check(bad.status === 400, `invalid settings body answered ${bad.status}, expected 400`)

  const models = await getJson('/selection-assistant/models')
  check(models.status === 200 && models.body.ok === true, 'GET models did not succeed')
  check(models.body.providers?.[0]?.provider === 'deepseek-account', 'DeepSeek provider is not first')
  check(models.body.providers?.[0]?.models?.[0]?.reasoningEfforts?.length === 1, 'reasoning metadata missing')

  const testCall = await postJson('/selection-assistant/test', { provider: 'deepseek-account', model: 'deepseek-flash' })
  check(testCall.status === 200 && testCall.body.text === '你好，世界', `POST test answered ${JSON.stringify(testCall.body)}`)

  const preview = await postJson('/selection-assistant/helper/preview', { text: PREVIEW_TEXT })
  check(preview.status === 200 && preview.body.ok === true, 'POST helper/preview failed')
  check(helperStub.calls.some(call => call.startsWith('preview:')), 'helper.preview was not called')

  const restart = await postJson('/selection-assistant/helper/restart', {})
  check(restart.status === 200 && helperStub.calls.includes('restart'), 'POST helper/restart failed')

  const permissions = await postJson('/selection-assistant/helper/open-permissions', {})
  check(permissions.status === 200 && helperStub.calls.includes('open-permissions'), 'POST helper/open-permissions failed')

  const logs = await getJson('/selection-assistant/logs?lines=50')
  check(logs.status === 200 && logs.body.ok === true && typeof logs.body.text === 'string', 'GET logs failed')

  const missing = await getJson('/selection-assistant/nope')
  check(missing.status === 404, `unknown route answered ${missing.status}, expected 404`)

  const wrongMethod = await postJson('/selection-assistant/state', {})
  check(wrongMethod.status === 405, `wrong method answered ${wrongMethod.status}, expected 405`)
  trace('settings routes done')
}

// (4) loopback action server -------------------------------------------------
{
  const actionServer = new ActionServer(deps)
  await actionServer.start()
  trace('action server started')
  const endpoint = actionServer.endpoint
  check(endpoint !== undefined, 'action server did not report an endpoint')
  if (endpoint === undefined) throw new Error('action server endpoint missing')
  const port = Number(new URL(endpoint.url).port)
  const auth = { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }
  const call = (method, path, headers, body) => httpRequest(port, method, path, { headers, body })

  const health = await call('GET', '/v1/health')
  check(health.status === 200, 'GET /v1/health failed')

  const unauthorized = await call('POST', '/v1/status', {}, '{}')
  check(unauthorized.status === 401, `missing token answered ${unauthorized.status}, expected 401`)

  const status = await call('POST', '/v1/status', auth, JSON.stringify({ state: 'ready' }))
  check(status.status === 200, 'POST /v1/status failed')
  check(helperStub.calls.includes('ready'), 'status=ready did not reach the helper manager')

  const statusPermission = await call(
    'POST',
    '/v1/status',
    auth,
    JSON.stringify({ state: 'ready', permissions: { accessibility: true } }),
  )
  check(statusPermission.status === 200, 'POST /v1/status with permissions failed')
  check(helperStub.calls.includes('accessibility:true'), 'permissions.accessibility did not reach the helper manager')

  const log = await call('POST', '/v1/log', auth, JSON.stringify({ level: 'warn', message: 'hello' }))
  check(log.status === 200, 'POST /v1/log failed')

  const unknownAction = await call('POST', '/v1/action', auth, JSON.stringify({ actionId: 'nope', text: 'x' }))
  check(unknownAction.status === 404, `unknown action answered ${unknownAction.status}, expected 404`)

  const tooLong = await call('POST', '/v1/action', auth, JSON.stringify({ actionId: 'translate', text: 'x'.repeat(20_001) }))
  check(tooLong.status === 413, `oversized text answered ${tooLong.status}, expected 413`)

  const stream = await call('POST', '/v1/action', auth, JSON.stringify({ actionId: 'translate', text: 'Hello world' }))
  check(stream.status === 200, `POST /v1/action answered ${stream.status}`)
  check(String(stream.headers['content-type']).includes('text/event-stream'), 'action response is not text/event-stream')
  check(stream.text.includes('event: meta'), 'SSE stream has no meta event')
  check(stream.text.includes('event: delta') && stream.text.includes('你好'), 'SSE stream has no delta event')
  check(stream.text.includes('event: done'), 'SSE stream has no done event')
  await actionServer.close()

  // A failing model must surface as an SSE error frame, not a dropped socket.
  const failingLlm = new LlmBridge(() => makeLlmService({ fail: true }), () => fakeDefaultModel)
  const failingServer = new ActionServer({ ...deps, llm: failingLlm })
  await failingServer.start()
  const failingPort = Number(new URL(failingServer.endpoint.url).port)
  const failingBody = await httpRequest(failingPort, 'POST', '/v1/action', {
    headers: { Authorization: `Bearer ${failingServer.endpoint.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId: 'translate', text: 'Hello' }),
  })
  check(failingBody.text.includes('event: error'), 'failing model did not produce an SSE error event')
  await failingServer.close()
  trace('action server done')
}

// (5) a cold model selection ------------------------------------------------
{
  const coldLlm = new LlmBridge(() => makeLlmService(), () => undefined)
  const noDefault = new SettingsStore(resolve(dataDir, 'cold'))
  try {
    coldLlm.resolveRoute(noDefault.get().actions[0], noDefault.get())
    check(false, 'resolveRoute did not reject an empty route')
  } catch (error) {
    check(error.code === 'no-model' || String(error.message).includes('没有可用的模型'), 'missing-model error is not actionable')
  }
}

await new Promise(resolveClose => settingsServer.close(resolveClose))
trace('settings server closed')
rmSync(traceFile, { force: true })

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} host verification problem(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
const settingsFileExists = existsSync(resolve(dataDir, 'settings.json'))
rmSync(dataDir, { recursive: true, force: true })
console.log(`PASS: host half verified (settings persisted=${settingsFileExists})`)
// Keep-alive sockets from fetch can outlive the assertions; exit deterministically.
process.exit(0)
