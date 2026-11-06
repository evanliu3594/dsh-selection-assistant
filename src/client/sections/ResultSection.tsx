/** Result-window card: placement, size memory, focus behavior, and appearance. */
import { LIMITS, type Settings, type SettingsPatch } from '../../contract.ts'
import { SectionCard, SliderField, ToggleField, type Translate } from '../ui.tsx'

/** Props the page hands the result-window card. */
export interface ResultSectionProps {
  t: Translate
  settings: Settings
  update: (patch: SettingsPatch) => void
}

/**
 * Render the result-window card.
 * @param props - settings and the patch writer.
 * @returns the card element.
 */
export function ResultSection({ t, settings, update }: ResultSectionProps) {
  const result = settings.result
  return (
    <SectionCard title={t('result.title')} desc={t('result.desc')}>
      <ToggleField
        label={t('result.followToolbar')}
        hint={t('result.followToolbarHint')}
        checked={result.followToolbar}
        onChange={(next) => { update({ result: { followToolbar: next } }) }}
      />
      <ToggleField
        label={t('result.rememberSize')}
        hint={t('result.rememberSizeHint')}
        checked={result.rememberSize}
        onChange={(next) => { update({ result: { rememberSize: next } }) }}
      />
      <ToggleField
        label={t('result.autoClose')}
        hint={t('result.autoCloseHint')}
        checked={result.autoClose}
        onChange={(next) => { update({ result: { autoClose: next } }) }}
      />
      <ToggleField
        label={t('result.alwaysOnTop')}
        hint={t('result.alwaysOnTopHint')}
        checked={result.alwaysOnTop}
        onChange={(next) => { update({ result: { alwaysOnTop: next } }) }}
      />
      <SliderField
        label={t('result.opacity')}
        hint={t('result.opacityHint')}
        min={LIMITS.opacity.min * 100}
        max={LIMITS.opacity.max * 100}
        step={1}
        value={Math.round(result.opacity * 100)}
        display={t('result.opacityValue', { percent: Math.round(result.opacity * 100) })}
        onChange={(next) => { update({ result: { opacity: next / 100 } }) }}
      />
    </SectionCard>
  )
}
