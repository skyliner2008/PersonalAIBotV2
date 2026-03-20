# Settings Page Refactoring

This directory contains the refactored Settings page components for the PersonalAIBotV2 dashboard.

## Overview

The original monolithic `Settings.tsx` file (~1460 lines) has been refactored into focused, reusable sub-components. Each component now has a single responsibility and can be independently tested and maintained.

## Component Structure

```
settings/
├── types.ts                    # Shared TypeScript interfaces
├── constants.ts               # Configuration constants (categories, tasks)
├── FacebookSettings.tsx        # Facebook login/account management
├── APIProviders.tsx           # Provider registry management (main orchestrator)
├── ProviderCard.tsx           # Individual provider display/control card
├── ProviderModals.tsx         # Add/Edit provider modals
├── AgentRoutingOverview.tsx    # Agent routing configuration display
├── AITaskRouting.tsx          # AI task routing configuration
├── GeneralSettings.tsx        # General runtime settings
└── README.md                  # This file
```

## Component Details

### `types.ts`
Shared TypeScript interfaces used across components:
- `RegistryProvider` - API provider configuration
- `AgentRouteConfig` - Agent routing configuration
- `BotRouteSummary` - Bot model routing summary
- `AgentBotSummary` - Agent bot information

### `constants.ts`
Global configuration constants:
- `CATEGORY_CONFIG` - Provider categories (LLM, Embedding, Search, TTS, Image, Platform)
- `AGENT_TASKS` - Available agent task types

### `FacebookSettings.tsx`
**Props:**
- `status` - Connection status object
- `emit` - Event emission function
- `on` - Event subscription function

**Features:**
- Facebook login form with email/password
- Login status indicator
- Error/success message display
- Timeout handling for login attempts
- Local state: `fbEmail`, `fbPassword`, `loggingIn`, `fbMessage`

### `APIProviders.tsx`
**Props:**
- `registryProviders` - Array of configured providers
- `onProvidersUpdate` - Callback to update providers in parent

**Key Functions:**
- `handleLoadModels()` - Fetch models from provider API
- `handleTestProvider()` - Test provider connection
- `handleSaveKey()` / `handleDeleteKey()` - Manage API keys
- `handleToggleProvider()` - Enable/disable provider
- `handleRemoveProvider()` - Delete provider
- `openEditModal()` - Open edit modal for a provider

**State:**
- `expandedCategories` - Tracked expanded/collapsed categories
- `providerKeys` - Temporary API key storage
- `models` - Cached models per provider
- `testResults` - Connection test results
- UI state for modals and loading

**Uses memoization for:**
- `providersByCategory` - Grouped providers by category
- `taskRoutingProviders` - Filtered LLM providers for routing

### `ProviderCard.tsx`
Pure presentational component for individual provider display.

**Props:**
- Provider data (read-only)
- Current state (key, test result, loading state)
- Callbacks for all actions:
  - Key management (change, save, delete, toggle visibility)
  - Model loading and selection
  - Provider control (test, enable/disable, remove, edit)

**Features:**
- API key input with visibility toggle
- Model selector with source indicator
- Test connection button
- Edit/remove/enable/disable controls
- Configured status badge
- Endpoint and base URL display

### `ProviderModals.tsx`
Modal components for adding and editing providers.

**Props:**
- Modal visibility states
- Form data (newProvider, editProvider)
- Category selection
- Change handlers for form fields
- Callbacks for add/edit actions

**Features:**
- Add Provider modal with all configuration fields
- Edit Provider modal with pre-populated values
- JSON validation for custom headers and extra config
- Provider type selector
- Environment variable name handling

### `AgentRoutingOverview.tsx`
Display-only component for agent routing configuration.

**Props:**
- `agentConfig` - Global agent default routes
- `agentBots` - Registered AI bots
- `agentBotModels` - Per-bot routing configuration
- `llmProviders` - Available LLM providers

**Features:**
- Global agent defaults display
- Per-bot overrides section
- Task routing status indicators
- Configuration source tracking (global vs bot-override)

### `AITaskRouting.tsx`
Configuration component for AI task routing.

**Props:**
- `settings` - Settings dictionary
- `llmProviders` - Available LLM providers
- `models` - Cached provider models
- `onSettingChange` - Callback to update settings

**Features:**
- Task type selector (Chat, Content, Comment, Summary)
- Provider selection with status indicators
- Model selection with dynamic model list
- Auto-selection of default models when provider changes
- Unsupported provider warning

**Uses memoization for:**
- `taskRoutingProviders` - Filtered providers for routing
- `getProviderModels()` - Combined provider + dynamic models

### `GeneralSettings.tsx`
General configuration form component.

**Props:**
- `settings` - Settings dictionary
- `onSettingChange` - Callback to update settings

**Features:**
- Boss Mode admin ID configuration (Telegram, LINE)
- Reply delays (Chat, Comment)
- Browser headless mode toggle
- Max conversation memory setting

## Integration with Main Settings.tsx

The refactored main `Settings.tsx` (see `Settings.refactored.tsx`) acts as a thin orchestrator:

1. **State Management**: Holds shared state for settings, providers, and agent config
2. **Data Loading**: Manages initial data loading and refresh
3. **Layout**: Arranges sub-components in vertical order
4. **Callbacks**: Provides update handlers to sub-components

### Key Pattern: Prop Drilling vs State Sharing

- **Shared state** (settings, providers, agentConfig): Managed in parent, updated via callbacks
- **Local state** (UI toggles, forms): Kept in individual components
- **Minimal props**: Each component receives only what it needs

## Usage in Production

To use the refactored version:

```typescript
// In your main app or router file
import { Settings } from './pages/Settings.refactored';

// Use it like the original
<Settings status={status} emit={emit} on={on} />
```

## Key Improvements

1. **Separation of Concerns**: Each component has a single, clear responsibility
2. **Reusability**: Components can be tested, updated, or reused independently
3. **Maintainability**: Smaller files are easier to understand and modify
4. **Performance**: Memoization prevents unnecessary re-renders
5. **Type Safety**: Shared types ensure consistency across components
6. **Code Organization**: Logical grouping by feature/section

## Development Notes

### Adding New Provider Categories

1. Update `CATEGORY_CONFIG` in `constants.ts`
2. Update any filters in components that reference categories

### Adding New Global Settings

1. Add to `GeneralSettings.tsx` form
2. Ensure setting key matches backend expectations
3. Add default value handling in the input

### Extending Agent Routing

1. Update `AGENT_TASKS` in `constants.ts`
2. The AgentRoutingOverview and AITaskRouting components will automatically use the new tasks

## Testing Considerations

Each component can now be tested independently:

- **FacebookSettings**: Test login flow, error handling, message display
- **ProviderCard**: Test all button interactions, state changes
- **APIProviders**: Test category expansion, provider operations
- **ProviderModals**: Test form validation, JSON parsing
- **AgentRoutingOverview**: Test data display, status indicators
- **AITaskRouting**: Test dropdown changes, model selection
- **GeneralSettings**: Test input changes, form state

## Migration Path

If you need to migrate from the old Settings.tsx:

1. Backup the original file
2. Replace the import with the refactored version
3. Test all settings operations
4. Verify no functionality is lost
5. Delete the old file once confirmed

The refactored version maintains 100% feature parity with the original implementation.
