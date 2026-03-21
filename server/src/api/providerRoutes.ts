import { Router, Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger.js';
import { requireReadWriteAuth } from '../utils/auth.js';
import {
  getRegistry,
  getProvider,
  getProvidersByCategory,
  getEnabledProviders,
  addProvider,
  updateProvider,
  removeProvider,
  toggleProvider,
  type ProviderCategory,
  type ProviderDefinition,
} from '../providers/registry.js';
import { KeyManager } from '../providers/keyManager.js';
import { ProviderFactory } from '../providers/providerFactory.js';
import { getProviderHealthMap, checkAllProviders } from '../providers/healthChecker.js';
import { scanOAuthCredentials, refreshOAuthToken, type OAuthCredential } from '../providers/oauthDetector.js';
import { setManagedSetting } from '../config/settingsSecurity.js';

const log = createLogger('ProviderRoutes');
const router = Router();
router.use(requireReadWriteAuth('viewer'));

// Helper to safely get string from params
function getParamString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : (value || '');
}

function dedupeModels(models: string[]): string[] {
  return Array.from(new Set(models.map((m) => m.trim()).filter(Boolean)));
}

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

function filterModelsForCategory(
  models: string[],
  providerDef: ProviderDefinition
): string[] {
  if (providerDef.category !== 'embedding') {
    return dedupeModels(models);
  }

  const filtered = models.filter((m) => {
    const name = m.toLowerCase();
    return name.includes('embedding') || name.startsWith('text-embedding-');
  });
  return dedupeModels(filtered);
}

function getEmbeddingFallbackModels(providerDef: ProviderDefinition): string[] {
  if (providerDef.category !== 'embedding') {
    return [];
  }

  const configuredChain = parseCsvEnv(process.env.GEMINI_EMBEDDING_MODELS);
  const configuredPrimary = process.env.GEMINI_EMBEDDING_MODEL?.trim();
  const configuredFallback = parseCsvEnv(process.env.GEMINI_EMBEDDING_FALLBACK_MODELS);

  const knownGeminiEmbeddingModels = [
    'gemini-embedding-001',
    'text-embedding-004',
    'gemini-embedding-002',
  ];

  if (providerDef.id === 'gemini-embedding') {
    return dedupeModels([
      ...configuredChain,
      ...(configuredPrimary ? [configuredPrimary] : []),
      ...configuredFallback,
      ...knownGeminiEmbeddingModels,
      ...(providerDef.models || []),
      providerDef.defaultModel || '',
    ]);
  }

  return dedupeModels([
    ...(providerDef.models || []),
    providerDef.defaultModel || '',
  ]);
}

// GET /api/providers - List all providers
router.get('/', async (_req: Request, res: Response) => {
  try {
    const registry = getRegistry();
    const providersWithStatus = await Promise.all(
      Object.values(registry.providers).map(async (provider) => ({
        ...provider,
        configured: provider.requiresAuth ? !!(await KeyManager.getKey(provider.id)) : true,
      }))
    );

    res.json({
      success: true,
      providers: providersWithStatus,
      totalCount: providersWithStatus.length,
    });
  } catch (error: any) {
    log.error('Failed to list providers', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to list providers' });
  }
});

// GET /api/providers/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = getParamString(req.params.id);
    const provider = getProvider(id);

    if (!provider) {
      return res.status(404).json({ success: false, error: 'Provider not found' });
    }

    const configured = provider.requiresAuth ? !!(await KeyManager.getKey(id)) : true;
    res.json({
      success: true,
      provider: { ...provider, configured },
    });
  } catch (error: any) {
    log.error('Failed to get provider', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to get provider' });
  }
});

