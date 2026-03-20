# Settings Page Architecture

## Component Hierarchy

```
Settings (Main Orchestrator)
├── State & Data Loading
│   ├── settings: Record<string, string>
│   ├── registryProviders: RegistryProvider[]
│   ├── models: Record<string, string[]>
│   ├── agentConfig: Record<string, AgentRouteConfig>
│   ├── agentBots: AgentBotSummary[]
│   └── agentBotModels: Record<string, BotRouteSummary>
│
├── Callbacks
│   ├── loadSettings()
│   ├── loadProviders()
│   ├── loadAgentRouting()
│   ├── updateSetting(key, value)
│   └── handleSave()
│
└── Sub-Components
    │
    ├── FacebookSettings
    │   └── Local State:
    │       ├── fbEmail, fbPassword
    │       ├── loggingIn, fbMessage
    │       └── loginTimeoutRef
    │
    ├── APIProviders
    │   ├── Local State:
    │   │   ├── expandedCategories
    │   │   ├── showKeyFor, providerKeys
    │   │   ├── savingKey, savingModel
    │   │   ├── testing, testResults
    │   │   ├── loadingModels, models, modelSource
    │   │   ├── showAddModal, addCategory, newProvider
    │   │   └── showEditModal, editProvider
    │   │
    │   └── Sub-Components:
    │       ├── [Category Headers] (collapsible)
    │       │   └── ProviderCard (for each provider)
    │       │       └── Actions:
    │       │           ├── Save/Delete API Key
    │       │           ├── Test Connection
    │       │           ├── Load Models
    │       │           ├── Select Model
    │       │           ├── Toggle Enable/Disable
    │       │           ├── Edit
    │       │           └── Remove
    │       │
    │       └── ProviderModals
    │           ├── AddProviderModal
    │           │   └── Form Fields:
    │           │       ├── Provider ID, Name
    │           │       ├── Category, Type
    │           │       ├── Base URL, Default Model
    │           │       ├── Models List
    │           │       ├── Endpoint Template
    │           │       ├── Custom Headers (JSON)
    │           │       └── Extra Config (JSON)
    │           │
    │           └── EditProviderModal
    │               └── Same Fields as Add (with pre-fill)
    │
    ├── AgentRoutingOverview (Read-Only Display)
    │   ├── Global Defaults Section
    │   │   └── Grid of task cards (general, complex, thinking, code, data, web, vision, system)
    │   │
    │   └── Per-Agent Overrides Section
    │       └── For each registered bot:
    │           └── Grid of task cards with override status
    │
    ├── AITaskRouting (Configuration)
    │   └── For each task type (chat, content, comment, summary):
    │       ├── Provider Selector
    │       │   └── Only LLM providers with type: gemini, openai-compatible, anthropic
    │       │
    │       └── Model Selector
    │           ├── Dropdown (if models available)
    │           └── Manual input (if no models)
    │
    └── GeneralSettings (Configuration Form)
        ├── Boss Mode Admin IDs
        │   ├── Telegram IDs
        │   └── LINE IDs
        │
        └── Runtime Settings
            ├── Chat Reply Delay (ms)
            ├── Comment Reply Delay (ms)
            ├── Browser Headless Toggle
            └── Max Conversation Memory
```

## Data Flow Diagram

```
User Interaction
    ↓
Component Event Handler (e.g., onSettingChange)
    ↓
State Update (setSettings, setProviders, etc.)
    ↓
Component Re-render
    ↓
Display Updated UI
    ↓
On Save Button Click
    ↓
api.setSettingsBulk(settings)
    ↓
Backend Update
    ↓
Toast Notification to User
```

## State Management Pattern

### Shared State (Parent → Children)
```
Parent (Settings)
    ├── settings → [AITaskRouting, GeneralSettings]
    ├── registryProviders → [APIProviders, AgentRoutingOverview]
    ├── models → [APIProviders, AITaskRouting]
    ├── agentConfig → [AgentRoutingOverview]
    ├── agentBots → [AgentRoutingOverview]
    └── agentBotModels → [AgentRoutingOverview]
```

### Local State (Isolated in Components)
```
FacebookSettings
    ├── fbEmail, fbPassword (independent)
    ├── loggingIn, fbMessage
    └── loginTimeoutRef (internal timing)

APIProviders
    ├── expandedCategories (UI state)
    ├── showKeyFor (UI state)
    ├── providerKeys (form input)
    ├── savingKey, savingModel (loading)
    └── testing, testResults (async state)
```

## Component Dependency Graph

```
Settings (entry point)
    │
    ├─→ FacebookSettings (independent)
    │
    ├─→ APIProviders (orchestrator)
    │   ├─→ ProviderCard (pure display)
    │   │   (no child components)
    │   │
    │   └─→ ProviderModals (dialogs)
    │       (no child components)
    │
    ├─→ AgentRoutingOverview (pure display)
    │   (no child components)
    │
    ├─→ AITaskRouting (form)
    │   (no child components)
    │
    └─→ GeneralSettings (form)
        (no child components)
```

