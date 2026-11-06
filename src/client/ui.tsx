/**
 * Small presentational pieces shared by the settings sections.
 *
 * Nothing here touches `ctx`: the page hands every piece its localized copy and
 * its value, and the pieces only render.
 */
import type { ReactNode } from 'react'
import { Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ActionIcon, ActionKind } from '../contract.ts'

/** Translate signature of the plugin's locale namespace. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** One `<option>` of a select control. */
export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

/**
 * Render one settings card: title, optional description, optional header extra.
 * @param props - card copy and children.
 * @returns the card element.
 */
export function SectionCard({ title, desc, extra, children }: {
  title: string
  desc?: string | undefined
  extra?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="sa-card">
      <header className="sa-card-head">
        <div>
          <h3 className="sa-card-title">{title}</h3>
          {desc !== undefined && desc !== '' && <p className="sa-card-desc">{desc}</p>}
        </div>
        {extra !== undefined && <div className="sa-card-extra">{extra}</div>}
      </header>
      {children}
    </section>
  )
}

/**
 * Render one label/description row with its control on the right.
 * @param props - row copy and control.
 * @returns the row element.
 */
export function FieldRow({ label, hint, children }: {
  label: string
  hint?: string | undefined
  children: ReactNode
}) {
  return (
    <div className="sa-row">
      <div className="sa-row-text">
        <div className="sa-row-label">{label}</div>
        {hint !== undefined && hint !== '' && <div className="sa-row-hint">{hint}</div>}
      </div>
      <div className="sa-row-control">{children}</div>
    </div>
  )
}

/**
 * Render a stacked field (label above a full-width control, used in the editor).
 * @param props - field copy and control.
 * @returns the field element.
 */
export function BlockField({ label, hint, children }: {
  label: string
  hint?: string | undefined
  children: ReactNode
}) {
  return (
    <div className="sa-field">
      <div className="sa-field-label">{label}</div>
      {hint !== undefined && hint !== '' && <div className="sa-field-hint">{hint}</div>}
      {children}
    </div>
  )
}

/**
 * Render a boolean row with the platform switch.
 * @param props - copy, state, and writer.
 * @returns the row element.
 */
export function ToggleField({ label, hint, checked, onChange, disabled }: {
  label: string
  hint?: string | undefined
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </FieldRow>
  )
}

/**
 * Render a range row with a formatted current value.
 * @param props - copy, bounds, and writer.
 * @returns the row element.
 */
export function SliderField({ label, hint, value, min, max, step, display, onChange, disabled }: {
  label: string
  hint?: string | undefined
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (next: number) => void
  disabled?: boolean
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <span className="sa-value">{display}</span>
      <input
        className="sa-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => { onChange(Number(event.currentTarget.value)) }}
      />
    </FieldRow>
  )
}

/**
 * Render a labeled native select row.
 * @param props - copy, options, selected value, and writer.
 * @returns the row element.
 */
export function SelectField({ label, hint, value, options, onChange, disabled, ariaLabel }: {
  label: string
  hint?: string | undefined
  value: string
  options: readonly SelectOption[]
  onChange: (next: string) => void
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <select
        className="sa-select"
        value={value}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        onChange={(event) => { onChange(event.currentTarget.value) }}
      >
        {options.map(option => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldRow>
  )
}

/** Save lifecycle shown in the page header. */
export type SavePhase = 'idle' | 'saving' | 'saved' | 'error'

/**
 * Render the lightweight save indicator.
 * @param props - current phase, failure message, and retry action.
 * @returns the indicator element, or null while idle.
 */
export function SaveStatus({ t, phase, error, onRetry }: {
  t: Translate
  phase: SavePhase
  error: string
  onRetry: () => void
}) {
  if (phase === 'idle') return null
  if (phase === 'saving') return <Tag tone="info">{t('save.saving')}</Tag>
  if (phase === 'saved') return <Tag tone="success">{t('save.saved')}</Tag>
  return (
    <span className="sa-save-error" role="alert">
      {t('save.error', { message: error })}
      <button type="button" className="sa-link" onClick={onRetry}>{t('save.retry')}</button>
    </span>
  )
}

/**
 * Localized short label of an icon key (used on the compact icon badge).
 * @param icon - icon key.
 * @param t - namespace translator.
 * @returns two-character label.
 */
export function iconShortLabel(icon: ActionIcon, t: Translate): string {
  return t(`icon.${icon}.short`)
}

/**
 * Localized full label of an icon key.
 * @param icon - icon key.
 * @param t - namespace translator.
 * @returns full label.
 */
export function iconLabel(icon: ActionIcon, t: Translate): string {
  return t(`icon.${icon}`)
}

/**
 * Render the small square icon badge for one action icon.
 * @param props - icon key, localized label, and translator.
 * @returns the badge element.
 */
export function IconBadge({ icon, t }: { icon: ActionIcon; t: Translate }) {
  return (
    <span className="sa-icon" title={iconLabel(icon, t)} aria-hidden="true">
      {iconShortLabel(icon, t)}
    </span>
  )
}

/**
 * Localized action-type label.
 * @param kind - action kind.
 * @param t - namespace translator.
 * @returns localized type name.
 */
export function kindLabel(kind: ActionKind, t: Translate): string {
  return t(`actions.kind.${kind}`)
}

/**
 * Render the action-type tag.
 * @param props - action kind and translator.
 * @returns the tag element.
 */
export function KindTag({ kind, t }: { kind: ActionKind; t: Translate }) {
  const tone = kind === 'llm' ? 'info' : kind === 'search' ? 'neutral' : 'quiet'
  return <Tag tone={tone}>{kindLabel(kind, t)}</Tag>
}
