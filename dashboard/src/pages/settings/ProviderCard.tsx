import {
  Loader2, RefreshCw, CheckCircle, XCircle, Eye, EyeOff, Trash2, Edit3, Power,
} from 'lucide-react';
import { RegistryProvider } from './types';

interface ProviderCardProps {
  provider: RegistryProvider;
  providerKey: string;
  showKey: boolean;
  testResult?: boolean;
  isTesting: boolean;
  isSavingKey: boolean;
  isSavingModel: boolean;
  isLoadingModels: boolean;
  modelList?: string[];
  modelSource?: string;
  selectedModel: string;
  onKeyChange: (v: string) => void;
  onToggleShowKey: () => void;
  onSaveKey: () => void;
  onDeleteKey: () => void;
  onTest: () => void;
  onLoadModels: () => void;
  onModelChange: (v: string) => void;
  onToggleEnabled: () => void;
  onRemove: () => void;
  onEdit: () => void;
}

export function ProviderCard({
  provider, providerKey, showKey, testResult, isTesting, isSavingKey, isSavingModel, isLoadingModels,
  modelList, modelSource, selectedModel,
  onKeyChange, onToggleShowKey, onSaveKey, onDeleteKey, onTest,
  onLoadModels, onModelChange, onToggleEnabled, onRemove, onEdit,
}: ProviderCardProps) {
  return (
    <div className={`bg-gray-800/40 rounded-lg p-3 space-y-2 border ${
      provider.configured ? 'border-green-500/20' : 'border-gray-800'
    } ${!provider.enabled ? 'opacity-50' : ''}`}>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-gray-200">{provider.name}</p>
          <span className="text-[9px] font-mono text-gray-600 bg-gray-900 px-1.5 py-0.5 rounded">{provider.id}</span>
          {provider.configured && (
            <span className="text-[9px] text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded border border-green-500/20">
              configured
            </span>
          )}
          {provider.type && (
            <span className="text-[9px] text-gray-500 bg-gray-900 px-1.5 py-0.5 rounded">{provider.type}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {testResult !== undefined && (
            testResult
              ? <CheckCircle className="w-3.5 h-3.5 text-green-400" />
              : <XCircle className="w-3.5 h-3.5 text-red-400" />
          )}
          <button
            onClick={onTest}
            disabled={isTesting || !provider.configured}
            className="px-2 py-1 text-[10px] bg-gray-700 text-gray-300 rounded hover:bg-gray-600 disabled:opacity-40"
            title="Test connection"
          >
            {isTesting ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Test'}
          </button>
          <button
            onClick={onLoadModels}
            disabled={!provider.configured || isLoadingModels}
            className="px-2 py-1 text-[10px] bg-gray-700 text-gray-300 rounded hover:bg-gray-600 disabled:opacity-40"
            title="โหลดรายชื่อ Models จาก API"
          >
            {isLoadingModels
              ? <Loader2 className="w-3 h-3 animate-spin inline" />
              : <RefreshCw className="w-3 h-3 inline" />
            }
          </button>
          <button
            onClick={onEdit}
            className="px-2 py-1 text-[10px] bg-gray-700 text-yellow-400 rounded hover:bg-yellow-500/20"
            title="Edit provider settings"
          >
            <Edit3 className="w-3 h-3" />
          </button>
          <button
            onClick={onToggleEnabled}
            className={`px-2 py-1 text-[10px] rounded ${
              provider.enabled
                ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25'
                : 'bg-gray-700 text-gray-500 hover:bg-gray-600'
            }`}
            title={provider.enabled ? 'Disable' : 'Enable'}
          >
            <Power className="w-3 h-3" />
          </button>
          <button
            onClick={onRemove}
            className="px-2 py-1 text-[10px] bg-gray-700 text-red-400 rounded hover:bg-red-500/20"
            title="Remove provider"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Notes / Endpoint info */}
      {(provider.notes || provider.endpointTemplate || provider.baseUrl) && (
        <div className="text-[9px] text-gray-600 font-mono truncate">
          {provider.baseUrl && <span>{provider.baseUrl}</span>}
          {provider.endpointTemplate && <span className="text-yellow-600 ml-2">template: {provider.endpointTemplate}</span>}
          {provider.notes && <span className="text-gray-500 ml-2">— {provider.notes}</span>}
        </div>
      )}

      {/* API Key Input */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            value={providerKey}
            onChange={e => onKeyChange(e.target.value)}
            type={showKey ? 'text' : 'password'}
            placeholder={provider.configured ? '••••••••  (key saved — enter new to replace)' : `${provider.apiKeyEnvVar}...`}
            className="w-full px-3 py-1.5 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono pr-8"
          />
          <button
            onClick={onToggleShowKey}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
          >
            {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        <button
          onClick={onSaveKey}
          disabled={!providerKey || isSavingKey}
          className="px-3 py-1.5 text-[10px] bg-blue-500/15 text-blue-400 rounded-lg hover:bg-blue-500/25 border border-blue-500/30 disabled:opacity-40 font-medium whitespace-nowrap"
        >
          {isSavingKey ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Save Key'}
        </button>
        {provider.configured && (
          <button
            onClick={onDeleteKey}
            className="px-2 py-1.5 text-[10px] bg-red-500/10 text-red-400 rounded-lg hover:bg-red-500/20 border border-red-500/20"
            title="Delete saved key"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Model Selector */}
      {modelList !== undefined && (
        <div className="space-y-1">
          {modelList.length > 0 ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-gray-600">
                  Models ({modelList.length} รายการ)
                  {modelSource === 'api' && (
                    <span className="text-green-500 ml-1">— จาก API</span>
                  )}
                  {modelSource === 'registry' && (
                    <span className="text-yellow-600 ml-1">— จาก Registry (provider ไม่รองรับ list models)</span>
                  )}
                </span>
                <span className="text-[9px] font-mono text-gray-500">
                  active: {selectedModel || provider.defaultModel || 'not set'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={selectedModel || ''}
                  onChange={e => onModelChange(e.target.value)}
                  disabled={isSavingModel}
                  className="flex-1 px-3 py-1.5 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono disabled:opacity-60"
                >
                  <option value="">
                    {provider.defaultModel ? `Default (${provider.defaultModel})` : 'Select model...'}
                  </option>
                  {modelList.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                {isSavingModel && <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />}
              </div>
              <p className="text-[10px] text-gray-600">
                Select a model here to set the provider default. `AI Task Routing` can still override it per task.
              </p>
            </>
          ) : (
            <p className="text-[10px] text-gray-600 italic">
              ไม่พบ models — ตรวจสอบว่า API Key ถูกต้อง หรือ provider รองรับ list models
            </p>
          )}
        </div>
      )}
    </div>
  );
}
