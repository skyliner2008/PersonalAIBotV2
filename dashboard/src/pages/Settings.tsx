import { useState, useEffect, useCallback } from 'react';
import { Save } from 'lucide-react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { FacebookSettings } from './settings/FacebookSettings';
import { APIProviders } from './settings/APIProviders';
import { GeneralSettings } from './settings/GeneralSettings';
import { RegistryProvider } from './settings/types';

interface Props {
  status: { browser: boolean; loggedIn: boolean; chatBot: boolean; commentBot: boolean };
  emit: (event: string, data?: any) => void;
  on: (event: string, handler: (...args: any[]) => void) => () => void;
}

export function Settings({ status, emit, on }: Props) {
  const { addToast } = useToast();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [registryProviders, setRegistryProviders] = useState<RegistryProvider[]>([]);

  // Load initial data
  useEffect(() => {
    loadSettings();
    loadProviders();
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const data = await api.getSettings();
      const map: Record<string, string> = {};
      if (Array.isArray(data)) {
        data.forEach((s: any) => { map[s.key] = s.value; });
      } else {
        Object.assign(map, data);
      }
      setSettings(map);
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const result = await api.getProviders();
      if (result.providers) {
        setRegistryProviders(result.providers);
      }
    } catch (e) {
      console.warn('Failed to load providers from registry');
    }
  }, []);

  const updateSetting = useCallback((key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await api.setSettingsBulk(settings);
      addToast('success', 'Settings saved successfully');
    } catch (e) {
      console.error('Failed to save settings:', e);
      addToast('error', e instanceof Error ? e.message : 'Failed to save settings');
    }
    setSaving(false);
  }, [settings, addToast]);

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <h2 className="text-2xl font-bold text-white">Settings</h2>

      {/* Facebook Settings */}
      <FacebookSettings status={status} emit={emit} on={on} />

      {/* API Providers */}
      <APIProviders
        registryProviders={registryProviders}
        onProvidersUpdate={setRegistryProviders}
      />

      {/* General Settings */}
      <GeneralSettings
        settings={settings}
        onSettingChange={updateSetting}
      />

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-6 py-2.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 text-sm font-medium border border-blue-500/30 disabled:opacity-50"
        >
          <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}
