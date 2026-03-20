import { getSetting } from '../database/db.js';
import { getAgentAllowOpenaiAutoFallback } from '../config/runtimeSettings.js';
import { getFallbackOrder, getProvider as getRegistryProvider } from '../providers/registry.js';
import { createAgentRuntimeProvider, getAgentCompatibleProvider, getAgentCompatibleProviders, } from '../providers/agentRuntime.js';
import { getProviderApiKey } from '../config/settingsSecurity.js';
import { trackUsage } from '../utils/usageTracker.js';
const providerCache = new Map();
function dedupeStrings(values) {
    return Array.from(new Set(values.flatMap(value => (value ? value.toString().trim() : [])).filter(Boolean)));
}
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
function toRuntimeContents(messages) {
    const systemInstruction = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content.trim())
        .filter(Boolean)
        .join('\n\n');
    const contents = messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
    }));
    return { systemInstruction, contents };
}
class RegistryAIProviderAdapter {
    providerId;
    id;
    name;
    providerDef;
    runtimeProvider;
    constructor(providerId) {
        this.providerId = providerId;
        const provider = getAgentCompatibleProvider(providerId);
        this.id = providerId;
        this.name = provider?.name || providerId;
        this.providerDef = provider;
        this.runtimeProvider = createAgentRuntimeProvider(this.providerId);
    }
    getProviderDef() {
        if (!this.providerDef) {
            throw new Error(`Provider "${this.providerId}" is not supported for AI chat routing`);
        }
        return this.providerDef;
    }
    getRuntimeProvider() {
        if (!this.runtimeProvider) {
            throw new Error(`Provider "${this.providerId}" is not configured or unavailable`);
        }
        return this.runtimeProvider;
    }
    getDefaultModel() {
        const provider = this.getProviderDef();
        return getSetting(`ai_${this.providerId}_model`)
            || provider.defaultModel
            || provider.models?.find(Boolean)
            || '';
    }
    async chat(messages, options) {
        const runtimeProvider = this.getRuntimeProvider();
        const { systemInstruction, contents } = toRuntimeContents(messages);
        const modelName = options?.model || this.getDefaultModel();
        if (!modelName) {
            throw new Error(`No model configured for provider "${this.providerId}"`);
        }
        const response = await runtimeProvider.generateResponse(modelName, options?.systemPrompt || systemInstruction, contents);
        return {
            text: response.text,
            usage: response.usage ? {
                promptTokens: response.usage.promptTokens ?? 0,
                completionTokens: response.usage.completionTokens ?? 0,
                totalTokens: response.usage.totalTokens ?? 0,
            } : undefined,
        };
    }
    async testConnection() {
        try {
            const runtimeProvider = this.getRuntimeProvider();
            const modelName = this.getDefaultModel();
            if (!modelName)
                return false;
            await runtimeProvider.generateResponse(modelName, 'You are a connectivity test assistant. Reply with OK.', [{ role: 'user', parts: [{ text: 'OK' }] }]);
            return true;
        }
        catch {
            return false;
        }
    }
    async listModels() {
        const provider = this.getProviderDef();
        const fallbackModels = dedupeStrings([
            ...(provider.models || []),
            provider.defaultModel,
            this.getDefaultModel(),
        ]);
        try {
            const runtimeProvider = this.getRuntimeProvider();
            const liveModels = await runtimeProvider.listModels();
            return dedupeStrings([...liveModels, ...fallbackModels]);
        }
        catch (err) {
            console.error(`[AIRouter] Failed to list models for provider ${this.providerId}: ${String(err.message || 'Unknown error')}`);
            return fallbackModels;
        }
    }
}
function isCompatibleProviderId(value) {
    return !!value && !!getAgentCompatibleProvider(value);
}
function isProviderEnabled(providerId) {
    const providerDef = getRegistryProvider(providerId);
    return providerDef ? providerDef.enabled !== false : false;
}
function hasProviderCredentials(providerId) {
    return !!getProviderApiKey(providerId);
}
function getProviderAdapter(providerId) {
    const cached = providerCache.get(providerId);
    if (cached) {
        return cached;
    }
    const adapter = new RegistryAIProviderAdapter(providerId);
    providerCache.set(providerId, adapter);
    return adapter;
}
const allCompatibleProviders = getAgentCompatibleProviders({ enabledOnly: false });
function getCompatibleEnabledProviderIds() {
    return getAgentCompatibleProviders({ enabledOnly: true }).map((provider) => provider.id);
}
const cachedCompatibleEnabledProviderIds = getCompatibleEnabledProviderIds();
function sanitizeTaskName(task) {
    return String(task).replace(/[^a-zA-Z0-9_]/g, '_');
}
function getConfiguredProviderId(task) {
    const providerKey = getSetting(`ai_task_${task}_provider`);
    if (!providerKey)
        return null;
    if (!isCompatibleProviderId(providerKey)) {
        console.warn(`[AIRouter] Task "${sanitizeTaskName(task)}" selected unsupported provider "${providerKey}", falling back to compatible providers`);
        return null;
    }
    if (!isProviderEnabled(providerKey)) {
        console.warn(`[AIRouter] Task "${sanitizeTaskName(task)}" selected disabled provider "${providerKey}", falling back`);
        return null;
    }
    return providerKey;
}
function getProviderOrder(preferredProviderId) {
    const allowOpenaiAutoFallback = getAgentAllowOpenaiAutoFallback();
    const registryFallback = getFallbackOrder('llm').filter(isCompatibleProviderId);
    const enabledProviders = getCompatibleEnabledProviderIds();
    return dedupeStrings([
        preferredProviderId,
        ...registryFallback,
        ...enabledProviders,
    ])
        .filter(providerId => isProviderEnabled(providerId) && (providerId !== 'openai' || preferredProviderId === 'openai' || allowOpenaiAutoFallback));
}
function findDefaultProviderId(enabledOnly = true) {
    return getCompatibleEnabledProviderIds()[0] || getAgentCompatibleProviders({ enabledOnly })[0]?.id;
}
function getDefaultProviderId() {
    return findDefaultProviderId();
}
export function getProviderForTask(task) {
    const providerId = getProviderOrder(getConfiguredProviderId(task))[0]
        || getDefaultProviderId();
    if (!providerId) {
        throw new Error('No compatible AI providers are registered');
    }
    return getProvider(providerId);
}
export function getProvider(id) {
    const providerId = isCompatibleProviderId(id)
        ? id
        : findDefaultProviderId();
    if (!providerId) {
        throw new Error('No compatible AI providers are registered');
    }
    return getProviderAdapter(providerId);
}
export async function aiChat(task, messages, options) {
    const preferredProviderId = getConfiguredProviderId(task);
    const modelSetting = getSetting(`ai_task_${task}_model`);
    const providerOrder = getProviderOrder(preferredProviderId);
    for (const providerId of providerOrder) {
        if (!hasProviderCredentials(providerId)) {
            if (providerId === preferredProviderId) {
                console.warn(`[AIRouter] Preferred provider "${providerId}" has no configured key, trying fallback`);
            }
            continue;
        }
        const provider = getProvider(providerId);
        const chatOptions = {
            ...options,
            model: providerId === preferredProviderId ? options?.model || modelSetting || undefined : undefined,
        };
        const startMs = Date.now();
        try {
            if (providerId !== preferredProviderId && preferredProviderId) {
                console.warn(`[AIRouter] Failover: trying ${providerId} for task "${task}"`);
            }
            const result = await provider.chat(messages, chatOptions);
            trackChatUsage(provider, chatOptions, task, startMs, true, result);
            return result;
        }
        catch (err) {
            const errorMessage = String(err.message || 'Unknown error').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // Basic HTML escaping
            trackChatUsage(provider, chatOptions, task, startMs, false, undefined, errorMessage);
            console.error(`[AIRouter] Provider ${providerId} failed for task "${task}": ${errorMessage}`);
        }
    }
    return { text: 'The AI provider is temporarily unavailable right now. Please try again shortly.', usage: undefined };
}
function trackChatUsage(provider, chatOptions, task, startMs, success, result, errorMessage) {
    trackUsage({
        provider: provider.id,
        model: chatOptions.model || (provider.id === getConfiguredProviderId(task) ? 'default' : 'fallback'),
        task,
        platform: 'api',
        promptTokens: result?.usage?.promptTokens || 0,
        completionTokens: result?.usage?.completionTokens || 0,
        totalTokens: result?.usage?.totalTokens || 0,
        durationMs: Date.now() - startMs,
        success: success,
        errorMessage: errorMessage,
    });
}
const providerTestResultsCache = new Map();
const CACHE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
export async function testAllProviders() {
    const results = {};
    for (const providerDef of allCompatibleProviders) {
        const cachedResult = providerTestResultsCache.get(providerDef.id);
        if (cachedResult && Date.now() - cachedResult.timestamp < CACHE_EXPIRY_MS) {
            results[providerDef.id] = cachedResult.result;
            continue;
        }
        if (!isProviderEnabled(providerDef.id) || !hasProviderCredentials(providerDef.id)) {
            results[providerDef.id] = false;
            providerTestResultsCache.set(providerDef.id, { result: false, timestamp: Date.now() });
            continue;
        }
        const provider = getProviderAdapter(providerDef.id);
        let result = false;
        try {
            result = await provider.testConnection();
        }
        catch {
            result = false;
        }
        results[providerDef.id] = result;
        providerTestResultsCache.set(providerDef.id, { result, timestamp: Date.now() });
    }
    return results;
}
export const providers = new Proxy({}, {
    get(_target, prop) {
        if (typeof prop !== 'string' || !isCompatibleProviderId(prop)) {
            return undefined;
        }
        return getProvider(prop);
    },
    ownKeys() {
        return getCompatibleEnabledProviderIds();
    },
    getOwnPropertyDescriptor() {
        return { enumerable: true, configurable: true };
    },
});
//# sourceMappingURL=aiRouter.js.map