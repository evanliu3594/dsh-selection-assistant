/**
 * Pure helpers for the action list and the trigger shortcut.
 *
 * Everything here works on plain values (no React, no DOM), so the list edits
 * are easy to reason about and the page never mutates the settings object.
 */
import {
  ACTION_ICONS,
  type ActionIcon,
  type ActionKind,
  type ActionSettings,
  type Settings,
  type SettingsPatch,
} from '../contract.ts'

/** Ids of the six seeded actions; these cannot be deleted, only disabled. */
export const BUILTIN_ACTION_IDS: ReadonlySet<string> = new Set([
  'translate',
  'explain',
  'summarize',
  'search',
  'copy',
  'optimize',
])

/** Action types an action editor may choose between for a custom action. */
export const ACTION_KINDS: readonly ActionKind[] = ['llm', 'search', 'copy']

/** All icon keys, in toolbar order, reusable by the editor picker. */
export const ICON_KEYS: readonly ActionIcon[] = ACTION_ICONS

/**
 * Whether an action is a built-in preset (cannot be deleted).
 * @param id - action id.
 * @returns true for the six seeded actions.
 */
export function isBuiltinAction(id: string): boolean {
  return BUILTIN_ACTION_IDS.has(id)
}

/**
 * Copy the actions in display order, ascending `order` with a stable tiebreak.
 * @param actions - stored actions.
 * @returns a new sorted array of the same action objects.
 */
export function sortActions(actions: readonly ActionSettings[]): ActionSettings[] {
  return [...actions].sort((left, right) => left.order - right.order)
}

/**
 * Sort the actions and renumber `order` as 10, 20, 30… so reordering stays unique.
 * @param actions - stored actions.
 * @returns a new array with normalized order values.
 */
export function normalizeActions(actions: readonly ActionSettings[]): ActionSettings[] {
  return sortActions(actions).map((action, index) => ({ ...action, order: (index + 1) * 10 }))
}

/**
 * Replace one action by id.
 * @param actions - stored actions.
 * @param next - the action to store.
 * @returns a new array with the action replaced (or appended when absent).
 */
export function upsertAction(actions: readonly ActionSettings[], next: ActionSettings): ActionSettings[] {
  const found = actions.some(action => action.id === next.id)
  const replaced = found
    ? actions.map(action => (action.id === next.id ? next : action))
    : [...actions, next]
  return normalizeActions(replaced)
}

/**
 * Enable or disable one action.
 * @param actions - stored actions.
 * @param id - action id.
 * @param enabled - requested state.
 * @returns a new normalized array.
 */
export function setActionEnabled(
  actions: readonly ActionSettings[],
  id: string,
  enabled: boolean,
): ActionSettings[] {
  return normalizeActions(actions.map(action => (action.id === id ? { ...action, enabled } : action)))
}

/**
 * Move one action one slot up or down.
 * @param actions - stored actions.
 * @param id - action id.
 * @param delta - -1 for up, 1 for down.
 * @returns a new normalized array; unchanged when the action is already at the end.
 */
export function moveAction(actions: readonly ActionSettings[], id: string, delta: number): ActionSettings[] {
  const sorted = sortActions(actions)
  const from = sorted.findIndex(action => action.id === id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= sorted.length) return normalizeActions(actions)
  const swapped = [...sorted]
  const moved = swapped[from] as ActionSettings
  const displaced = swapped[to] as ActionSettings
  swapped[from] = displaced
  swapped[to] = moved
  // Renumber by the new positions: sorting by the old `order` values would undo the swap.
  return swapped.map((action, index) => ({ ...action, order: (index + 1) * 10 }))
}

/**
 * Remove one action by id. The caller guards the last-action case.
 * @param actions - stored actions.
 * @param id - action id.
 * @returns a new normalized array.
 */
export function removeAction(actions: readonly ActionSettings[], id: string): ActionSettings[] {
  return normalizeActions(actions.filter(action => action.id !== id))
}

/** Generate a stable-enough id for a custom action (no crypto dependency). */
export function createActionId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Build a blank custom action.
 * @param order - initial order value; normalized on save anyway.
 * @returns a new action the editor can fill in.
 */
export function createCustomAction(order = 0): ActionSettings {
  return {
    id: createActionId(),
    kind: 'llm',
    preset: 'custom',
    labelZh: '',
    labelEn: '',
    icon: 'sparkle',
    enabled: true,
    order,
    systemPrompt: '',
    prompt: '',
    searchUrl: '',
    model: { provider: '', model: '' },
  }
}

/**
 * Validate the shortcut text: Ctrl/Alt/Shift is mandatory, plus exactly one letter key.
 * @param value - shortcut text such as `Ctrl+Alt+Q`.
 * @returns whether the host can register the combination.
 */
export function isValidShortcut(value: string): boolean {
  const raw = value.trim()
  if (raw === '') return false
  const parts = raw.split('+').map(part => part.trim())
  if (parts.some(part => part === '')) return false
  if (parts.length < 2) return false
  let modifiers = 0
  let letters = 0
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control' || lower === 'alt' || lower === 'shift') {
      modifiers += 1
      continue
    }
    if (/^[a-z]$/i.test(part)) {
      letters += 1
      continue
    }
    return false
  }
  return modifiers > 0 && letters === 1
}

/** Keys of a settings patch section; used by the local deep merge. */
function isPatchGroup(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Merge a draft patch into the rendered settings, one nested level deep.
 * @param settings - settings currently rendered.
 * @param patch - changed fields only.
 * @returns a new settings object.
 */
export function mergeSettings(settings: Settings, patch: SettingsPatch): Settings {
  const next: Settings = { ...settings }
  for (const key of Object.keys(patch) as Array<keyof Settings>) {
    const value = patch[key]
    if (value === undefined) continue
    if (isPatchGroup(value)) {
      const current = next[key]
      next[key] = { ...(isPatchGroup(current) ? current : {}), ...value } as never
    } else {
      next[key] = value as never
    }
  }
  return next
}

/**
 * Merge a newer patch over an older pending patch (used to restore failed writes).
 * @param base - older patch.
 * @param newer - newer patch whose fields win.
 * @returns a new patch.
 */
export function mergePatch(base: SettingsPatch, newer: SettingsPatch): SettingsPatch {
  const merged: Record<string, unknown> = { ...base as Record<string, unknown> }
  for (const [key, value] of Object.entries(newer as Record<string, unknown>)) {
    if (value === undefined) continue
    const current = merged[key]
    merged[key] = isPatchGroup(value) && isPatchGroup(current) ? { ...current, ...value } : value
  }
  return merged as SettingsPatch
}

/**
 * Whether a patch carries no fields.
 * @param patch - patch to inspect.
 * @returns true when nothing needs saving.
 */
export function isEmptyPatch(patch: SettingsPatch): boolean {
  return Object.keys(patch as Record<string, unknown>).length === 0
}
