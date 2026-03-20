# Phase 1: Auto-Tool Generation System for PersonalAIBotV2

## Overview

The Auto-Tool Generation system enables the AI agent to **create, register, and execute new tools dynamically without restarting the server**. This enables the agent to:

- Create specialized tools for specific tasks
- Adapt to new requirements on-the-fly
- Learn and improve by building new capabilities
- Self-evolve with persistent tool definitions

## System Architecture

### Components

1. **toolValidator.ts** — Validates tool code and metadata for safety
2. **toolSandbox.ts** — Executes dynamic tool code in an isolated VM sandbox
3. **dynamicTools.ts** — Manages loading, registration, and hot-reloading of tools
4. **evolution.ts** — Provides AI agent tools to create/manage dynamic tools
5. **index.ts** — Integrates dynamic tools into the main tool system
6. **API endpoints** — REST API to manage tools programmatically

### Directory Structure

```
server/
├── src/
│   ├── bot_agents/
│   │   ├── tools/
│   │   │   ├── index.ts              (updated: loads dynamic tools)
│   │   │   ├── evolution.ts          (updated: added create_tool, etc.)
│   │   │   ├── toolValidator.ts      (new: validates tool code)
│   │   │   ├── toolSandbox.ts        (new: executes in VM)
│   │   │   └── dynamicTools.ts       (new: manages dynamic tools)
│   │   └── registries/
│   │       └── toolRegistry.ts       (updated: added tool metadata)
│   └── api/
│       └── routes.ts                 (updated: added API endpoints)
โ””โ”€โ”€ dynamic_tools/                    (new: stores tool definitions)
    ├── .gitkeep
    โ””โ”€โ”€ _example.json                 (example tool)
```

## How It Works

### 1. Creating a Tool

The AI agent can create a tool using the `create_tool` function:

```
create_tool(
  name: "fetch-weather",
  description: "Fetch weather data for a location",
  code: "const location = args.location; ...",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string" }
    }
  }
)
```

### 2. Validation Pipeline

When a tool is created:

1. **Metadata Validation** — Check name format (kebab-case), description, parameters
2. **Code Validation** — Scan for dangerous patterns (process.exit, eval, child_process, etc.)
3. **Compilation Check** — Verify code compiles as valid JavaScript
4. **Persistence** — Save to `server/dynamic_tools/{name}.json`
5. **Registration** — Load into memory and make available to agent

### 3. Execution Pipeline

When a tool is called:

1. **Lookup** — Find tool in memory registry
2. **Sandbox** — Execute code in isolated VM context with:
   - Timeout: 30 seconds per execution
   - Restricted require: Only safe modules allowed
   - Limited globals: No process, fs manipulation, eval
3. **Result** — Return stringified result

### 4. Tool Storage

Tools are stored as JSON files in `server/dynamic_tools/`:

```json
{
  "name": "fetch-weather",
  "description": "Fetch weather data",
  "code": "const location = args.location; ...",
  "parameters": {
    "type": "object",
    "properties": {
      "location": { "type": "string" }
    }
  }
}
```

## Security

### Blocklist Validation

The following patterns are **BLOCKED**:

- `process.exit`, `process.kill`, `process.abort`
- `require('child_process')`, `spawn`, `exec`
- `fs.rmSync`, `fs.unlinkSync` (outside safe dirs)
- `eval()`, `Function()` constructor
- Dangerous require statements

### Allowlist Validation

The following are **ALLOWED**:

- Safe Node.js modules: `fs`, `path`, `url`, `crypto`, `util`, `os`, `http`, `https`
- Fetch API for HTTP requests
- JSON, Math, Date, String, Array operations
- Basic I/O (reading files, basic operations)

### Sandbox Isolation

- VM context with restricted `require()`
- 30-second timeout per execution
- No access to main process environment
- Limited globals (no eval, process, cluster, etc.)

## API Endpoints

### List Dynamic Tools

