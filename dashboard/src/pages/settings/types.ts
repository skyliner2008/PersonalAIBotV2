export interface RegistryProvider {
  id: string;
  name: string;
  category: string;
  type: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: Record<string, boolean>;
  apiKeyEnvVar: string;
  enabled: boolean;
  configured: boolean;
  requiresAuth?: boolean;
  customHeaders?: Record<string, string>;
  extraConfig?: Record<string, string>;
  endpointTemplate?: string;
  notes?: string;
}

export interface ModelConfig {
  provider: string;
  modelName: string;
}

export interface MultiModelConfig {
  active: ModelConfig;
  fallbacks?: ModelConfig[];
}

export interface AgentRouteConfig extends MultiModelConfig {
  source?: string;
  resolvedProvider?: string;
  resolvedModel?: string;
}

export interface BotRouteSummary {
  botId: string;
  botName: string;
  autoRouting: boolean;
  modelConfig: Record<string, AgentRouteConfig>;
}

export interface GlobalRoutingConfig {
  autoRouting: boolean;
  routes: Record<string, MultiModelConfig>;
}

export interface AgentBotSummary {
  id: string;
  name: string;
  platform: string;
  status: string;
}
