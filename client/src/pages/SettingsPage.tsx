import { FormEvent, useEffect, useState } from 'react';
import type {
  AppSettings,
  HardwareAcceleration,
  VaapiDriver,
  ValidateSettingsResult,
  VideoCodec,
} from '@promo/shared';
import { api } from '../api';

const HW: HardwareAcceleration[] = ['None', 'Nvenc', 'Qsv', 'Vaapi', 'Amf', 'VideoToolbox'];
const DRIVERS: VaapiDriver[] = ['Default', 'iHD', 'i965', 'RadeonSI', 'Nouveau'];
const CODECS: VideoCodec[] = ['H264', 'Hevc'];

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [message, setMessage] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidateSettingsResult | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(String(e.message || e)));
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
      setMessage('Settings saved.');
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
    <form className="panel" onSubmit={onSubmit}>
      <h1>Settings</h1>
      <p className="muted">ErsatzTV connection, media paths, encoding, and voice-over.</p>

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
      </div>

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
        {field('port', 'HTTP port', 'number')}
      </div>

      <div className="row" style={{ marginTop: 18 }}>
        <button type="submit" disabled={saving || validating}>{saving ? 'Saving…' : 'Save settings'}</button>
        <button
          type="button"
          className="secondary"
          disabled={saving || validating}
          onClick={() => void onValidate()}
        >
          {validating ? 'Validating…' : 'Validate settings'}
        </button>
        {message && <span className={validation && !validation.ok ? 'error' : 'success'}>{message}</span>}
        {error && <span className="error">{error}</span>}
      </div>

      {validation && (
        <div style={{ marginTop: 16 }}>
          <h3>Validation {validation.ok ? 'passed' : 'failed'}</h3>
          <ul className="item-list">
            {validation.checks.map((c) => (
              <li key={c.id} className={c.ok ? 'success' : 'error'}>
                <strong>{c.label}</strong>: {c.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