```
GET /api/dynamic-tools

Response:
{
  "success": true,
  "count": 2,
  "tools": [
    {
      "name": "fetch-weather",
      "description": "Fetch weather data",
      "parameters": { ... }
    }
  ]
}
```

### Get Single Tool

```
GET /api/dynamic-tools/:name

Response:
{
  "success": true,
  "name": "fetch-weather",
  "description": "Fetch weather data",
  "parameters": { ... }
}
```

### Create Tool

```
POST /api/dynamic-tools

Request:
{
  "name": "fetch-weather",
  "description": "Fetch weather data",
  "code": "const location = args.location; ...",
  "parameters": {
    "type": "object",
    "properties": {
      "location": { "type": "string" }
    }
  }
}

Response:
{
  "success": true,
  "message": "Tool 'fetch-weather' created successfully",
  "warnings": []
}
```

### Delete Tool

```
DELETE /api/dynamic-tools/:name

Response:
{
  "success": true,
  "message": "Tool 'fetch-weather' deleted"
}
```

### Test Tool

```
POST /api/dynamic-tools/:name/test

Request:
{
  "args": {
    "location": "Bangkok"
  }
}

Response:
{
  "success": true,
  "name": "fetch-weather",
  "result": "🌤️ Weather in Bangkok: ..."
}
```

### Refresh Dynamic Tools

```
POST /api/dynamic-tools/refresh

Response:
{
  "success": true,
  "message": "Dynamic tools refreshed",
  "count": 2
}
```

## Agent Tools

The AI agent has three tools for managing dynamic tools:

### 1. create_tool

Creates a new tool dynamically.

```
create_tool(
  name: string,           // Tool name (kebab-case)
  description: string,    // What the tool does
  code: string,          // Handler function body (async)
  parameters?: object    // JSON Schema for parameters
)
```

Returns: Success message or error details.

### 2. list_dynamic_tools

Lists all custom tools created by the agent.

```
list_dynamic_tools()
```

Returns: Table of tools with names, descriptions, and parameters.

### 3. delete_dynamic_tool

Removes a custom tool by name.

```
delete_dynamic_tool(name: string)
```

Returns: Success message or error.

## Example: Creating a Weather Tool

The agent could create a weather tool like this:

```javascript
create_tool(
  name: "fetch-weather",
  description: "Fetch current weather for a location using Open Meteo API",
  code: `
const location = args.location || 'Bangkok';
const url = 'https://api.open-meteo.com/v1/forecast?latitude=13.7563&longitude=100.5018&current_weather=true';

const response = await fetch(url);
const data = await response.json();

if (data.current_weather) {
  const w = data.current_weather;
  return 'Weather: ' + w.temperature + 'ยฐC, ' + w.windspeed + ' km/h';
}
return 'Cannot fetch weather';
  `,
  parameters: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description: 'Location name'
      }
    }
  }
)
```

Once created, the tool becomes immediately available:

```javascript
// Agent can now use it
fetch-weather(location: 'Tokyo')
```

## Startup Behavior

When the server starts:

1. `loadDynamicTools()` is called automatically in `index.ts`
2. All `.json` and `.ts` files in `server/dynamic_tools/` are loaded
3. Each tool is validated and added to the in-memory registry
4. Tools are merged with built-in tools for agent use
5. Any load errors are logged but don't crash the server

## Persistence

- Tools are stored in `server/dynamic_tools/{name}.json`
- They persist across server restarts
- Can be version controlled (recommended)
- Can be backed up or migrated

## Hot-Reloading

To reload tools from disk without restarting:

```bash
# Via API
POST /api/dynamic-tools/refresh

# Via agent (if needed)
The agent can also request to refresh dynamic tools programmatically
```

## Limitations & Best Practices

### Limitations

- Single execution timeout: 30 seconds
- Memory limit: 256 MB per tool
- No direct file system access (sandboxed)
- No subprocess execution
- Cannot import native modules directly

### Best Practices

