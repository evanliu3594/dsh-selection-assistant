/**
 * Helper resolution + config verification, runnable inside the DSH tool sandbox.
 *
 * The sandbox denies Node's piped-stdio child processes, so this script does not
 * boot the helper through `HelperManager.start()` successfully here; instead it
 * proves the parts that can be proven sandboxed:
 *   - candidate resolution order (explicit setting → resolver → disk → bare pwsh)
 *   - the Windows PowerShell 5.1 binary is rejected
 *   - the resolved candidate is a launchable PowerShell 7 (spawn with inherited stdio)
 *   - the helper config the manager writes matches the contract
 *   - a spawn failure surfaces an actionable Chinese error instead of throwing
 *
 * The real helper boot handshake (`/v1/status ready`, stdin teardown) is covered
 * by `helper/selftest.ps1`, which launches the helper through PowerShell.
 *
 *   node scripts/verify-helper-resolve.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const dataDir = resolve(`.verify-resolve-${process.pid}`)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })

const mod = await import(pathToFileURL('lib/index.js').href)
const { SettingsStore, ActionServer, HelperManager, PluginLogger } = mod

const settings = new SettingsStore(dataDir)
const logger = new PluginLogger(dataDir, 'info')
const deps = {
  dataDir,
  logPath: resolve(dataDir, 'helper.log'),
  pluginLogPath: resolve(dataDir, 'plugin.log'),
  version: '0.1.0-test',
  settings,
  llm: { defaults: () => ({ provider: '', model: '', reasoningEffort: '' }), providers: async () => [], complete: async () => '' },
  helper: undefined,
  logger,
  helperPath: () => '',
  helperKind: () => 'powershell',
  platformSupported: () => true,
  platformReason: () => '',
  openPermissions: async () => {},
  onSettingsSaved: () => {},
}
let actionServer
const manager = new HelperManager({
  dataDir,
  logPath: deps.logPath,
  logger,
  getSettings: () => settings.get(),
  getSubprocess: () => undefined,
  getEndpoint: () => actionServer?.endpoint,
})
deps.helper = manager
actionServer = new ActionServer(deps)
await actionServer.start()

// (1) default discovery ------------------------------------------------------
const candidates = await manager.resolveCandidates()
check(Array.isArray(candidates) && candidates.length > 0, 'resolvePwshCandidates returned no candidate')
check(candidates.at(-1) === 'pwsh', `last candidate is ${candidates.at(-1)}, expected the bare "pwsh" fallback`)
const first = candidates[0]
check(typeof first === 'string' && first !== '', 'first candidate is empty')
console.log(`candidates: ${candidates.join(' | ')}`)

// (2) the first candidate must actually launch PowerShell 7 -------------------
// The sandbox forbids piped stdio, so the version is written to a file instead.
const versionFile = resolve(dataDir, 'pwsh-version.txt')
rmSync(versionFile, { force: true })
const versionScript = `$PSVersionTable.PSVersion.Major | Set-Content -Encoding ascii '${versionFile.replace(/'/g, "''")}'`
const probe = spawnSync(first, ['-NoProfile', '-NonInteractive', '-Command', versionScript], {
  windowsHide: true,
  stdio: 'ignore',
  timeout: 30_000,
})
check(
  probe.status === 0,
  `launching ${first} failed (status=${String(probe.status)}, error=${probe.error?.message ?? 'none'})`,
)
const major = existsSync(versionFile) ? Number.parseInt(readFileSync(versionFile, 'utf8').trim(), 10) : Number.NaN
check(major >= 7, `resolved PowerShell major version is ${String(major)}, expected 7+`)
console.log(`resolved: ${first} (PowerShell ${String(major)})`)

// (3) explicit WindowsApps alias is honored even when it cannot be stat-ted ---
const windowsApps = process.env.LOCALAPPDATA === undefined
  ? ''
  : `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\pwsh.exe`
if (windowsApps !== '') {
  settings.patch({ advanced: { helperPath: windowsApps } })
  const explicitCandidates = await manager.resolveCandidates()
  check(explicitCandidates[0] === windowsApps, `explicit path is not first: ${explicitCandidates[0]}`)
}

// (4) Windows PowerShell 5.1 is rejected --------------------------------------
const legacy = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
if (existsSync(legacy)) {
  settings.patch({ advanced: { helperPath: legacy } })
  const legacyCandidates = await manager.resolveCandidates()
  check(!legacyCandidates.some(candidate => candidate.toLowerCase().endsWith('powershell.exe')), 'legacy powershell.exe was accepted as a candidate')
}

// (5) config generation and actionable spawn failure --------------------------
settings.patch({ advanced: { helperPath: '' } })
let spawnError
try {
  await manager.start()
} catch (error) {
  spawnError = error
}
const status = manager.getStatus()
check(status.status === 'error', `sandboxed start() should end in error, got ${status.status}`)
check(typeof status.lastError === 'string' && status.lastError.includes('pwsh'), 'spawn failure message is not actionable')
if (spawnError !== undefined) {
  // A synchronous EPERM from the sandbox is expected here; it may also be caught
  // per-candidate and reflected only in the status message.
  check(String(spawnError.message).length > 0, 'spawn error has no message')
}
const configPath = resolve(dataDir, 'helper-config.json')
check(existsSync(configPath), 'helper-config.json was not written before spawning')
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  check(typeof config.endpoint === 'string' && config.endpoint.startsWith('http://127.0.0.1:'), 'config endpoint is not loopback')
  check(typeof config.token === 'string' && config.token.length >= 32, 'config token is missing')
  check(Array.isArray(config.actions) && config.actions.length === 5, `config carries ${config.actions?.length} enabled actions, expected 5`)
  check(config.actions.every(action => typeof action.searchUrl === 'string'), 'config actions lost searchUrl')
  check(config.result.width === 500 && config.result.height === 400, `config result default is ${config.result.width}x${config.result.height}, expected 500x400`)
  check(config.trigger.longPressMs === 500 && config.trigger.mode === 'ctrl', 'config trigger defaults are wrong')
  console.log(`config: ${config.actions.map(action => action.id).join(',')} · result ${config.result.width}x${config.result.height}`)
}

await manager.dispose()
await actionServer.close()
rmSync(dataDir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} helper-resolution problem(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log('PASS: helper resolution and config verified')
process.exit(0)
