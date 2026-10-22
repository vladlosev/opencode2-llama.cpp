# opencode-llama-cpp

OpenCode V2 plugin for enhanced llama.cpp support with auto-detection, dynamic model discovery, and enriched model metadata.

> **Note**: The migration to the OpenCode V2 API (and related development work) was carried out with the assistance of AI tools. Code correctness and behavior should be reviewed before production use.

## Features

- **Auto-detection**: Automatically detects a llama.cpp server running on common ports (1234, 8080, 11434)
- **Dynamic Model Discovery**: Queries llama.cpp's `/v1/models` endpoint and registers discovered models into the OpenCode provider registry (V2 API)
- **Enriched Model Metadata**:
  - Human-readable display names, preferring the name provided by the API (e.g., "Qwen3 30B A3B" instead of "qwen/qwen3-30b-a3b")
  - Context limit from `context_length` / `context_window`
  - Output limit from llama-swap metadata when available
  - Release date from the model's `created` field
  - Tool support detection (`function_calling` / `tools` parameter)
  - Input/output modalities, with embedding models classified accordingly
- **Organization Owner Extraction**: Extracts and sets the `organizationOwner` field from model IDs
- **Model Validation**: A session context hook verifies that the selected model is actually loaded on the server (with retry/backoff) and adds a system warning to the prompt if it is not
- **Periodic Refresh**: Re-discovers models every 60 seconds and reloads the providers
- **Health Check Monitoring**: Verifies the llama.cpp server is accessible before attempting operations
- **Caching**: A single shared model status cache reduces redundant API calls
- **Error Handling**: Smart error categorization with actionable messages
- **Logging**: Centralized logger with an `[opencode-llama-cpp]` prefix; set `DEBUG=1` for verbose debug output

## Installation

```bash
pnpm add opencode-plugin-llama.cpp
```

## Usage

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-plugin-llama.cpp"
  ],
  "providers": {
    "llama.cpp": {
      "package": "@opencode/ai/providers/openai-compatible",
      "name": "llama.cpp (local)",
      "settings": {
        "baseURL": "http://127.0.0.1:1234"
      }
    }
  }
}
```

Both configuration formats are supported:

- **V1**: `provider` with `options.baseURL`
- **V2**: `providers` with `settings.baseURL`

`baseURL` may include or omit the `/v1` suffix — it is normalized automatically.

### Auto-detection

If you haven't configured a llama.cpp provider, the plugin looks for a local
server on ports 1234, 8080, and 11434. When it finds one, it adds and enables
the `llama.cpp` provider for you, with `canonical` also set to `llama.cpp`.

You can use several llama.cpp servers by giving each provider its own ID and
server URL. Add `"canonical": "llama.cpp"` to each one so the plugin knows to
handle it. A provider whose ID is exactly `llama.cpp` works without this setting.
The plugin discovers models on each server separately and checks that your
selected model is loaded on the server you're using.

The plugin uses the settings supplied by OpenCode, including settings that arrive
after the plugin starts. If those aren't available yet, it can read the
`llama.cpp` provider's URL from your config file during startup.

Once you've configured a llama.cpp provider yourself, removing or disabling it
also removes its discovered models; the plugin won't automatically add a
replacement. Removing `"canonical": "llama.cpp"` from a provider with a custom
ID tells the plugin to stop discovering and checking models for that provider.

### Manual Configuration

You can also manually configure the provider with specific models:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-plugin-llama.cpp"
  ],
  "providers": {
    "llama.cpp": {
      "package": "@opencode/ai/providers/openai-compatible",
      "name": "llama.cpp (local)",
      "settings": {
        "baseURL": "http://127.0.0.1:1234"
    },
    "llama.cpp-remote": {
      "canonical": "llama.cpp",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://192.168.1.20:8080/v1"
      }
    }
  }
}
```

The plugin will automatically discover and register any additional models available on the llama.cpp server that aren't already configured.

## How It Works

1. On OpenCode startup, the plugin resolves llama.cpp endpoints through
   `ctx.provider.list()` and `ctx.provider.get()`, using OpenCode's merged configuration. Provider settings
   applied after plugin setup are picked up on `provider.updated`. If no endpoint
   is configured, localhost ports 1234, 8080, and 11434 are probed.
2. If a server is found, its health is checked via the `/v1/models` endpoint
3. Discovered models are registered into their respective providers in the OpenCode provider registry, enriched with metadata (display name, limits, capabilities, modalities, organization owner)
4. Models are re-discovered every 60 seconds and the providers are reloaded
5. On every chat request, a session context hook validates that the selected model is loaded on the server (with retry/backoff); if validation fails, a warning is added to the system prompt

## Debugging

Set the `DEBUG` environment variable to enable verbose logging:

```bash
DEBUG=1 opencode
```

Log lines are prefixed with `[opencode-llama-cpp]`.

## Requirements

- OpenCode (V2)
- One or more reachable llama.cpp servers
- Node.js 22.19.0+ (global `fetch`)

## Development

The project uses pnpm exclusively.

```bash
pnpm install        # install dependencies
pnpm test           # run unit tests
pnpm test:coverage  # run tests with coverage report
pnpm validate       # lint + typecheck + tests
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

Run `pnpm test:opencode` with OpenCode in PATH to verify directory loading
and configured discovery in a temporary HOME and isolated service.
