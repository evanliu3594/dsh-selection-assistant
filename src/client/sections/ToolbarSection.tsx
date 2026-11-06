/** Toolbar card: compact mode, visible action count, and scale. */
import { LIMITS, type Settings, type SettingsPatch } from '../../contract.ts'
import { SectionCard, SliderField, ToggleField, type Translate } from '../ui.tsx'

/** Props the page hands the toolbar card. */
export interface ToolbarSectionProps {
  t: Translate
  settings: Settings
  update: (patch: SettingsPatch) => void
}

/** Percent text of a toolbar scale. */
function scalePercent(scale: number): string {
  return `${Math.round(scale * 100)}%`
}

/**
 * Render the toolbar card.
 * @param props - settings and the patch writer.
 * @returns the card element.
 */
export function ToolbarSection({ t, settings, update }: ToolbarSectionProps) {
  return (
    <SectionCard title={t('toolbar.title')} desc={t('toolbar.desc')}>
      <ToggleField
        label={t('toolbar.compact')}
        hint={t('toolbar.compactHint')}
        checked={settings.toolbar.compact}
        onChange={(next) => { update({ toolbar: { compact: next } }) }}
      />
      <SliderField
        label={t('toolbar.maxVisible')}
        hint={t('toolbar.maxVisibleHint')}
        min={LIMITS.maxVisibleActions.min}
        max={LIMITS.maxVisibleActions.max}
        step={1}
        value={settings.toolbar.maxVisibleActions}
        display={String(settings.toolbar.maxVisibleActions)}
        onChange={(next) => { update({ toolbar: { maxVisibleActions: next } }) }}
      />
      <SliderField
        label={t('toolbar.scale')}
        hint={t('toolbar.scaleHint')}
        min={LIMITS.scale.min}
        max={LIMITS.scale.max}
        step={0.05}
        value={settings.toolbar.scale}
        display={t('toolbar.scaleValue', { percent: scalePercent(settings.toolbar.scale) })}
        onChange={(next) => { update({ toolbar: { scale: next } }) }}
      />
    </SectionCard>
  )
}
