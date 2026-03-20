import { useMemo } from 'react';
import { Brain } from 'lucide-react';
import { AgentRouteConfig, AgentBotSummary, BotRouteSummary, RegistryProvider, GlobalRoutingConfig } from './types';
import { AGENT_TASKS } from './constants';

interface Props {
  agentConfig: GlobalRoutingConfig;
  llmProviders: RegistryProvider[];
  onToggleGlobalAuto: (enabled: boolean) => void;
  onUpdateGlobalRoute: (taskType: string, provider: string, model: string) => void;
  savingKey?: string | null;
}

export function AgentRoutingOverview({
  agentConfig,
  llmProviders,
  onToggleGlobalAuto,
  onUpdateGlobalRoute,
  savingKey,
}: Props) {
  const filteredLlmProviders = useMemo(() => 
    llmProviders.filter(p => p.enabled && p.configured), 
    [llmProviders]
  );

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
        <Brain className="w-4 h-4 text-cyan-400" /> Global AI Routing (Jarvis)
      </h3>
      <p className="text-xs text-gray-500">
        This defines the baseline provider/model for all tasks. Individual bots inherit these unless explicitly overridden. Jarvis Root Admin always uses these settings.
      </p>

      <div className="bg-gray-800/30 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-gray-300">Global Agent Defaults (Jarvis)</p>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer group">
              <span className="text-[10px] font-medium text-gray-500 group-hover:text-gray-400 transition-colors uppercase">
                {agentConfig.autoRouting ? 'Adaptive (Auto)' : 'Manual'}
              </span>
              <div 
                onClick={() => onToggleGlobalAuto(!agentConfig.autoRouting)}
                className={`relative w-8 h-4 rounded-full transition-colors ${agentConfig.autoRouting ? 'bg-blue-600' : 'bg-gray-700'}`}
              >
                <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform ${agentConfig.autoRouting ? 'translate-x-4' : ''}`} />
              </div>
            </label>
            <span className="text-[10px] text-gray-500">Source: ROUTING.md</span>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {AGENT_TASKS.map(task => {
            const route = agentConfig.routes?.[task.id];
            // If route exists but is in old format, we normalize it visually (though types should be correct now)
            const active = (route as any)?.active ?? (route as any);
            const provider = filteredLlmProviders.find(item => item.id === active?.provider);
            const isSaving = savingKey === `global:${task.id}`;

            return (
              <div key={task.id} className="grid grid-cols-1 lg:grid-cols-[120px_1fr_1fr_auto] gap-3 items-center rounded-lg border border-gray-800 bg-gray-800/40 p-3">
                <div>
                  <p className="text-xs font-medium text-gray-200">{task.name}</p>
                  <p className="text-[10px] text-gray-500 uppercase">{task.id}</p>
                </div>
                
                <div>
                  <label className="text-[10px] text-gray-500 uppercase block mb-1">
                    Provider {agentConfig.autoRouting && <span className="text-blue-400 font-bold ml-1">ADAPTIVE</span>}
                  </label>
                  <select
                    value={agentConfig.autoRouting ? ((route as any)?.resolvedProvider || active?.provider || '') : (active?.provider || '')}
                    onChange={(e) => {
                      const pId = e.target.value;
                      const p = filteredLlmProviders.find(x => x.id === pId);
                      onUpdateGlobalRoute(task.id, pId, p?.defaultModel || p?.models?.[0] || '');
                    }}
                    disabled={agentConfig.autoRouting || isSaving}
                    className="w-full bg-gray-900 text-gray-200 px-3 py-2 rounded-lg text-xs border border-gray-700 disabled:opacity-70 disabled:grayscale-[0.5]"
                  >
                    {!agentConfig.autoRouting && <option value="">Select Provider</option>}
                    {/* Union of unique providers from configured fallbacks and registry for manual choice */}
                    {Array.from(new Set([
                      ...(route?.fallbacks?.map((f: any) => f.provider) || []),
                      ...filteredLlmProviders.map(p => p.id)
                    ])).map(pId => {
                      const p = filteredLlmProviders.find(item => item.id === pId);
                      return (
                        <option key={pId} value={pId}>
                          {p?.name || pId}{p?.configured ? '' : ' (no key)'}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div>
                  <label className="text-[10px] text-gray-500 uppercase block mb-1">
                    Model {agentConfig.autoRouting && <span className="text-blue-400 font-bold ml-1">ADAPTIVE</span>}
                  </label>
                  <select
                    value={agentConfig.autoRouting ? ((route as any)?.resolvedModel || active?.modelName || '') : (active?.modelName || '')}
                    onChange={(e) => onUpdateGlobalRoute(task.id, active?.provider || '', e.target.value)}
                    disabled={agentConfig.autoRouting || !active?.provider || isSaving}
                    className="w-full bg-gray-900 text-gray-200 px-3 py-2 rounded-lg text-xs border border-gray-700 font-mono disabled:opacity-70 disabled:grayscale-[0.5]"
                  >
                    {!agentConfig.autoRouting && <option value="">Select Model</option>}
                    {/* Show models from the selected provider, privileging those in fallbacks list if defined */}
                    {(() => {
                      const providerId = active?.provider || (filteredLlmProviders.length > 0 ? filteredLlmProviders[0].id : '');
                      const registryModels = filteredLlmProviders.find(p => p.id === providerId)?.models || [];
                      const fallbackModels = (route?.fallbacks || [])
                        .filter((f: any) => f.provider === providerId)
                        .map((f: any) => f.modelName);
                      
                      return Array.from(new Set([...fallbackModels, ...registryModels])).map(m => (
                        <option key={m} value={m}>{m}</option>
                      ));
                    })()}
                  </select>
                </div>

                <div className="flex items-center justify-end">
                  {isSaving && <div className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />}
                </div>
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}
