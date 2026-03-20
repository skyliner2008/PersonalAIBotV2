# Settings Components Index

Quick reference for all components in the refactored Settings system.

## File Manifest

### Core Files

#### `types.ts` (35 lines)
Shared TypeScript interfaces used across all components.

```typescript
export interface RegistryProvider
export interface AgentRouteConfig
export interface BotRouteSummary
export interface AgentBotSummary
```

**When to update**: When adding new provider features or agent configurations.

---

#### `constants.ts` (25 lines)
Global configuration and static data.

```typescript
export const CATEGORY_CONFIG: Record<string, { ... }>
export const AGENT_TASKS: Array<{ id, name, desc }>
```

**When to update**: When adding new provider categories or agent task types.

---

### Component Files

#### `FacebookSettings.tsx` (~100 lines)
**Purpose**: Facebook account login and status management  
**Responsibility**: Handle Facebook authentication UI and login flow

**Props**:
```typescript
interface Props {
  status: { browser: boolean; loggedIn: boolean; ... }
  emit: (event: string, data?: any) => void
  on: (event: string, handler: (...args: any[]) => void) => () => void
}
```

**Local State**:
- `fbEmail`, `fbPassword` - Login form fields
- `loggingIn` - Login in progress
- `fbMessage` - Status/error message
- `loginTimeoutRef` - Login timeout tracking

**Key Functions**:
- `handleFbLogin()` - Emit login event with credentials

**Used by**: Settings (main)

---

#### `APIProviders.tsx` (~200 lines)
**Purpose**: Orchestrate provider registry management  
**Responsibility**: Manage provider CRUD, keys, models, and testing

**Props**:
```typescript
interface Props {
  registryProviders: RegistryProvider[]
  onProvidersUpdate: (providers: RegistryProvider[]) => void
}
```

**Local State**:
- Category expansion, key visibility toggles
- Provider keys, test results, loading states
- Models cache, modal visibility
- Add/edit provider form state

**Key Functions**:
- `handleLoadModels(providerId)` - Fetch models from API
- `handleTestProvider(providerId)` - Test provider connection
- `handleSaveKey()` / `handleDeleteKey()` - Manage API keys
- `handleToggleProvider()` - Enable/disable provider
- `handleRemoveProvider()` - Delete provider
- `handleProviderModelChange()` - Update default model

**Sub-Components Used**:
- `ProviderCard` (rendered for each provider)
- `ProviderModals` (add/edit dialogs)

**Used by**: Settings (main)

---

#### `ProviderCard.tsx` (~150 lines)
**Purpose**: Display and control individual provider  
**Responsibility**: Pure presentational component with all provider actions

**Props**:
```typescript
interface ProviderCardProps {
  provider: RegistryProvider
  providerKey: string
  showKey: boolean
  testResult?: boolean
  isTesting: boolean
  isSavingKey: boolean
  isSavingModel: boolean
  isLoadingModels: boolean
  modelList?: string[]
  modelSource?: string
  selectedModel: string
  // ... callbacks
}
```

**Features**:
- API key input with visibility toggle
- Model selector (dropdown or manual)
- Connection test button
- Edit/remove/enable/disable buttons
- Status badges (configured, type)

**Used by**: APIProviders

---

#### `ProviderModals.tsx` (~300 lines)
**Purpose**: Provide add/edit provider dialogs  
**Responsibility**: Handle provider creation and editing forms

**Props**:
```typescript
interface Props {
  showAddModal: boolean
  showEditModal: boolean
  addCategory: string
  newProvider: any
  editProvider: any
  // ... handlers and callbacks
}
```

**Features**:
- Add Provider modal
- Edit Provider modal
- Form validation
- JSON parsing for custom headers/config
- Provider type selector

**Used by**: APIProviders

---

#### `AgentRoutingOverview.tsx` (~120 lines)
**Purpose**: Display agent routing configuration  
**Responsibility**: Show global defaults and per-bot overrides (read-only)

**Props**:
```typescript
interface Props {
  agentConfig: Record<string, AgentRouteConfig>
  agentBots: AgentBotSummary[]
  agentBotModels: Record<string, BotRouteSummary>
  llmProviders: RegistryProvider[]
}
```

**Features**:
- Global agent defaults grid
- Per-bot overrides section
- Task routing status indicators
- Configuration source tracking

**Used by**: Settings (main)

---

#### `AITaskRouting.tsx` (~140 lines)
**Purpose**: Configure AI task routing  
**Responsibility**: Allow selection of provider/model for each task type

**Props**:
```typescript
interface Props {
  settings: Record<string, string>
  llmProviders: RegistryProvider[]
  models: Record<string, string[]>
  onSettingChange: (key: string, value: string) => void
}
```

**Features**:
- Task type selectors (Chat, Content, Comment, Summary)
- Provider dropdown (LLM only)
- Model dropdown or manual input
- Auto-select default model on provider change

**Used by**: Settings (main)

---

#### `GeneralSettings.tsx` (~60 lines)
**Purpose**: General configuration form  
**Responsibility**: Manage general runtime settings

**Props**:
```typescript
interface Props {
  settings: Record<string, string>
  onSettingChange: (key: string, value: string) => void
}
```