## Module Dependencies

```
External Dependencies:
├── react (hooks: useState, useEffect, useCallback, useMemo)
├── lucide-react (icons)
└── @tailwindcss/forms or direct classes

Internal Dependencies:
├── ../services/api (API client)
├── ../components/Toast (toast notifications)
│
└── settings/
    ├── types.ts (interfaces)
    ├── constants.ts (config)
    └── All .tsx components
```

## API Integration Points

```
FacebookSettings
    └── emit('fb:login') + on('fb:loginResult')
    └── api.setSetting('fb_email')

APIProviders
    ├── api.getProviders()
    ├── api.getProviderModels()
    ├── api.testProvider()
    ├── api.setProviderKey()
    ├── api.deleteProviderKey()
    ├── api.toggleProvider()
    ├── api.removeProvider()
    ├── api.addProvider()
    └── api.updateProvider()

AgentRoutingOverview
    ├── api.getAgentConfig()
    ├── api.getBots()
    └── api.getBotModels()

AITaskRouting
    └── (read settings, no direct API calls - handled by parent)

GeneralSettings
    └── (read settings, no direct API calls - handled by parent)

Main Settings
    ├── api.getSettings()
    ├── api.setSettingsBulk()
    └── (delegates to sub-components)
```

## Event Flow Example: Adding a Provider

```
User clicks "เพิ่ม Provider ใหม่" button
    ↓
APIProviders: setShowAddModal(true)
    ↓
ProviderModals renders AddProviderModal
    ↓
User fills form and clicks "เพิ่ม Provider"
    ↓
ProviderModals.handleAddProvider()
    ↓
api.addProvider(newProvider)
    ↓
Backend creates provider
    ↓
ProviderModals: onCloseAdd() + onLoadProviders()
    ↓
APIProviders: loadProviders()
    ↓
api.getProviders() + setRegistryProviders()
    ↓
APIProviders re-renders with new provider in list
    ↓
addToast('success', 'Added provider...')
```

## Memory & Performance Considerations

### Memoization Used
```
APIProviders
    └── useMemo: providersByCategory
    └── useMemo: taskRoutingProviders (in AITaskRouting)

FacebookSettings
    └── useCallback: handleFbLogin

AITaskRouting
    └── useMemo: taskRoutingProviders
    └── useMemo: getSelectedProviderModel
    └── useMemo: getProviderModels
    └── useCallback: (implicitly in renderers)
```

### Re-render Optimization
- Each component only re-renders when its specific props/state change
- Callbacks are wrapped with useCallback to prevent unnecessary child re-renders
- Lists use .map() with stable keys (provider.id, task.id)

### State Update Strategy
- Immutable state updates (prev => ({...prev, ...}))
- Batch updates where possible
- Async operations properly managed with loading states

## Testing Strategy

Each component can be tested independently:

```
Unit Tests:
├── FacebookSettings
│   ├── Login form submission
│   ├── Error handling
│   └── Timeout behavior
│
├── APIProviders
│   ├── Category expansion/collapse
│   ├── Provider CRUD operations
│   └── Key management
│
├── ProviderCard
│   ├── Button interactions
│   ├── Key visibility toggle
│   └── Model selection
│
├── ProviderModals
│   ├── Form validation
│   ├── JSON parsing
│   └── Modal lifecycle
│
├── AgentRoutingOverview
│   ├── Data rendering
│   └── Status indicators
│
├── AITaskRouting
│   ├── Provider selection
│   ├── Model loading
│   └── Setting updates
│
└── GeneralSettings
    └── Input value updates

Integration Tests:
├── Full settings page flow
├── Data persistence across components
└── API integration
```

## Error Handling

```
Each component handles:
├── API call failures (try-catch)
├── JSON parsing errors (custom parser)
├── Network timeouts (timeout handling)
└── User feedback (toast notifications)

Example: ProviderModals.parseOptionalJsonObject()
    ├── Validates JSON syntax
    ├── Ensures object type
    └── Throws descriptive error
```

## Future Extensibility

The architecture supports:

1. **Adding New Provider Categories**
   - Update CATEGORY_CONFIG in constants.ts
   - Components auto-adapt

2. **Adding New General Settings**
   - Add to GeneralSettings.tsx
   - Automatic save in main handleSave()

3. **Adding New Agent Tasks**
   - Update AGENT_TASKS in constants.ts
   - Auto-appears in all routing sections

4. **Adding New Task Types**
   - Update taskTypes in AITaskRouting.tsx
   - Auto-renders in routing UI

5. **Extracting to Custom Hooks**
   - Provider logic → useProviderManagement()
   - Settings logic → useSettingsManager()
   - Agent logic → useAgentRouting()

---

This modular architecture makes the Settings page maintainable, testable, and easily extensible for future requirements.
