/** Model card: global provider/model, reasoning effort, and temperature. */
import { useState } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProviderOption, Settings, SettingsPatch } from '../../contract.ts'
import { FieldRow, SectionCard, SelectField, type SelectOption, type Translate } from '../ui.tsx'

/** Model catalogue status as loaded by the page. */
export type ModelsPhase = 'loading' | 'ready' | 'error'

/** Props the page hands the model card. */
export interface ModelSectionProps {
  t: Translate
  settings: Settings
  update: (patch: SettingsPatch) => void
  providers: ProviderOption[]
  defaults: { provider: string; model: string; reasoningEffort: string }
  modelsPhase: ModelsPhase
}

/**
 * Render the model card.
 * @param props - settings, catalogue, and the patch writer.
 * @returns the card element.
 */
export function ModelSection({ t, settings, update, providers, defaults, modelsPhase }: ModelSectionProps) {
  const [temperature, setTemperature] = useState(
    settings.model.temperature === null ? '' : String(settings.model.temperature),
  )
  const [temperatureError, setTemperatureError] = useState(false)

  const provider = settings.model.provider
  const selectedProvider = providers.find(entry => entry.provider === provider)
  const providerOptions: SelectOption[] = [
    { value: '', label: t('model.followDefault') },
    ...providers.map(entry => ({ value: entry.provider, label: entry.name !== '' ? entry.name : entry.provider })),
  ]
  const modelOptions: SelectOption[] = [
    { value: '', label: t('model.followDefault') },
    ...(selectedProvider === undefined
      ? []
      : selectedProvider.models.map(model => ({ value: model.id, label: model.name !== '' ? model.name : model.id }))),
  ]
  const selectedModel = selectedProvider?.models.find(model => model.id === settings.model.model)
  const reasoningOptions: SelectOption[] = [
    { value: '', label: t('model.reasoningDefault') },
    ...(selectedModel === undefined
      ? []
      : selectedModel.reasoningEfforts.map(effort => ({
        value: effort.id,
        label: effort.name !== '' ? effort.name : effort.id,
      }))),
  ]

  const defaultProvider = defaults.provider !== '' ? defaults.provider : t('common.none')
  const defaultModel = defaults.model !== '' ? defaults.model : t('common.none')

  const changeTemperature = (next: string): void => {
    setTemperature(next)
    if (next.trim() === '') {
      setTemperatureError(false)
      update({ model: { temperature: null } })
      return
    }
    const parsed = Number(next)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
      setTemperatureError(true)
      return
    }
    setTemperatureError(false)
    update({ model: { temperature: parsed } })
  }

  return (
    <SectionCard title={t('model.title')} desc={t('model.desc')}>
      {modelsPhase === 'loading' && <p className="sa-row-hint">{t('model.loading')}</p>}
      {modelsPhase === 'error' && <p className="sa-warn-text">{t('model.noProviders')}</p>}
      <SelectField
        label={t('model.provider')}
        hint={t('model.defaultInfo', { provider: defaultProvider, model: defaultModel })}
        value={provider}
        options={providerOptions}
        onChange={(next) => { update({ model: { provider: next, model: '', reasoningEffort: '' } }) }}
      />
      <SelectField
        label={t('model.model')}
        value={settings.model.model}
        options={modelOptions}
        disabled={provider === ''}
        onChange={(next) => { update({ model: { model: next, reasoningEffort: '' } }) }}
      />
      <SelectField
        label={t('model.reasoning')}
        hint={t('model.reasoningHint')}
        value={settings.model.reasoningEffort}
        options={reasoningOptions}
        disabled={selectedModel === undefined || selectedModel.reasoningEfforts.length === 0}
        onChange={(next) => { update({ model: { reasoningEffort: next } }) }}
      />
      <FieldRow label={t('model.temperature')} hint={t('model.temperatureHint')}>
        <Input
          className="sa-input-narrow"
          inputMode="decimal"
          value={temperature}
          aria-label={t('model.temperature')}
          placeholder={t('model.temperaturePlaceholder')}
          onChange={(event) => { changeTemperature(event.currentTarget.value) }}
        />
      </FieldRow>
      {temperatureError && (
        <p className="sa-field-error" role="alert">{t('model.temperatureInvalid')}</p>
      )}
    </SectionCard>
  )
}