**Fields**:
- Boss Mode Admin IDs (Telegram, LINE)
- Reply delays (Chat, Comment)
- Browser headless toggle
- Max conversation memory

**Used by**: Settings (main)

---

### Reference Implementations

#### `Settings.refactored.tsx` (~150 lines)
**Purpose**: Main orchestrator component  
**Responsibility**: Compose all sub-components, manage shared state

**Props**:
```typescript
interface Props {
  status: { browser: boolean; loggedIn: boolean; ... }
  emit: (event: string, data?: any) => void
  on: (event: string, handler: (...args: any[]) => void) => () => void
}
```

**State Management**:
- `settings` - Global settings
- `registryProviders` - Provider list
- `models` - Cached models
- `agentConfig` - Agent routing
- `agentBots` - Registered bots
- `agentBotModels` - Bot overrides

**Key Functions**:
- `loadSettings()` - Load all settings
- `loadProviders()` - Load provider registry
- `loadAgentRouting()` - Load agent config
- `updateSetting()` - Update a setting
- `handleSave()` - Save all changes

**Sub-Components Used**:
- FacebookSettings
- APIProviders
- AgentRoutingOverview
- AITaskRouting
- GeneralSettings

---

## Component Usage Graph

```
Settings (main)
│
├─ FacebookSettings (independent)
│
├─ APIProviders
│  ├─ ProviderCard (x N)
│  └─ ProviderModals
│
├─ AgentRoutingOverview (display only)
│
├─ AITaskRouting (form)
│
└─ GeneralSettings (form)
```

## State Flow

```
Parent (Settings)
│
├─ Loads: settings, providers, agent config
│
├─ Provides to Children:
│  ├─ FacebookSettings: status, emit, on
│  ├─ APIProviders: registryProviders, onProvidersUpdate
│  ├─ AgentRoutingOverview: agentConfig, agentBots, agentBotModels, llmProviders
│  ├─ AITaskRouting: settings, llmProviders, models, onSettingChange
│  └─ GeneralSettings: settings, onSettingChange
│
└─ On Save: Saves all settings via api.setSettingsBulk()
```

## Common Patterns

### Callback Pattern (APIProviders → ProviderCard)
```typescript
<ProviderCard
  onSaveKey={() => handleSaveKey(provider.id)}
  onDeleteKey={() => handleDeleteKey(provider.id)}
  // ... more callbacks
/>
```

### Form Update Pattern (GeneralSettings, AITaskRouting)
```typescript
<input
  value={settings['admin_telegram_ids'] || ''}
  onChange={e => onSettingChange('admin_telegram_ids', e.target.value)}
/>
```

### Modal Pattern (APIProviders → ProviderModals)
```typescript
{showAddModal && <AddProviderModal {...props} />}
{showEditModal && <EditProviderModal {...props} />}
```

## Testing Checklists

### FacebookSettings
- [ ] Login form submission
- [ ] Email/password input
- [ ] Error messages display
- [ ] Success message display
- [ ] Login timeout handling
- [ ] Browser not started message
- [ ] Logged in indicator

### APIProviders
- [ ] Category expand/collapse
- [ ] Provider cards display
- [ ] Add provider button works
- [ ] Edit button opens modal
- [ ] Delete button confirms
- [ ] Key save/delete works
- [ ] Test connection works
- [ ] Load models works
- [ ] Enable/disable works

### ProviderCard
- [ ] Key input accepts text
- [ ] Show/hide key toggle works
- [ ] Save key button enabled only with key
- [ ] Delete key button shows only when configured
- [ ] Model dropdown appears when models available
- [ ] Manual model input shows otherwise
- [ ] All action buttons functional

### ProviderModals
- [ ] Add modal appears on button click
- [ ] Edit modal shows existing values
- [ ] Form fields editable
- [ ] JSON validation works
- [ ] Add button disabled without ID/name
- [ ] Save button works
- [ ] Cancel button closes modal

### AgentRoutingOverview
- [ ] Global defaults display
- [ ] Per-bot section shows
- [ ] Task cards display correctly
- [ ] Status indicators show correct color

### AITaskRouting
- [ ] Task type displays
- [ ] Provider dropdown populated
- [ ] Model dropdown populates dynamically
- [ ] Manual input shows when needed
- [ ] Provider change auto-selects default model

### GeneralSettings
- [ ] All inputs accept text
- [ ] Number inputs validate
- [ ] Dropdown selects work
- [ ] Values persist until save

## Quick Reference: Imports

```typescript
// Types
import { RegistryProvider, AgentRouteConfig, ... } from './types'

// Constants
import { CATEGORY_CONFIG, AGENT_TASKS } from './constants'

// Main orchestrator
import { Settings } from './Settings.refactored'

// Or individual components
import { FacebookSettings } from './FacebookSettings'
import { APIProviders } from './APIProviders'
// ... etc
```

## Performance Notes

- All lists use stable keys (provider.id, task.id)
- Callbacks wrapped with useCallback
- Data grouped and memoized (providersByCategory)
- Modal rendering only when visible
- No unnecessary re-renders of ProviderCard

---

**Total Lines**: ~1460 original → Split across ~1000 lines in sub-components + ~250 lines documentation

**Maintainability**: Significantly improved due to smaller, focused components

**Test Coverage**: Each component testable independently
