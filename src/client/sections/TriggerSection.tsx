/** Trigger section: mode picker plus the mode-specific control. */
import { useState } from 'react'
import { Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { LIMITS, type Settings, type SettingsPatch, type TriggerMode } from '../../contract.ts'
import { isValidShortcut } from '../rules.ts'
import { FieldRow, SectionCard, SliderField, type Translate } from '../ui.tsx'

/** Props the page hands the trigger card. */
export interface TriggerSectionProps {
  t: Translate
  settings: Settings
  update: (patch: SettingsPatch) => void
  /** Host platform id: `darwin` switches the modifier names to macOS. */
  os: string
}

/**
 * Render the trigger card.
 * @param props - settings, the patch writer, and the host platform.
 * @returns the card element.
 */
export function TriggerSection({ t, settings, update, os }: TriggerSectionProps) {
  const [shortcut, setShortcut] = useState(settings.trigger.shortcut)
  const [shortcutError, setShortcutError] = useState(false)
  const mode = settings.trigger.mode
  const isMac = os === 'darwin'

  const changeMode = (next: TriggerMode): void => {
    update({ trigger: { mode: next } })
  }

  const changeShortcut = (next: string): void => {
    setShortcut(next)
    if (isValidShortcut(next)) {
      setShortcutError(false)
      update({ trigger: { shortcut: next.trim() } })
    } else {
      setShortcutError(next.trim() !== '')
    }
  }

  const options: Array<{ value: TriggerMode; label: string }> = [
    { value: 'selection', label: t('trigger.selection') },
    { value: 'ctrl', label: t(isMac ? 'trigger.ctrlMac' : 'trigger.ctrl') },
    { value: 'shortcut', label: t('trigger.shortcut') },
  ]

  const panelId = `sa-trigger-${mode}-panel`
  const tabId = `sa-trigger-${mode}`

  return (
    <SectionCard title={t('trigger.title')} desc={t('trigger.desc')}>
      <SegmentedControl
        id="sa-trigger"
        value={mode}
        options={options}
        label={t('trigger.selector')}
        onChange={changeMode}
      />
      <div id={panelId} role="tabpanel" aria-labelledby={tabId} style={{ marginTop: '10px' }}>
        {mode === 'selection' && (
          <p className="sa-row-hint">{t('trigger.selectionHint')}</p>
        )}
        {mode === 'ctrl' && (
          <>
            <p className="sa-row-hint">{t(isMac ? 'trigger.ctrlHintMac' : 'trigger.ctrlHint')}</p>
            <SliderField
              label={t('trigger.longPress')}
              hint={t(isMac ? 'trigger.longPressHintMac' : 'trigger.longPressHint')}
              min={LIMITS.longPressMs.min}
              max={LIMITS.longPressMs.max}
              step={50}
              value={settings.trigger.longPressMs}
              display={t('trigger.longPressValue', { ms: settings.trigger.longPressMs })}
              onChange={(next) => { update({ trigger: { longPressMs: next } }) }}
            />
          </>
        )}
        {mode === 'shortcut' && (
          <>
            <FieldRow label={t('trigger.shortcutLabel')} hint={t('trigger.shortcutHint')}>
              <Input
                className="sa-input"
                value={shortcut}
                aria-label={t('trigger.shortcutLabel')}
                placeholder={t(isMac ? 'trigger.shortcutPlaceholderMac' : 'trigger.shortcutPlaceholder')}
                onChange={(event) => { changeShortcut(event.currentTarget.value) }}
              />
            </FieldRow>
            {shortcutError && (
              <p className="sa-field-error" role="alert">
                {t(isMac ? 'trigger.shortcutInvalidMac' : 'trigger.shortcutInvalid')}
              </p>
            )}
          </>
        )}
      </div>
    </SectionCard>
  )
}
