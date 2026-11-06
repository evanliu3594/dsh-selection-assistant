/** Translation-language card: destination language plus the fallback used when text is already in it. */
import { LANGUAGES, languageLabel, type Settings, type SettingsPatch } from '../../contract.ts'
import { SectionCard, SelectField, type Translate } from '../ui.tsx'

/** Props the page hands the translation-language card. */
export interface LanguageSectionProps {
  t: Translate
  settings: Settings
  update: (patch: SettingsPatch) => void
}

/**
 * Render the translation-language card.
 * @param props - settings and the patch writer.
 * @returns the card element.
 */
export function LanguageSection({ t, settings, update }: LanguageSectionProps) {
  const language = settings.language
  // Labels follow the UI locale, values stay language codes so the host can
  // compare them without translating.
  const options = LANGUAGES.map(entry => ({
    value: entry.code,
    label: languageLabel(entry.code, language.ui),
  }))
  return (
    <SectionCard title={t('language.title')} desc={t('language.desc')}>
      <SelectField
        label={t('language.target')}
        value={language.target}
        options={options}
        onChange={(next) => { update({ language: { target: next } }) }}
      />
      <SelectField
        label={t('language.fallback')}
        value={language.fallback}
        options={options}
        onChange={(next) => { update({ language: { fallback: next } }) }}
      />
      <p className="sa-row-hint">{t('language.hint')}</p>
    </SectionCard>
  )
}
