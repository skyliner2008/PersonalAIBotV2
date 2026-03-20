import { Router } from 'express';
import { dbAll } from '../../database/db.js';
import { sanitizeSettingsRows, setManagedSetting } from '../../config/settingsSecurity.js';
import { requireReadWriteAuth } from '../../utils/auth.js';

const settingsRoutes = Router();
settingsRoutes.use(requireReadWriteAuth('viewer'));

settingsRoutes.get('/settings', (_req, res) => {
  const rows = dbAll<{ key: string; value: string; updated_at?: string }>('SELECT * FROM settings');
  res.json(sanitizeSettingsRows(rows));
});

const VALID_KEY_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const isValidKey = (key: string) => VALID_KEY_PATTERN.test(key);

settingsRoutes.post('/settings', (req, res) => {
  try {
    const { key, value } = req.body || {};

    if (typeof key === 'string' && value !== undefined && value !== null) {
      if (!isValidKey(key)) {
        return res.status(400).json({ success: false, error: `Invalid key format: ${key}` });
      }
      if (typeof value === 'object') {
        return res.status(400).json({ success: false, error: `Invalid value format for key: ${key}` });
      }
      setManagedSetting(key, String(value));
    } else {
      if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
        return res.status(400).json({ success: false, error: 'Invalid body format' });
      }
      const entries = req.body as Record<string, unknown>;
      for (const [k, v] of Object.entries(entries)) {
        if (k === 'key' || k === 'value') continue;
        if (!isValidKey(k)) {
          return res.status(400).json({ success: false, error: `Invalid key format: ${k}` });
        }
        if (v !== undefined && v !== null && typeof v === 'object') {
          return res.status(400).json({ success: false, error: `Invalid value format for key: ${k}` });
        }
        setManagedSetting(k, String(v ?? ''));
      }
    }

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default settingsRoutes;