// GET /api/providers/:id/models
router.get('/:id/models', async (req: Request, res: Response) => {
  try {
    const id = getParamString(req.params.id);
    const providerDef = getProvider(id);

    if (!providerDef) {
      return res.status(404).json({ success: false, error: 'Provider not found' });
    }

    // Try to get API key and create live provider instance
    const key = await KeyManager.getKey(id);
    let liveModels: string[] = [];
    let source: 'api' | 'registry' = 'registry';

    if (key) {
      try {
        const instance = await ProviderFactory.createProvider(id, key);
        if (instance && typeof instance.listModels === 'function') {
          liveModels = await instance.listModels();
          if (liveModels.length > 0) {
            source = 'api';
          }
        }
      } catch (apiErr: any) {
        const errStr = String(apiErr?.message || apiErr || '');
        // Downgrade auth failures to debug — CLI providers without valid API keys
        // (e.g. kilo-cli) will constantly 401 and spam the logs otherwise.
        if (/401|403|auth|token|credential/i.test(errStr)) {
          log.info(`Skipped live model listing for "${id}" (auth not available)`);
        } else {
          log.warn('Failed to fetch live models, using registry fallback', {
            provider: id,
            error: errStr.slice(0, 200),
          });
        }
      }
    }

    const registryModels = providerDef.models || [];
    const categoryLiveModels = filterModelsForCategory(liveModels, providerDef);
    const categoryRegistryModels = filterModelsForCategory(registryModels, providerDef);
    const categoryFallbackModels = getEmbeddingFallbackModels(providerDef);

    let allModels = dedupeModels([
      ...categoryLiveModels,
      ...categoryRegistryModels,
      ...categoryFallbackModels,
    ]);

    if (allModels.length === 0 && providerDef.defaultModel) {
      allModels = [providerDef.defaultModel];
    }

    // Persist loaded models into registry so they survive page reload
    if (categoryLiveModels.length > 0 && allModels.length > registryModels.length) {
      try {
        updateProvider(id, { models: allModels });
        log.info(`Persisted ${allModels.length} models for provider "${id}" (was ${registryModels.length})`);
      } catch (persistErr) {
        log.warn(`Failed to persist models for "${id}": ${String(persistErr)}`);
      }
    }

    res.json({
      success: true,
      models: allModels,
      defaultModel: providerDef.defaultModel,
      source: categoryLiveModels.length > 0 ? 'api' : source,
      liveCount: categoryLiveModels.length,
      registryCount: categoryRegistryModels.length,
    });
  } catch (error) {
    log.error('Failed to list models', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to list models' });
  }
});

// POST /api/providers/:id/key
router.post('/:id/key', async (req: Request, res: Response) => {
  try {
    const id = getParamString(req.params.id);
    const { key } = req.body as { key?: string };

    if (!key || typeof key !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid key' });
    }

    const provider = getProvider(id);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Provider not found' });
    }

    const success = await KeyManager.setKey(id, key, 'dashboard');
    if (success) {
      res.json({ success: true, message: 'Key saved' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save key' });
    }
  } catch (error) {
    log.error('Failed to set key', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to set key' });
  }
});

// DELETE /api/providers/:id/key
router.delete('/:id/key', async (req: Request, res: Response) => {
  try {
    const id = getParamString(req.params.id);
    const provider = getProvider(id);

    if (!provider) {
      return res.status(404).json({ success: false, error: 'Provider not found' });
    }

    const success = await KeyManager.deleteKey(id);
    if (success) {
      res.json({ success: true, message: 'Key deleted' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to delete key' });
    }
  } catch (error) {
    log.error('Failed to delete key', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to delete key' });
  }
});

// POST /api/providers/:id/test
router.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const id = getParamString(req.params.id);
    const provider = getProvider(id);

    if (!provider) {
      return res.status(404).json({ success: false, error: 'Provider not found' });
    }

    const key = await KeyManager.getKey(id);
    if (!key) {
      return res.status(400).json({ success: false, error: 'No API key configured' });
    }

    const instance = await ProviderFactory.createProvider(id, key);
    if (instance) {
      res.json({ success: true, message: 'Connection successful' });
    } else {
      res.status(400).json({ success: false, error: 'Connection failed' });
    }
  } catch (error) {
    log.error('Failed to test provider', { error: String(error) });
    res.status(500).json({ success: false, error: 'Test failed' });
  }
});

// GET /api/providers/category/:category
router.get('/category/:category', async (req: Request, res: Response) => {
  try {
    const category = getParamString(req.params.category) as ProviderCategory;
    const providers = getProvidersByCategory(category);
    const withStatus = await Promise.all(
      providers.map(async (p) => ({
        ...p,
        configured: !!(await KeyManager.getKey(p.id)),
      }))
    );

    res.json({
      success: true,
      category,
      providers: withStatus,
      count: withStatus.length,
    });
  } catch (error) {
    log.error('Failed to get providers by category', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to get providers by category' });
  }
});

// POST /api/providers - Add a new custom provider
router.post('/', (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<ProviderDefinition>;

    if (!body.id || !body.name || !body.category) {
      return res.status(400).json({ success: false, error: 'Missing required fields: id, name, category' });
    }

    // Check if already exists
    const existing = getProvider(body.id);
    if (existing) {
      return res.status(409).json({ success: false, error: 'Provider already exists' });
    }

    const newProvider: ProviderDefinition = {
      id: body.id,
      name: body.name,
      category: body.category as ProviderCategory,
      type: (body.type || 'openai-compatible') as any,
      baseUrl: body.baseUrl || '',
      defaultModel: body.defaultModel || '',
      models: body.models || [],
      capabilities: body.capabilities || {},
      requiresAuth: body.requiresAuth !== false,
      apiKeyEnvVar: body.apiKeyEnvVar || `${body.id.toUpperCase().replace(/-/g, '_')}_API_KEY`,
      enabled: body.enabled !== false,
      endpointTemplate: body.endpointTemplate,
      notes: body.notes,
      customHeaders: body.customHeaders,
      extraConfig: body.extraConfig,
    };

    addProvider(newProvider);
    res.json({ success: true, provider: newProvider });
  } catch (error) {
    log.error('Failed to add provider', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to add provider' });
  }
});

// PUT /api/providers/:id - Update provider settings
router.put('/:id', (req: Request, res: Response) => {
  try {
    const id = getParamString(req.params.id);
    const updates = req.body as Partial<ProviderDefinition>;

    const success = updateProvider(id, updates);
    if (success) {
      res.json({ success: true, message: 'Provider updated' });
    } else {
      res.status(404).json({ success: false, error: 'Provider not found' });
    }
  } catch (error) {
    log.error('Failed to update provider', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to update provider' });
  }
});

// DELETE /api/providers/:id - Remove a custom provider
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const id = getParamString(req.params.id);
    const success = removeProvider(id);
    if (success) {
      res.json({ success: true, message: 'Provider removed' });
    } else {
      res.status(404).json({ success: false, error: 'Provider not found' });
    }
  } catch (error) {
    log.error('Failed to remove provider', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to remove provider' });
  }
});

// POST /api/providers/:id/toggle - Toggle provider enabled/disabled
router.post('/:id/toggle', (req: Request, res: Response) => {
  try {
    const id = getParamString(req.params.id);
    const { enabled } = req.body as { enabled?: boolean };

    const success = toggleProvider(id, enabled);
    if (success) {
      const provider = getProvider(id);
      res.json({ success: true, enabled: provider?.enabled });
    } else {
      res.status(404).json({ success: false, error: 'Provider not found' });
    }
  } catch (error) {
    log.error('Failed to toggle provider', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to toggle provider' });
  }
});

// GET /api/providers/health/all — get all provider health status
router.get('/health/all', (_req: Request, res: Response) => {
  try {
    const healthMap = getProviderHealthMap();
    res.json({ success: true, health: healthMap });
  } catch (error) {
    log.error('Failed to get health map', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to get health' });
  }
});

// POST /api/providers/health/check — trigger immediate health check
router.post('/health/check', async (_req: Request, res: Response) => {
  try {
    const results = await checkAllProviders();
    res.json({ success: true, health: results });
  } catch (error) {
    log.error('Health check failed', { error: String(error) });
    res.status(500).json({ success: false, error: 'Health check failed' });
  }
});

// ─── OAuth Detection Endpoints ─────────────────────────────────────────────

// POST /api/providers/oauth/scan — scan machine for CLI OAuth credentials
router.post('/oauth/scan', async (_req: Request, res: Response) => {
  try {
    const result = await scanOAuthCredentials();
    res.json({ success: true, ...result });
  } catch (error) {
    log.error('OAuth scan failed', { error: String(error) });
    res.status(500).json({ success: false, error: 'OAuth scan failed' });
  }
});

// POST /api/providers/oauth/register — register a detected OAuth provider into the registry
router.post('/oauth/register', async (req: Request, res: Response) => {
  try {
    const cred = req.body as OAuthCredential;
    if (!cred?.providerId || !cred?.name) {
      res.status(400).json({ success: false, error: 'Missing providerId or name' });
      return;
    }

    // Check if already exists
    const existing = getProvider(cred.providerId);
    if (existing) {
      // Update existing provider with OAuth info
      updateProvider(cred.providerId, {
        enabled: true,
        baseUrl: cred.baseUrl || existing.baseUrl,
        defaultModel: cred.defaultModel || existing.defaultModel,
        models: cred.models && cred.models.length > 0 ? cred.models : existing.models,
        notes: `OAuth via ${cred.cliTool} CLI — ${cred.source}`,
        requiresAuth: !!cred.accessToken,
      });

      // Store the access token if available
      if (cred.accessToken) {
        await KeyManager.setKey(cred.providerId, cred.accessToken, 'dashboard');
      }

      res.json({ success: true, action: 'updated', providerId: cred.providerId });
      return;
    }

    // Create new provider definition
    const providerDef: ProviderDefinition = {
      id: cred.providerId,
      name: cred.name,
      category: cred.category,
      type: cred.providerType,
      baseUrl: cred.baseUrl,
      defaultModel: cred.defaultModel,
      models: cred.models || [],
      capabilities: {
        chat: cred.category === 'llm',
        streaming: true,
        functionCalling: cred.providerType !== 'rest-api',
      },
      requiresAuth: !!cred.accessToken,
      apiKeyEnvVar: `${cred.providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`,
      enabled: true,
      notes: `OAuth via ${cred.cliTool} CLI — ${cred.source}`,
    };

    addProvider(providerDef);

    // Store the access token
    if (cred.accessToken) {
      await KeyManager.setKey(cred.providerId, cred.accessToken, 'dashboard');
    }

    res.json({ success: true, action: 'created', providerId: cred.providerId });
  } catch (error) {
    log.error('OAuth register failed', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to register OAuth provider' });
  }
});

// POST /api/providers/oauth/refresh/:id — refresh a specific OAuth token
router.post('/oauth/refresh/:id', async (req: Request, res: Response) => {
  try {
    const providerId = getParamString(req.params.id);
    const refreshed = refreshOAuthToken(providerId);
    if (!refreshed) {
      res.status(404).json({ success: false, error: `No OAuth detector for ${providerId}` });
      return;
    }

    if (refreshed.valid && refreshed.accessToken) {
      await KeyManager.setKey(providerId, refreshed.accessToken, 'dashboard');
    }

    res.json({ success: true, credential: { ...refreshed, accessToken: undefined } });
  } catch (error) {
    log.error('OAuth refresh failed', { error: String(error) });
    res.status(500).json({ success: false, error: 'Failed to refresh OAuth token' });
  }
});

export default router;
