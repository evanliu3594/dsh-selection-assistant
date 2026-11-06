/**
 * Helper resolution + config verification, runnable inside the DSH tool sandbox.
 *
 * The sandbox denies Node's piped-stdio child processes, so this script does not
 * boot the helper through `HelperManager.start()` successfully here; instead it
 * proves the parts that can be proven sandboxed:
 *   - candidate order: explicit setting → pwsh resolver → disk pwsh → bare pwsh
 *     → disk powershell.exe → bare powershell.exe
 *   - PowerShell 7 is preferred; Windows PowerShell 5.1 is the fallback runtime
 *   - an explicit Windows PowerShell 5.1 path is accepted as the first candidate
 *   - both runtimes launch and report the expected major version (7 for pwsh,
 *     5 for powershell.exe); the version is written to a file because piped
 *     stdio is unavailable in the sandbox
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
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

/** Candidate names this gate actually launches: pwsh or powershell.exe. */
const POWERSHELL_CANDIDATE = /pwsh(?:\.exe)?$|powershell\.exe$/i

/** Expected major version for one interpreter path or bare command name. */
function expectedMajor(candidate) {
  return basename(candidate).toLowerCase() === 'powershell.exe' ? 5 : 7
}

/** Write one candidate's PowerShell major version to a file and read it back. */
function probeMajor(candidate, dataDir, index) {
  const versionFile = resolve(dataDir, `pwsh-version-${String(index)}.txt`)
  rmSync(versionFile, { force: true })
  const versionScript = `$PSVersionTable.PSVersion.Major | Set-Content -Encoding ascii '${versionFile.replace(/'/g, "''")}'`
  const run = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', versionScript], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 30_000,
  })
  const major = existsSync(versionFile) ? Number.parseInt(readFileSync(versionFile, 'utf8').trim(), 10) : Number.NaN
  return { status: run.status, error: run.error, major }
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
check(candidates.at(-1) === 'powershell.exe', `last candidate is ${candidates.at(-1)}, expected the bare "powershell.exe" fallback`)
check(candidates.includes('pwsh'), 'default candidates lost the bare "pwsh" fallback')
const first = candidates[0]
check(typeof first === 'string' && first !== '', 'first candidate is empty')
console.log(`candidates: ${candidates.join(' | ')}`)

// (2) candidate order: every pwsh candidate must come before powershell.exe ---
const firstPwsh = candidates.findIndex(candidate => /pwsh(?:\.exe)?$/i.test(candidate))
const firstLegacy = candidates.findIndex(candidate => /powershell\.exe$/i.test(candidate))
check(firstPwsh !== -1, 'default candidates have no PowerShell 7 candidate')
check(firstLegacy !== -1, 'default candidates have no Windows PowerShell 5.1 candidate')
check(firstPwsh < firstLegacy, `Windows PowerShell 5.1 is preferred over PowerShell 7 (pwsh index ${String(firstPwsh)}, powershell.exe index ${String(firstLegacy)})`)
console.log(`order: pwsh@${String(firstPwsh)} before powershell.exe@${String(firstLegacy)}`)

// (3) the first candidate must actually launch a supported PowerShell ---------
// The sandbox forbids piped stdio, so the version is written to a file instead.
const firstProbe = probeMajor(first, dataDir, 'first')
check(
  firstProbe.status === 0,
  `launching ${first} failed (status=${String(firstProbe.status)}, error=${firstProbe.error?.message ?? 'none'})`,
)
check(firstProbe.major >= 5, `resolved PowerShell major version is ${String(firstProbe.major)}, expected 5+`)
console.log(`resolved: ${first} (PowerShell ${String(firstProbe.major)})`)

// (4) explicit WindowsApps alias is honored even when it cannot be stat-ted ---
const windowsApps = process.env.LOCALAPPDATA === undefined
  ? ''
  : `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\pwsh.exe`
if (windowsApps !== '') {
  settings.patch({ advanced: { helperPath: windowsApps } })
  const explicitCandidates = await manager.resolveCandidates()
  check(explicitCandidates[0] === windowsApps, `explicit path is not first: ${explicitCandidates[0]}`)
}

// (5) explicit Windows PowerShell 5.1 is accepted as the first candidate ------
const legacy = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
if (existsSync(legacy)) {
  settings.patch({ advanced: { helperPath: legacy } })
  const legacyCandidates = await manager.resolveCandidates()
  check(legacyCandidates[0] === legacy, `explicit powershell.exe is not first: ${legacyCandidates[0]}`)
  console.log(`explicit 5.1: ${legacyCandidates[0]}`)
}

// (6) both runtimes must launch and report their expected major version -------
settings.patch({ advanced: { helperPath: '' } })
const ordered = await manager.resolveCandidates()
const probed = []
for (const [index, candidate] of ordered.entries()) {
  if (!POWERSHELL_CANDIDATE.test(candidate)) continue
  const want = expectedMajor(candidate)
  const result = probeMajor(candidate, dataDir, index)
  check(
    result.status === 0 && result.major === want,
    `${candidate} reported PowerShell ${String(result.major)}, expected ${String(want)} (status=${String(result.status)})`,
  )
  probed.push(`${candidate} -> PowerShell ${String(result.major)}`)
}
check(probed.some(line => line.endsWith('PowerShell 7')), 'no candidate reported PowerShell 7')
check(probed.some(line => line.endsWith('PowerShell 5')), 'no candidate reported PowerShell 5')
console.log(`runtime probes: ${probed.join(' | ')}`)

// (7) config generation and actionable spawn failure --------------------------
let spawnError
try {
  await manager.start()
} catch (error) {
  spawnError = error
}
const status = manager.getStatus()
check(status.status === 'error', `sandboxed start() should end in error, got ${status.status}`)
check(
  typeof status.lastError === 'string'
    && status.lastError.includes('pwsh.exe')
    && status.lastError.includes('powershell.exe'),
  'spawn failure message does not offer both helper paths',
)
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
console.log('PASS: helper resolution and config verified (PowerShell 7 preferred, Windows PowerShell 5.1 fallback)')
process.exit(0)
