import { FormEvent, useEffect, useState } from 'react';
import type {
  AppSettings,
  HardwareAcceleration,
  PromoItemCount,
  ShowVoiceDetail,
  VaapiDriver,
  ValidateSettingsResult,
  VideoCodec,
  VoiceProvider,
} from '@promo/shared';
import {
  CHANNEL_LANGUAGES,
  PROMO_ITEM_COUNTS,
  SHOW_VOICE_DETAIL_LABELS,
  SHOW_VOICE_DETAILS,
  VOICE_PROVIDER_LABELS,
  VOICE_PROVIDERS,
} from '@promo/shared';
import { api } from '../api';

const HW: HardwareAcceleration[] = ['None', 'Nvenc', 'Qsv', 'Vaapi', 'Amf', 'VideoToolbox'];
const DRIVERS: VaapiDriver[] = ['Default', 'iHD', 'i965', 'RadeonSI', 'Nouveau'];
const CODECS: VideoCodec[] = ['H264', 'Hevc'];

function usesPiper(provider: VoiceProvider): boolean {
  return provider === 'auto' || provider === 'piper';
}

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [savedToFile, setSavedToFile] = useState(false);
  const [message, setMessage] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [validation, setValidation] = useState<ValidateSettingsResult | null>(null);

  useEffect(() => {
    Promise.all([api.getSettings(), api.getSettingsStatus()])
      .then(([s, status]) => {
        setSettings(s);
        setSavedToFile(status.saved);
      })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const saved = await api.saveSettings(settings);
      setSettings(saved);
      setSavedToFile(true);
      setMessage('Settings saved to config (override env/defaults).');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function onValidate() {
    if (!settings) return;
    setValidating(true);
    setError('');
    setMessage('');
    try {
      const result = await api.validateSettings(settings);
      setValidation(result);
      setMessage(result.ok ? 'All checks passed.' : 'Some checks failed — see below.');
    } catch (err) {
      setValidation(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  }

  async function onClearSaved() {
    if (!window.confirm(
      'Clear saved UI settings? Values will fall back to environment variables, then built-in defaults.',
    )) {
      return;
    }
    setClearing(true);
    setMessage('');
    setError('');
    setValidation(null);
    try {
      const next = await api.clearSavedSettings();
      setSettings(next);
      setSavedToFile(false);
      setMessage('Cleared saved settings — now using env/defaults.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  }

  if (!settings) {
    return <div className="panel">{error || 'Loading settings…'}</div>;
  }

  function field<K extends keyof AppSettings>(key: K, label: string, type: string = 'text') {
    return (
      <label>
        {label}
        <input
          type={type}
          value={String(settings![key] ?? '')}
          onChange={(e) => {
            const raw = e.target.value;
            const value =
              type === 'number'
                ? Number(raw)
                : type === 'checkbox'
                  ? e.target.checked
                  : raw;
            setSettings({ ...settings!, [key]: value as AppSettings[K] });
            setValidation(null);
          }}
          checked={type === 'checkbox' ? Boolean(settings![key]) : undefined}
        />
      </label>
    );
  }

  return (
    <form className="panel settings-page" onSubmit={onSubmit}>
      <h1>Settings</h1>
      <p className="muted">
        ErsatzTV connection, media paths, encoding, and voice-over.
        {' '}
        {savedToFile
          ? 'Saved values override env/defaults.'
          : 'No UI save yet — showing env/defaults.'}
      </p>

      <section>
        <h2>ErsatzTV</h2>
        <div className="settings-grid">
          {field('etvUrl', 'ErsatzTV URL')}
          {field('etvApiKey', 'API key (X-Etv-Api-Key)')}
          {field('etvDatabase', 'ersatztv.sqlite3 path')}
          {field('libraryPath', 'Library path (local mount)')}
          {field('etvPathPrefix', 'ErsatzTV path prefix to rewrite')}
          {field('outputPath', 'Output path')}
          {field('etvLibraryPath', 'ErsatzTV library path (as ETV sees promos)')}
          {field('cachePath', 'Cache path')}
          {field('regenLeadMinutes', 'Regen lead time (minutes)', 'number')}
          {field('timeZone', 'Display timezone (IANA, e.g. America/New_York)')}
        </div>
      </section>

      <section>
        <h2>Encoding</h2>
        <div className="settings-grid">
          <label>
            Hardware acceleration
            <select
              value={settings.hardwareAcceleration}
              onChange={(e) => {
                setSettings({ ...settings, hardwareAcceleration: e.target.value as HardwareAcceleration });
                setValidation(null);
              }}
            >
              {HW.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
          <label>
            Video codec
            <select
              value={settings.videoCodec}
              onChange={(e) => {
                setSettings({ ...settings, videoCodec: e.target.value as VideoCodec });
                setValidation(null);
              }}
            >
              {CODECS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {field('resolution', 'Resolution (e.g. 1920x1080)')}
          {field('videoBitrate', 'Video bitrate (kbps)', 'number')}
          {field('audioBitrate', 'Audio bitrate (kbps)', 'number')}
          {field('videoPreset', 'Video preset')}
          {field('videoProfile', 'Video profile')}
          {field('vaapiDevice', 'VAAPI device')}
          <label>
            VAAPI driver
            <select
              value={settings.vaapiDriver}
              onChange={(e) => {
                setSettings({ ...settings, vaapiDriver: e.target.value as VaapiDriver });
                setValidation(null);
              }}
            >
              {DRIVERS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          {field('vaapiDisplay', 'VAAPI display')}
        </div>
      </section>

      <section>
        <h2>Graphics</h2>
        <div className="settings-grid">
          <label>
            Items in promo
            <select
              value={settings.promoItemCount ?? 3}
              onChange={(e) => {
                setSettings({
                  ...settings,
                  promoItemCount: Number(e.target.value) as PromoItemCount,
                });
                setValidation(null);
              }}
            >
              {PROMO_ITEM_COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n} item{n === 1 ? '' : 's'} ({n * 10}s)
                </option>
              ))}
            </select>
          </label>
          <label>
            Lower-third width
            <select
              value={settings.lowerThirdFullWidth ? 'full' : 'follow'}
              onChange={(e) => {
                setSettings({ ...settings, lowerThirdFullWidth: e.target.value === 'full' });
                setValidation(null);
              }}
            >
              <option value="follow">Follow focused item (slides)</option>
              <option value="full">Full width, fixed left</option>
            </select>
          </label>
        </div>
      </section>

      <section>
        <h2>Audio</h2>
        <div className="settings-grid">
          <label>
            Original item volume
            <div className="range-row">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={settings.sourceAudioVolume ?? 0}
                onChange={(e) => {
                  setSettings({
                    ...settings,
                    sourceAudioVolume: Number(e.target.value),
                  });
                  setValidation(null);
                }}
              />
              <span className="range-value">
                {typeof settings.sourceAudioVolume === 'undefined' || settings.sourceAudioVolume <= 0 ? 'Skip' : `${settings.sourceAudioVolume}%`}
              </span>
            </div>
          </label>
          {(settings.sourceAudioVolume ?? 0) > 0 && (
            <label>
              Play original audio after voice-over
              <select
                value={settings.sourceAudioAfterVoice ? 'true' : 'false'}
                onChange={(e) => {
                  setSettings({
                    ...settings,
                    sourceAudioAfterVoice: e.target.value === 'true',
                  });
                  setValidation(null);
                }}
              >
                <option value="true">On — mute until VO ends</option>
                <option value="false">Off — mix under VO</option>
              </select>
            </label>
          )}
        </div>
      </section>

      <section>
        <h2>Voice</h2>
        <div className="settings-grid">
          <label>
            Enable voice-over
            <select
              value={settings.voiceEnabled ? 'true' : 'false'}
              onChange={(e) => {
                setSettings({ ...settings, voiceEnabled: e.target.value === 'true' });
                setValidation(null);
              }}
            >
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          </label>
        </div>

        {settings.voiceEnabled && (
          <div className="settings-grid">
            <label>
              Voice provider
              <select
                value={settings.voiceProvider}
                onChange={(e) => {
                  setSettings({
                    ...settings,
                    voiceProvider: e.target.value as VoiceProvider,
                  });
                  setValidation(null);
                }}
              >
                {VOICE_PROVIDERS.map((provider) => (
                  <option key={provider} value={provider}>
                    {VOICE_PROVIDER_LABELS[provider]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Show voice detail
              <select
                value={settings.showVoiceDetail}
                onChange={(e) => {
                  setSettings({
                    ...settings,
                    showVoiceDetail: e.target.value as ShowVoiceDetail,
                  });
                  setValidation(null);
                }}
              >
                {SHOW_VOICE_DETAILS.map((mode) => (
                  <option key={mode} value={mode}>
                    {SHOW_VOICE_DETAIL_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
            {field('voicePauseMs', 'Cue→title pause (ms)', 'number')}
            {field('ttsTimeoutMs', 'TTS timeout (ms)', 'number')}
          </div>
        )}

        {settings.voiceEnabled && usesPiper(settings.voiceProvider) && (
          <>
          <div className="settings-sub-section">
            <h3>Piper / Wyoming</h3>
            <p className="muted">
              Used when provider is Auto or Piper. Leave language overrides empty to use the defaults above.
            </p>
            <div className="settings-grid">
              {field('piperUrl', 'Piper URL')}
              {field('piperVoice', 'Default Piper voice')}
              {field('piperSpeaker', 'Default Piper speaker (optional)')}
            </div>
            </div>
            <div className="settings-sub-section">
            <h3 style={{ fontSize: 15 }}>Language overrides</h3>
            <div className="settings-grid">
              {CHANNEL_LANGUAGES.map((lang) => (
                <div key={lang.code} className="settings-lang-override">
                  <div className="muted" style={{ fontSize: 12 }}>
                    {lang.label} ({lang.code})
                  </div>
                  <label>
                    Voice
                    <input
                      type="text"
                      value={settings.piperVoiceByLanguage[lang.code] ?? ''}
                      placeholder={settings.piperVoice || 'default'}
                      onChange={(e) => {
                        const next = { ...settings.piperVoiceByLanguage };
                        const value = e.target.value;
                        if (value.trim()) next[lang.code] = value;
                        else delete next[lang.code];
                        setSettings({ ...settings, piperVoiceByLanguage: next });
                        setValidation(null);
                      }}
                    />
                  </label>
                  <label>
                    Speaker
                    <input
                      type="text"
                      value={settings.piperSpeakerByLanguage[lang.code] ?? ''}
                      placeholder={settings.piperSpeaker || 'default'}
                      onChange={(e) => {
                        const next = { ...settings.piperSpeakerByLanguage };
                        const value = e.target.value;
                        if (value.trim()) next[lang.code] = value;
                        else delete next[lang.code];
                        setSettings({ ...settings, piperSpeakerByLanguage: next });
                        setValidation(null);
                      }}
                    />
                  </label>
                </div>
              ))}
            </div>
            </div></>
        )}
      </section>

      <section>
        <h2>Server</h2>
        <div className="settings-grid">
          {field('port', 'HTTP port', 'number')}
        </div>
      </section>

      <div className="row">
        <button type="submit" disabled={saving || validating || clearing}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={saving || validating || clearing}
          onClick={() => void onValidate()}
        >
          {validating ? 'Validating…' : 'Validate settings'}
        </button>
        <button
          type="button"
          className="danger"
          disabled={saving || validating || clearing || !savedToFile}
          title={savedToFile ? 'Delete settings.json and reload env/defaults' : 'Nothing saved in UI yet'}
          onClick={() => void onClearSaved()}
        >
          {clearing ? 'Clearing…' : 'Clear saved (use env/defaults)'}
        </button>
        {message && <span className={validation && !validation.ok ? 'error' : 'success'}>{message}</span>}
        {error && <span className="error">{error}</span>}
      </div>

      {validation && (
        <section>
          <h3>Validation {validation.ok ? 'passed' : 'failed'}</h3>
          <ul className="item-list">
            {validation.checks.map((c) => (
              <li key={c.id} className={c.ok ? 'success' : 'error'}>
                <strong>{c.label}</strong>: {c.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </form>
  );
}
