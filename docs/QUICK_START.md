# Quick Start: Auto-Tool Generation

## Getting Started (5 minutes)

### 1. Build the Project

```bash
cd /sessions/intelligent-modest-gauss/mnt/PersonalAIBotV2/server
npm run build
```

Expected output: `tsc` compiles successfully with no errors.

### 2. Start the Server

```bash
npm run dev
# Or: npm start
```

Server will automatically load any existing dynamic tools from `server/dynamic_tools/`.

### 3. Verify Setup

```bash
# List all dynamic tools (should be empty initially)
curl http://localhost:3000/api/dynamic-tools

# Expected response:
# {
#   "success": true,
#   "count": 0,
#   "tools": []
# }
```

## Create Your First Tool (via API)

### Step 1: Define the Tool

Create a simple weather tool:

```bash
curl -X POST http://localhost:3000/api/dynamic-tools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "get-time",
    "description": "Get current date and time",
    "code": "return new Date().toISOString();",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  }'
```

Expected response:
```json
{
  "success": true,
  "message": "Tool 'get-time' created successfully",
  "warnings": []
}
```

### Step 2: Test the Tool

```bash
curl -X POST http://localhost:3000/api/dynamic-tools/get-time/test \
  -H "Content-Type: application/json" \
  -d '{"args": {}}'
```

Expected response:
```json
{
  "success": true,
  "name": "get-time",
  "result": "2025-03-07T12:34:56.789Z"
}
```

### Step 3: List All Tools

```bash
curl http://localhost:3000/api/dynamic-tools
```

Your new tool should appear in the list!

### Step 4: Delete the Tool

```bash
curl -X DELETE http://localhost:3000/api/dynamic-tools/get-time
```

## Create Tools via AI Agent

### Using the create_tool Function

The AI agent can create tools directly:

```typescript
// Agent calls this function
create_tool(
  name: "summarize-text",
  description: "Summarize any text to key points",
  code: `
const text = String(args.text || '');
const sentences = text.split(/[.!?]+/).filter(s => s.trim());
const summary = sentences.slice(0, 3).join('. ') + '.';
return summary;
  `,
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to summarize" }
    },
    required: ["text"]
  }
)
```

Once created, the agent can use it immediately:

```typescript
summarize-text(text: "Long article text here...")
```

## Common Tool Examples

### 1. Simple Data Processing

```json
{
  "name": "count-words",
  "description": "Count words in text",
  "code": "const text = String(args.text || ''); return text.split(/\\s+/).length.toString();",
  "parameters": {
    "type": "object",
    "properties": {
      "text": { "type": "string" }
    }
  }
}
```

### 2. API Call

```json
{
  "name": "fetch-json",
  "description": "Fetch JSON from URL",
  "code": "const url = args.url; const res = await fetch(url); const data = await res.json(); return JSON.stringify(data, null, 2);",
  "parameters": {
    "type": "object",
    "properties": {
      "url": { "type": "string" }
    }
  }
}
```

### 3. Math Operations

```json
{
  "name": "calculate",
  "description": "Perform basic math",
  "code": "const a = parseFloat(args.a); const b = parseFloat(args.b); const op = args.op; let result; if(op === '+') result = a+b; else if(op === '-') result = a-b; else if(op === '*') result = a*b; else if(op === '/') result = a/b; return result.toString();",
  "parameters": {
    "type": "object",
    "properties": {
      "a": { "type": "number" },
      "b": { "type": "number" },
      "op": { "type": "string", "enum": ["+", "-", "*", "/"] }
    }
  }
}
```

## Useful API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/dynamic-tools` | List all tools |
| GET | `/api/dynamic-tools/:name` | Get tool details |
| POST | `/api/dynamic-tools` | Create new tool |
| POST | `/api/dynamic-tools/:name/test` | Test tool |
| DELETE | `/api/dynamic-tools/:name` | Delete tool |
| POST | `/api/dynamic-tools/refresh` | Reload from disk |

## Troubleshooting

### Tool Not Created

1. Check response for validation errors
2. Verify JSON syntax is valid
3. Ensure `code` is valid JavaScript

### Tool Execution Fails

1. Test with `/test` endpoint first
2. Check if code returns a string
3. Review timeout (max 30 seconds)
4. Check allowed modules are used

### Tool Not Loading on Startup

1. Verify `server/dynamic_tools/` directory exists
2. Check JSON files are valid
3. Review server logs for errors
4. Run `POST /api/dynamic-tools/refresh` manually

## Best Practices

1. **Keep Tools Simple** - One tool, one job
2. **Return Strings** - Always return `string` from code
3. **Handle Errors** - Wrap code in try/catch
4. **Test First** - Use `/test` endpoint before using
5. **Document Parameters** - Clear JSON Schema descriptions
6. **Use async/await** - For I/O operations
7. **No Side Effects** - Tools should be pure functions

## Example: Complete Weather Tool

```bash
curl -X POST http://localhost:3000/api/dynamic-tools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "weather-summary",
    "description": "Get weather summary from Open-Meteo API",
    "code": "
try {
  const lat = args.latitude || 13.7563;
  const lon = args.longitude || 100.5018;
  const url = \`https://api.open-meteo.com/v1/forecast?latitude=\${lat}&longitude=\${lon}&current_weather=true\`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.current_weather) {
    const w = data.current_weather;
    return \`Temperature: \${w.temperature}°C, Wind: \${w.windspeed} km/h\`;
  }

  return \"Could not fetch weather\";
} catch(err) {
  return \"Error: \" + err.message;
}
    ",
    "parameters": {
      "type": "object",
      "properties": {
        "latitude": {
          "type": "number",
          "description": "Latitude coordinate"
        },
        "longitude": {
          "type": "number",
          "description": "Longitude coordinate"
        }
      }
    }
  }'
```

Test it:

```bash
curl -X POST http://localhost:3000/api/dynamic-tools/weather-summary/test \
  -H "Content-Type: application/json" \
  -d '{"args": {"latitude": 13.7563, "longitude": 100.5018}}'
```

## Next Steps

1. Read `/AUTO_TOOL_GENERATION.md` for detailed documentation
2. Check `/IMPLEMENTATION_SUMMARY.md` for technical details
3. Create tools via agent or API
4. Test tools with `/test` endpoint
5. Monitor server logs for issues

## Support

- **Questions?** See `/AUTO_TOOL_GENERATION.md`
- **Issues?** Check server logs in console
- **Examples?** See `server/dynamic_tools/_example.json`

---

**Ready to go!** Start creating tools now.
