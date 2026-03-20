import { useState, useMemo, useCallback } from 'react';
import { Key, Plus, ChevronDown, ChevronRight, Edit3, Trash2, Scan, RefreshCw, CheckCircle2, XCircle, Terminal, Loader2 } from 'lucide-react';
import { useToast } from '../../components/Toast';
import { api } from '../../services/api';
import { RegistryProvider } from './types';
import { ProviderCard } from './ProviderCard';
import { ProviderModals } from './ProviderModals';
import { CATEGORY_CONFIG } from './constants';

interface OAuthCredential {
  providerId: string;
  name: string;
  cliTool: string;
  source: string;
  valid: boolean;
  accessToken?: string;
  account?: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: string[];
  providerType: string;
  category: string;
  error?: string;
}

interface Props {
  registryProviders: RegistryProvider[];
  onProvidersUpdate: (providers: RegistryProvider[]) => void;
}

export function APIProviders({ registryProviders, onProvidersUpdate }: Props) {
  const { addToast } = useToast();
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({
    llm: true, embedding: false, search: false, tts: false, image: false, platform: false,
  });
  const [showKeyFor, setShowKeyFor] = useState<Record<string, boolean>>({});
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, boolean>>({});
  const [loadingModels, setLoadingModels] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [modelSource, setModelSource] = useState<Record<string, string>>({});
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editProvider, setEditProvider] = useState<any>(null);
  const [addCategory, setAddCategory] = useState('llm');
  const [newProvider, setNewProvider] = useState({
    id: '', name: '', type: 'openai-compatible', baseUrl: '', defaultModel: '', apiKeyEnvVar: '',
    models: '' as string, endpointTemplate: '', notes: '',
    customHeaders: '' as string,
    extraConfig: '' as string,
  });

  // OAuth detection state
  const [oauthExpanded, setOauthExpanded] = useState(false);
  const [oauthScanning, setOauthScanning] = useState(false);
  const [oauthResults, setOauthResults] = useState<OAuthCredential[]>([]);
  const [oauthScannedTools, setOauthScannedTools] = useState<string[]>([]);
  const [oauthErrors, setOauthErrors] = useState<string[]>([]);
  const [oauthRegistering, setOauthRegistering] = useState<string | null>(null);

  // Group providers by category
  const providersByCategory = useMemo(() => {
    const result: Record<string, RegistryProvider[]> = {};
    for (const p of registryProviders) {
      if (!result[p.category]) result[p.category] = [];
      result[p.category].push(p);
    }
    return result;
  }, [registryProviders]);

  const categories = Object.keys(CATEGORY_CONFIG);

  const toggleCategory = useCallback((cat: string) => {
    setExpandedCategories(prev => ({ ...prev, [cat]: !prev[cat] }));
  }, []);

  const expandAllCategories = useCallback(() => {
    const allExpanded: Record<string, boolean> = {};
    for (const cat of categories) {
      allExpanded[cat] = true;
    }
    setExpandedCategories(allExpanded);
  }, [categories]);

  const collapseAllCategories = useCallback(() => {
    const allCollapsed: Record<string, boolean> = {};
    for (const cat of categories) {
      allCollapsed[cat] = false;
    }
    setExpandedCategories(allCollapsed);
  }, [categories]);

  const handleLoadModels = useCallback(async (providerId: string) => {
    setLoadingModels(providerId);
    try {
      const result = await api.getProviderModels(providerId);
      if (result.models && result.models.length > 0) {
        setModels(prev => ({ ...prev, [providerId]: result.models }));
        setModelSource(prev => ({ ...prev, [providerId]: result.source || 'registry' }));
        addToast('success', `Loaded ${result.models.length} models for "${providerId}"`);
      } else {
        setModels(prev => ({ ...prev, [providerId]: [] }));
        setModelSource(prev => ({ ...prev, [providerId]: 'none' }));
        addToast('warning', `No models found for "${providerId}"`);
      }
    } catch (e) {
      setModels(prev => ({ ...prev, [providerId]: [] }));
      setModelSource(prev => ({ ...prev, [providerId]: 'error' }));
      addToast('error', e instanceof Error ? e.message : `Failed to load models for "${providerId}"`);
    }
    setLoadingModels(null);
  }, [addToast]);

  const handleTestProvider = useCallback(async (providerId: string) => {
    setTesting(providerId);
    try {
      const result = await api.testProvider(providerId);
      setTestResults(prev => ({ ...prev, [providerId]: result.success }));
      addToast(result.success ? 'success' : 'warning', result.success
        ? `Provider "${providerId}" connection successful`
        : `Provider "${providerId}" connection failed`);
    } catch {
      setTestResults(prev => ({ ...prev, [providerId]: false }));
      addToast('error', `Provider "${providerId}" connection failed`);
    }
    setTesting(null);
  }, [addToast]);

  const handleSaveKey = useCallback(async (providerId: string) => {
    const key = providerKeys[providerId];
    if (!key) return;
    setSavingKey(providerId);
    try {
      await api.setProviderKey(providerId, key);
      setProviderKeys(prev => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      await loadProviders();
      setTestResults(prev => { const n = { ...prev }; delete n[providerId]; return n; });
      addToast('success', `Saved key for "${providerId}"`);
    } catch (e) {
      console.error('Failed to save key:', e);
      addToast('error', e instanceof Error ? e.message : 'Failed to save provider key');
    }
    setSavingKey(null);
  }, [providerKeys, addToast]);

  const handleDeleteKey = useCallback(async (providerId: string) => {
    try {
      await api.deleteProviderKey(providerId);
      setProviderKeys(prev => { const n = { ...prev }; delete n[providerId]; return n; });
      await loadProviders();
      setTestResults(prev => { const n = { ...prev }; delete n[providerId]; return n; });
      addToast('success', `Deleted key for "${providerId}"`);
    } catch (e) {
      console.error('Failed to delete key:', e);
      addToast('error', e instanceof Error ? e.message : 'Failed to delete provider key');
    }
  }, [addToast]);

  const handleToggleProvider = useCallback(async (providerId: string) => {
    try {
      const result = await api.toggleProvider(providerId);
      await loadProviders();
      addToast('info', `Provider "${providerId}" ${result?.enabled ? 'enabled' : 'disabled'}`);
    } catch (e) {
      console.error('Failed to toggle provider:', e);
      addToast('error', e instanceof Error ? e.message : 'Failed to toggle provider');
    }
  }, [addToast]);

  const getAvailableModels = useCallback((provider: RegistryProvider): string[] => {
    return Array.from(new Set([
      ...(provider.models || []),
      ...(models[provider.id] || []),
      provider.defaultModel || '',
    ].map(model => model.trim()).filter(Boolean)));
  }, [models]);

  const getSelectedProviderModel = useCallback((provider: RegistryProvider): string => {
    if (provider.category === 'llm') {
      return provider.defaultModel || '';
    }
    return provider.defaultModel || '';
  }, []);

  const handleProviderModelChange = useCallback(async (provider: RegistryProvider, model: string) => {
    const nextModel = model.trim();
    if (!nextModel) return;
    setSavingModel(provider.id);
    try {
      await api.updateProvider(provider.id, { defaultModel: nextModel });
      addToast('success', `Updated model for "${provider.id}" → ${nextModel}`);
      await loadProviders();
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : `Failed to update model for "${provider.id}"`);
    }
    setSavingModel(null);
  }, [addToast]);

  const handleRemoveProvider = useCallback(async (providerId: string) => {
    if (!confirm(`ลบ provider "${providerId}" ออกจากระบบ?`)) return;
    try {
      await api.removeProvider(providerId);
      await loadProviders();
      addToast('success', `Removed provider "${providerId}"`);
    } catch (e) {
      console.error('Failed to remove provider:', e);
      addToast('error', e instanceof Error ? e.message : 'Failed to remove provider');
    }
  }, [addToast]);

  const loadProviders = useCallback(async () => {
    try {
      const result = await api.getProviders();
      if (result.providers) {
        onProvidersUpdate(result.providers);
        for (const provider of result.providers) {
          if (provider.configured) {
            handleLoadModels(provider.id);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load providers from registry');
    }
  }, [onProvidersUpdate, handleLoadModels]);

  const handleOAuthScan = useCallback(async () => {
    setOauthScanning(true);
    setOauthResults([]);
    setOauthErrors([]);
    try {
      const result = await api.scanOAuth();
      setOauthResults(result.detected || []);
      setOauthScannedTools(result.scannedTools || []);
      setOauthErrors(result.errors || []);
      if ((result.detected || []).length > 0) {
        addToast('success', `พบ ${result.detected.length} OAuth providers จาก CLI`);
      } else {
        addToast('info', 'ไม่พบ CLI OAuth credentials ในเครื่อง');
      }
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'OAuth scan failed');
    }
    setOauthScanning(false);
  }, [addToast]);

  const handleOAuthRegister = useCallback(async (cred: OAuthCredential) => {
    setOauthRegistering(cred.providerId);
    try {
      const result = await api.registerOAuthProvider(cred);
      addToast('success', `${result.action === 'created' ? 'เพิ่ม' : 'อัพเดท'} provider "${cred.name}" เรียบร้อย`);
      await loadProviders();
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to register provider');
    }
    setOauthRegistering(null);
  }, [addToast, loadProviders]);

  const openEditModal = useCallback((provider: RegistryProvider) => {
    setEditProvider({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl || '',
      defaultModel: provider.defaultModel || '',
      apiKeyEnvVar: provider.apiKeyEnvVar || '',
      models: (provider.models || []).join(', '),
      endpointTemplate: provider.endpointTemplate || '',
      notes: provider.notes || '',
      customHeaders: provider.customHeaders ? JSON.stringify(provider.customHeaders, null, 2) : '',
      extraConfig: provider.extraConfig ? JSON.stringify(provider.extraConfig, null, 2) : '',
      category: provider.category,
    });
    setShowEditModal(true);
  }, []);

  return (
    <>
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
            <Key className="w-4 h-4 text-yellow-400" /> API Providers
            <span className="text-[10px] text-gray-600">
              ({registryProviders.length} providers, {registryProviders.filter(p => p.configured).length} configured)
            </span>
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={expandAllCategories}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 border border-gray-700 font-medium"
            >
              Expand All
            </button>
            <button
              onClick={collapseAllCategories}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 border border-gray-700 font-medium"
            >
              Collapse All
            </button>
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-green-500/15 text-green-400 rounded-lg hover:bg-green-500/25 border border-green-500/30 font-medium"
            >
              <Plus className="w-3.5 h-3.5" /> เพิ่ม Provider ใหม่
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-500">
          จัดการ API Key สำหรับทุก provider — คลิกที่หมวดเพื่อดูรายละเอียด
        </p>

        {/* OAuth CLI Detection Section */}
        <div className="border border-violet-500/30 rounded-lg overflow-hidden">
          <button
            onClick={() => setOauthExpanded(!oauthExpanded)}
            className="w-full flex items-center justify-between px-4 py-3 bg-gradient-to-r from-violet-500/10 to-transparent hover:from-violet-500/20 transition-colors"
          >
            <div className="flex items-center gap-3">
              <Terminal className="w-4 h-4 text-violet-400" />
              <div className="text-left">
                <span className="text-xs font-semibold text-gray-200">CLI OAuth Detection</span>
                <span className="text-[10px] text-gray-500 ml-2">ตรวจหา OAuth credentials จาก CLI tools ในเครื่อง</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {oauthResults.filter(r => r.valid).length > 0 && (
                <span className="text-[10px] text-violet-300 bg-violet-500/20 px-2 py-0.5 rounded-full border border-violet-500/30">
                  {oauthResults.filter(r => r.valid).length} พร้อมใช้
                </span>
              )}
              {oauthExpanded
                ? <ChevronDown className="w-4 h-4 text-gray-500" />
                : <ChevronRight className="w-4 h-4 text-gray-500" />
              }
            </div>
          </button>

          {oauthExpanded && (
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-gray-400">
                  สแกนหา CLI OAuth tokens (gcloud, gh, az, aws, ollama, lmstudio, huggingface) เพื่อเพิ่มเป็น Provider โดยไม่ต้องกรอก API Key
                </p>
                <button
                  onClick={handleOAuthScan}
                  disabled={oauthScanning}
                  className="flex items-center gap-2 px-4 py-2 bg-violet-500/20 text-violet-300 rounded-lg hover:bg-violet-500/30 text-xs font-medium border border-violet-500/30 disabled:opacity-50 whitespace-nowrap"
                >
                  {oauthScanning
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> กำลังสแกน...</>
                    : <><Scan className="w-3.5 h-3.5" /> Scan CLI OAuth</>
                  }
                </button>
              </div>

              {/* Scanned tools list */}
              {oauthScannedTools.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {oauthScannedTools.map(tool => (
                    <span key={tool} className="text-[10px] px-2 py-0.5 bg-gray-800 text-gray-400 rounded border border-gray-700">
                      {tool}
                    </span>
                  ))}
                </div>
              )}

              {/* Errors */}
              {oauthErrors.length > 0 && (
                <div className="space-y-1">
                  {oauthErrors.map((err, i) => (
                    <p key={i} className="text-[10px] text-yellow-400 bg-yellow-500/10 px-3 py-1.5 rounded border border-yellow-500/20">
                      {err}
                    </p>
                  ))}
                </div>
              )}

              {/* Detected credentials */}
              {oauthResults.length > 0 && (
                <div className="space-y-2">
                  {oauthResults.map(cred => {
                    const isRegistered = registryProviders.some(p => p.id === cred.providerId);
                    return (
                      <div
                        key={cred.providerId}
                        className={`rounded-lg border p-3 ${
                          cred.valid
                            ? 'border-green-500/30 bg-green-500/5'
                            : 'border-gray-700 bg-gray-800/30'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            {cred.valid
                              ? <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                              : <XCircle className="w-4 h-4 text-gray-500 flex-shrink-0" />
                            }
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-xs font-medium text-gray-200">{cred.name}</p>
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
                                  {cred.cliTool}
                                </span>
                                {isRegistered && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                                    registered
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] text-gray-500 truncate">{cred.source}</p>
                              {cred.error && (
                                <p className="text-[10px] text-yellow-400 mt-0.5">{cred.error}</p>
                              )}
                              {cred.defaultModel && (
                                <p className="text-[10px] text-gray-500 mt-0.5">
                                  Default: <span className="text-gray-400 font-mono">{cred.defaultModel}</span>
                                  {cred.models && cred.models.length > 1 && (
                                    <span className="text-gray-600 ml-1">(+{cred.models.length - 1} models)</span>
                                  )}
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 flex-shrink-0">
                            {cred.valid && (
                              <button
                                onClick={() => handleOAuthRegister(cred)}
                                disabled={oauthRegistering === cred.providerId}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/20 text-green-300 rounded-lg hover:bg-green-500/30 text-[11px] font-medium border border-green-500/30 disabled:opacity-50"
                              >
                                {oauthRegistering === cred.providerId
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : <Plus className="w-3 h-3" />
                                }
                                {isRegistered ? 'Update' : 'Add'}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Empty state */}
              {!oauthScanning && oauthResults.length === 0 && oauthScannedTools.length === 0 && (
                <div className="text-center py-6 text-gray-600">
                  <Terminal className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-xs">กดปุ่ม "Scan CLI OAuth" เพื่อตรวจหา credentials ในเครื่อง</p>
                  <p className="text-[10px] mt-1">รองรับ: gemini, claude, openai, codex, kilo, gcloud, gh, az, aws, ollama, lmstudio</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Category Sections */}
        {categories.map(cat => {
          const config = CATEGORY_CONFIG[cat];
          const providers = providersByCategory[cat] || [];
          const configuredCount = providers.filter(p => p.configured).length;
          const IconComp = config.icon;
          const isExpanded = expandedCategories[cat];

          return (
            <div key={cat} className="border border-gray-800 rounded-lg overflow-hidden">
              {/* Category Header */}
              <button
                onClick={() => toggleCategory(cat)}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-800/50 hover:bg-gray-800/80 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <IconComp className={`w-4 h-4 ${config.color}`} />
                  <div className="text-left">
                    <span className="text-xs font-semibold text-gray-200">{config.label}</span>
                    <span className="text-[10px] text-gray-500 ml-2">{config.labelTh}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-gray-500">
                    {configuredCount}/{providers.length} configured
                  </span>
                  {configuredCount > 0 && (
                    <span className="w-2 h-2 rounded-full bg-green-400" />
                  )}
                  {isExpanded
                    ? <ChevronDown className="w-4 h-4 text-gray-500" />
                    : <ChevronRight className="w-4 h-4 text-gray-500" />
                  }
                </div>
              </button>

              {/* Provider List */}
              {isExpanded && (
                <div className="p-3 space-y-2">
                  <p className="text-[10px] text-gray-600 px-1">{config.description}</p>

                  {providers.length === 0 ? (
                    <p className="text-xs text-gray-600 text-center py-4">
                      ยังไม่มี provider ในหมวดนี้ — กด "เพิ่ม Provider ใหม่" เพื่อเพิ่ม
                    </p>
                  ) : (
                    providers.map(provider => {
                      const availableModels = getAvailableModels(provider);
                      const selectedModel = getSelectedProviderModel(provider);
                      const shouldShowModels =
                        availableModels.length > 0
                        || loadingModels === provider.id
                        || modelSource[provider.id] !== undefined;

                      return (
                        <ProviderCard
                          key={provider.id}
                          provider={provider}
                          providerKey={providerKeys[provider.id] || ''}
                          showKey={showKeyFor[provider.id] || false}
                          testResult={testResults[provider.id]}
                          isTesting={testing === provider.id}
                          isSavingKey={savingKey === provider.id}
                          isSavingModel={savingModel === provider.id}
                          isLoadingModels={loadingModels === provider.id}
                          modelList={shouldShowModels ? availableModels : undefined}
                          modelSource={modelSource[provider.id]}
                          selectedModel={selectedModel}
                          onKeyChange={(v) => setProviderKeys(prev => ({ ...prev, [provider.id]: v }))}
                          onToggleShowKey={() => setShowKeyFor(prev => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                          onSaveKey={() => handleSaveKey(provider.id)}
                          onDeleteKey={() => handleDeleteKey(provider.id)}
                          onTest={() => handleTestProvider(provider.id)}
                          onLoadModels={() => handleLoadModels(provider.id)}
                          onModelChange={(value) => handleProviderModelChange(provider, value)}
                          onToggleEnabled={() => handleToggleProvider(provider.id)}
                          onRemove={() => handleRemoveProvider(provider.id)}
                          onEdit={() => openEditModal(provider)}
                        />
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Modals */}
      <ProviderModals
        showAddModal={showAddModal}
        showEditModal={showEditModal}
        addCategory={addCategory}
        newProvider={newProvider}
        editProvider={editProvider}
        onCloseAdd={() => setShowAddModal(false)}
        onCloseEdit={() => {
          setShowEditModal(false);
          setEditProvider(null);
        }}
        onCategoryChange={setAddCategory}
        onNewProviderChange={setNewProvider}
        onEditProviderChange={setEditProvider}
        onAddProvider={async () => {}}
        onSaveEdit={async () => {}}
        onLoadProviders={loadProviders}
      />
    </>
  );
}