1. **Keep code simple** — Dynamic tools should do one thing well
2. **Handle errors gracefully** — Always return string responses
3. **Use async/await** — For I/O operations
4. **Test thoroughly** — Use the `/test` endpoint
5. **Document parameters** — Clear JSON Schema descriptions
6. **Validate inputs** — Check args in tool code
7. **Monitor execution** — Check logs for issues

### Example Tool Template

```javascript
// Fetch data from an API
const query = String(args.query || '');

try {
  const response = await fetch(`https://api.example.com/search?q=${encodeURIComponent(query)}`);
  const data = await response.json();

  if (data.results && data.results.length > 0) {
    return data.results.map(r => `${r.title}: ${r.description}`).join('\n');
  }

  return 'No results found for: ' + query;
} catch (err) {
  return 'Error: ' + err.message;
}
```

## Monitoring & Debugging

### Check Tool Load Status

```bash
curl http://localhost:3000/api/dynamic-tools
```

### View Tool Details

```bash
curl http://localhost:3000/api/dynamic-tools/fetch-weather
```

### Test Tool Execution

```bash
curl -X POST http://localhost:3000/api/dynamic-tools/fetch-weather/test \
  -H "Content-Type: application/json" \
  -d '{"args": {"location": "Bangkok"}}'
```

### Check Server Logs

Tools log their execution in the console with tag `[DynamicTools]` and `[ToolSandbox]`.

## Troubleshooting

### Tool Won't Load

1. Check JSON syntax: `jq . server/dynamic_tools/tool-name.json`
2. Check validation errors in server logs
3. Ensure code is valid JavaScript
4. Check blocklist patterns aren't triggered

### Tool Execution Fails

1. Test with `/test` endpoint first
2. Check return type (must be string)
3. Verify arguments match schema
4. Check timeout (30 seconds max)
5. Review sandbox restrictions

### Tool Not Available to Agent

1. Restart server to reload from disk
2. Use `POST /api/dynamic-tools/refresh` to hot-reload
3. Check tool is in `server/dynamic_tools/` directory
4. Verify no validation errors in logs

## Future Enhancements

Phase 1 is the foundation. Potential future improvements:

- **Phase 2**: Tool versioning and rollback
- **Phase 3**: Tool sharing between agents
- **Phase 4**: Automatic tool optimization
- **Phase 5**: Tool dependency management
- **Phase 6**: Tool marketplace/registry

## Files Created/Modified

### New Files

- `/server/src/bot_agents/tools/toolValidator.ts`
- `/server/src/bot_agents/tools/toolSandbox.ts`
- `/server/src/bot_agents/tools/dynamicTools.ts`
- `/server/dynamic_tools/.gitkeep`
- `/server/dynamic_tools/_example.json`
- `/AUTO_TOOL_GENERATION.md` (this file)

### Modified Files

- `/server/src/bot_agents/tools/index.ts` — Added dynamic tool loading
- `/server/src/bot_agents/tools/evolution.ts` — Added create/list/delete tool functions
- `/server/src/bot_agents/registries/toolRegistry.ts` — Added tool metadata
- `/server/src/api/routes.ts` — Added API endpoints

## Testing

### Manual Testing

1. Start the server: `npm run dev`
2. Check dynamic tools endpoint: `curl http://localhost:3000/api/dynamic-tools`
3. Create a tool via API (see examples above)
4. Test execution via `/test` endpoint
5. Delete tool via DELETE endpoint

### With Agent

The agent can test tool creation by:

1. Calling `create_tool()` with valid parameters
2. Immediately using the new tool
3. Listing tools with `list_dynamic_tools()`
4. Deleting tools with `delete_dynamic_tool()`

## Summary

The Auto-Tool Generation system provides a robust, secure foundation for dynamic tool creation. The system is:

- **Safe**: Validated blocklist/allowlist, sandboxed execution
- **Scalable**: Hot-loading, no restart required
- **Persistent**: Tools saved to disk across restarts
- **Extensible**: Agent can create unlimited tools
- **Monitorable**: Logging, API endpoints, error handling

This enables PersonalAIBotV2 to truly evolve and self-improve by creating new tools on-demand.
