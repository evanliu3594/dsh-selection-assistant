/** App-filter card: where the assistant is allowed to trigger. */
import { useState } from 'react'
import { Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFilterMode, Settings, SettingsPatch } from '../../contract.ts'
import { FieldRow, SectionCard, type Translate } from '../ui.tsx'

/** Props the page hands the app-filter card. */
export interface AppFilterSectionProps {
  t: Translate
  settings: Settings
  update: (patch: SettingsPatch) => void
}

/**
 * Split the comma-separated process list the user typed.
 * @param value - raw input text.
 * @returns trimmed, non-empty process names.
 */
function parseProcesses(value: string): string[] {
  return value.split(',').map(part => part.trim()).filter(part => part !== '')
}

/**
 * Render the app-filter card.
 * @param props - settings and the patch writer.
 * @returns the card element.
 */
export function AppFilterSection({ t, settings, update }: AppFilterSectionProps) {
  const [processes, setProcesses] = useState(settings.appFilter.processes.join(', '))
  const mode = settings.appFilter.mode

  const changeMode = (next: AppFilterMode): void => {
    update({ appFilter: { mode: next } })
  }

  const changeProcesses = (next: string): void => {
    setProcesses(next)
    update({ appFilter: { processes: parseProcesses(next) } })
  }

  const hints: Record<AppFilterMode, string> = {
    off: t('appFilter.offHint'),
    blacklist: t('appFilter.blacklistHint'),
    whitelist: t('appFilter.whitelistHint'),
  }

  return (
    <SectionCard title={t('appFilter.title')} desc={t('appFilter.desc')}>
      <SegmentedControl
        id="sa-app-filter"
        value={mode}
        label={t('appFilter.selector')}
        options={[
          { value: 'off', label: t('appFilter.off') },
          { value: 'blacklist', label: t('appFilter.blacklist') },
          { value: 'whitelist', label: t('appFilter.whitelist') },
        ]}
        onChange={changeMode}
      />
      <div
        id={`sa-app-filter-${mode}-panel`}
        role="tabpanel"
        aria-labelledby={`sa-app-filter-${mode}`}
        style={{ marginTop: '10px' }}
      >
        <p className="sa-row-hint">{hints[mode]}</p>
        {mode !== 'off' && (
          <FieldRow label={t('appFilter.processes')} hint={t('appFilter.processesHint')}>
            <Input
              className="sa-input-wide"
              value={processes}
              aria-label={t('appFilter.processes')}
              placeholder={t('appFilter.processesPlaceholder')}
              onChange={(event) => { changeProcesses(event.currentTarget.value) }}
              onBlur={() => { setProcesses(parseProcesses(processes).join(', ')) }}
            />
          </FieldRow>
        )}
      </div>
    </SectionCard>
  )
}
