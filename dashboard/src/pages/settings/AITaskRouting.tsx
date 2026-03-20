import { useMemo, useCallback } from 'react';
import { Brain } from 'lucide-react';
import { RegistryProvider } from './types';

interface Props {
  settings: Record<string, string>;
  llmProviders: RegistryProvider[];
  models: Record<string, string[]>;
  onSettingChange: (key: string, value: string) => void;
}

interface TaskType {
  id: string;
  name: string;
  desc: string;
}

const taskTypes: TaskType[] = [
  { id: 'chat', name: 'Chat Bot', desc: 'Messenger replies' },
  { id: 'content', name: 'Content Creator', desc: 'Auto-post content' },
  { id: 'comment', name: 'Comment Reply', desc: 'Comment responses' },
  { id: 'summary', name: 'Summarizer', desc: 'Conversation summary' },
];

export function AITaskRouting({
  settings,
  llmProviders,
  models,
  onSettingChange,
}: Props) {
  const taskRoutingProviders = useMemo(() => {
    return llmProviders.filter(provider =>
      ['gemini', 'openai-compatible', 'anthropic'].includes(provider.type)
    );
  }, [llmProviders]);

  const getSelectedProviderModel = useCallback((provider: RegistryProvider): string => {
    return provider.defaultModel || '';
  }, []);

  const getProviderModels = useCallback((providerId: string): string[] => {
    const selectedProvider = taskRoutingProviders.find(p => p.id === providerId)
      || llmProviders.find(p => p.id === providerId);

    const selectedProviderDefaultModel = selectedProvider ? getSelectedProviderModel(selectedProvider) : '';

    return [
      ...(selectedProvider?.models || []),
      ...(models[providerId] || []),
      selectedProviderDefaultModel,
    ].filter((m, i, arr) => m && arr.indexOf(m) === i);
  }, [taskRoutingProviders, llmProviders, models, getSelectedProviderModel]);

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
        <Brain className="w-4 h-4 text-purple-400" /> AI Task Routing
      </h3>
      <p className="text-xs text-gray-500">Choose the provider and model used by the legacy auto-reply/content pipeline. Any configured LLM provider can be selected here, and the router will fall back automatically when a provider is unavailable.</p>
      <div className="space-y-3">
        {taskTypes.map(task => {
          const selectedProviderId = settings[`ai_task_${task.id}_provider`] || '';
          const selectedProvider = taskRoutingProviders.find(p => p.id === selectedProviderId)
            || llmProviders.find(p => p.id === selectedProviderId);
          const selectedProviderDefaultModel = selectedProvider ? getSelectedProviderModel(selectedProvider) : '';
          const selectedProviderUnsupported = !!selectedProviderId && !taskRoutingProviders.some(p => p.id === selectedProviderId);
          const providerModels = getProviderModels(selectedProviderId);

          return (
            <div key={task.id} className="bg-gray-800/30 rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-3">
                <div className="w-36">
                  <p className="text-xs text-gray-300 font-medium">{task.name}</p>
                  <p className="text-[10px] text-gray-600">{task.desc}</p>
                </div>
                {/* Provider selector */}
                <div className="flex-1">
                  <label className="text-[9px] text-gray-600 uppercase block mb-0.5">Provider</label>
                  <select
                    value={selectedProviderId}
                    onChange={e => {
                      onSettingChange(`ai_task_${task.id}_provider`, e.target.value);
                      // Auto-set default model when switching provider
                      const prov = taskRoutingProviders.find(p => p.id === e.target.value);
                      const defaultModel = prov ? getSelectedProviderModel(prov) : '';
                      if (defaultModel) {
                        onSettingChange(`ai_task_${task.id}_model`, defaultModel);
                      }
                    }}
                    className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
                  >
                    <option value="">Default (first available)</option>
                    {taskRoutingProviders.map(p => (
                      <option key={p.id} value={p.id} disabled={!p.enabled || !p.configured}>
                        {p.name}{p.configured ? ' configured' : ' (set API key first)'}{p.enabled ? '' : ' [disabled]'}
                      </option>
                    ))}
                  </select>
                  {selectedProviderUnsupported && (
                    <p className="mt-1 text-[10px] text-yellow-500">
                      The saved provider "{selectedProviderId}" is not available in the current LLM registry. Choose one of the configured providers above.
                    </p>
                  )}
                </div>
                {/* Model selector */}
                <div className="flex-1">
                  <label className="text-[9px] text-gray-600 uppercase block mb-0.5">Model</label>
                  {providerModels.length > 0 ? (
                    <select
                      value={settings[`ai_task_${task.id}_model`] || ''}
                      onChange={e => onSettingChange(`ai_task_${task.id}_model`, e.target.value)}
                      className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
                    >
                      <option value="">
                        {selectedProviderDefaultModel ? `Default (${selectedProviderDefaultModel})` : 'Select model...'}
                      </option>
                      {providerModels.map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={settings[`ai_task_${task.id}_model`] || ''}
                      onChange={e => onSettingChange(`ai_task_${task.id}_model`, e.target.value)}
                      placeholder={selectedProviderId ? 'พิมพ์ชื่อโมเดล...' : 'เลือก provider ก่อน'}
                      className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
