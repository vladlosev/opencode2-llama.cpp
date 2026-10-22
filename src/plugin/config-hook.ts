import type {Plugin} from "@opencode/plugin"

type PluginContext = Plugin.Context
import {existsSync, readFileSync} from 'fs'
import {join} from 'path'
import stripJsonComments from 'strip-json-comments'
import {modelStatusCache} from '../cache'
import {categorizeModel, extractModelOwner, formatModelName} from '../utils'
import {autoDetectLlamaCpp, checkLlamaCppHealth, discoverLlamaCppModels, normalizeBaseURL} from '../utils/llama-cpp-api'
import type {LlamaCppModel} from '../types'
import {log} from '../utils/log'
import {isLlamaCppProvider} from './provider-options'

// Default llama.cpp URL
const DEFAULT_LLAMA_CPP_URL = "http://127.0.0.1:1234"

// Discovery belongs to the current OpenCode location.
interface DiscoveryState {
    providerID: string
    automatic: boolean
    cachedBaseURL: string | null
    models: LlamaCppModel[]
    stopped: boolean
    registration?: ReturnType<PluginContext['provider']['transform']>
}

// Read baseURL from opencode.json config files
function readBaseURLFromConfig(ctx: PluginContext): string | null {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const cwd = ctx.location.directory

    const configPaths = [
        join(home, '.config/opencode/opencode.json'),
        join(home, '.config/opencode/opencode.jsonc'),
        join(cwd, 'opencode.json'),
        join(cwd, 'opencode.jsonc'),
        join(cwd, '.opencode/opencode.json'),
        join(cwd, '.opencode/opencode.jsonc'),
    ]

    log.debug(`Searching config in: HOME=${home}, CWD=${cwd}`)

    for (const configPath of configPaths) {
        if (!existsSync(configPath)) {
            log.debug(`Config not found: ${configPath}`)
            continue
        }

        log.debug(`Reading config: ${configPath}`)

        try {
            const raw = readFileSync(configPath, 'utf-8')
            const cleaned = stripJsonComments(raw).replace(/,\s*([\]}])/g, '$1')
            const config = JSON.parse(cleaned)

            // V2 format: providers
            const providerV2 = config.providers?.['llama.cpp']
            if (providerV2?.settings?.baseURL) {
                log.debug(`Found baseURL in ${configPath} (V2)`)
                return providerV2.settings.baseURL
            }

            // V1 format: provider
            const providerV1 = config.provider?.['llama.cpp']
            if (providerV1?.settings?.baseURL) {
                log.debug(`Found baseURL in ${configPath} (V1 settings)`)
                return providerV1.settings.baseURL
            }
            if (providerV1?.options?.baseURL) {
                log.debug(`Found baseURL in ${configPath} (V1 options)`)
                return providerV1.options.baseURL
            }
        } catch (e) {
            log.warn(`Failed to parse ${configPath}`, {error: String(e)})
        }
    }

    return null
}

export async function createConfigHook(ctx: PluginContext) {
    const states = new Map<string, DiscoveryState>()
    let stopped = false
    let configuredPreviously = false
    let configuration: string | undefined

    async function refreshConfiguration(initial = false) {
        const available = (await ctx.provider.list()).data.filter(isLlamaCppProvider)
        // Explicit provider configuration creates an integration; autodetection
        // does not. Distinguish our own contribution from configured endpoints.
        const integrations = new Set((await ctx.integration.list()).data.map(item => item.id))
        if (stopped) return
        const configured = available.filter(provider => !states.get(provider.id)?.automatic || integrations.has(provider.id))
        let providers: Array<{id: string, automatic: boolean, baseURL: string}> = configured.map(provider => ({id: provider.id, automatic: false,
            baseURL: normalizeBaseURL(typeof provider.settings?.baseURL === 'string' ? provider.settings.baseURL : undefined)}))
        if (initial && !providers.length) {
            const baseURL = readBaseURLFromConfig(ctx)
            if (baseURL) providers = [{id: 'llama.cpp', automatic: false, baseURL: normalizeBaseURL(baseURL)}]
        }
        if (providers.length) configuredPreviously = true
        const next = JSON.stringify(providers.map(provider => [provider.id, provider.baseURL]).sort())
        if (next === configuration) return
        configuration = next
        if (!providers.length && !configuredPreviously) {
            if (!states.size) providers = [{id: 'llama.cpp', automatic: true, baseURL: ''}]
            else return
        }
        for (const [id, state] of states) {
            if (providers.some(provider => provider.id === id)) continue
            state.stopped = true
            await (await state.registration)?.dispose()
            states.delete(id)
            await ctx.provider.reload()
        }
        for (const provider of providers) {
            let state = states.get(provider.id)
            if (!state) {
                state = {providerID: provider.id, automatic: provider.automatic, cachedBaseURL: null, models: [], stopped: false}
                states.set(provider.id, state)
            }
            state.automatic = provider.automatic
            if (stopped) return
            await detectAndRegister(ctx, state)
        }
    }

    try {
        await refreshConfiguration(true)
        const refreshInterval = setInterval(() => {
            for (const state of states.values()) {
                refreshModels(ctx, state).catch(error => {
                    log.warn("Periodic refresh failed", {error: String(error)})
                })
            }
        }, 60_000)
        return {
            refreshConfiguration,
            cleanup: async () => {
                stopped = true
                clearInterval(refreshInterval)
                for (const state of states.values()) {
                    state.stopped = true
                    await (await state.registration)?.dispose()
                }
            },
        }
    } catch (error) {
        for (const state of states.values()) {
            state.stopped = true
            await (await state.registration)?.dispose()
        }
        log.error("Failed to initialize config hook", {error: String(error)})
        throw error
    }
}

async function detectAndRegister(ctx: PluginContext, state: DiscoveryState): Promise<void> {
    let baseURL: string | null = null

    // 1. Prefer resolved settings when OpenCode has loaded the provider.
    if (!baseURL) {
        try {
            const {data: existingProvider} = await ctx.provider.get({providerID: state.providerID})
            if (existingProvider) {
                baseURL = normalizeBaseURL(
                    (existingProvider as any).settings?.baseURL || DEFAULT_LLAMA_CPP_URL
                )
            }
        } catch (e) {
            log.warn("Failed to read provider", {error: String(e)})
        }
    }

    // 2. Config files are available before OpenCode applies provider settings.
    if (!baseURL && state.providerID === 'llama.cpp') baseURL = readBaseURLFromConfig(ctx)

    // 3. Auto-detect on localhost
    if (!baseURL && state.automatic) {
        log.debug("Trying auto-detect on localhost...")
        const detectedURL = await autoDetectLlamaCpp()
        if (detectedURL) {
            baseURL = detectedURL
        }
    }

    if (!baseURL) {
        log.warn("No llama.cpp server found")
        return
    }

    log.info(`Using baseURL: ${baseURL}`)

    // Cache for subsequent refresh cycles
    if (state.cachedBaseURL !== normalizeBaseURL(baseURL)) {
        state.cachedBaseURL = normalizeBaseURL(baseURL)
        state.models = []
        if (state.registration) await ctx.provider.reload()
    }

    // Check health
    const isHealthy = await checkLlamaCppHealth(baseURL)
    if (!isHealthy) {
        log.warn("llama.cpp appears to be offline", {baseURL})
        return
    }

    // Discover and register models
    await discoverAndRegister(ctx, baseURL, state)
}

function applyModelInfo(model: LlamaCppModel, modelInfo: any) {
    modelInfo.name = formatModelName(model)

    const owner = extractModelOwner(model.id)
    if (owner) {
        modelInfo.organizationOwner = owner
    }

    const contextSize = model.context_length || model.context_window
    if (contextSize) {
        modelInfo.limit = {
            ...modelInfo.limit,
            context: contextSize,
        }
    }

    const outputSize = model.meta?.llamaswap?.limit?.output
    if (outputSize) {
        modelInfo.limit = {
            ...modelInfo.limit,
            output: outputSize,
        }
    }

    if (model.created) {
        modelInfo.time = {
            ...modelInfo.time,
            released: model.created,
        }
    }

    const supportsTools = model.capabilities?.function_calling === true
        || model.supported_parameters?.includes("tools") === true
    modelInfo.capabilities = {
        ...modelInfo.capabilities,
        tools: supportsTools,
    }

    const modelType = categorizeModel(model.id)
    if (modelType === 'embedding') {
        modelInfo.capabilities.input = ["text"]
        modelInfo.capabilities.output = ["embedding"]
    } else if (modelType === 'chat') {
        const inputModalities = model.architecture?.input_modalities
        if (inputModalities && inputModalities.length > 0) {
            modelInfo.capabilities.input = inputModalities
        } else {
            const hasVision = model.capabilities?.vision === true
            const input = ["text"]
            if (hasVision) input.push("image")
            modelInfo.capabilities.input = input
        }
        modelInfo.capabilities.output = ["text"]
    }
}

async function discoverAndRegister(ctx: PluginContext, baseURL: string, state: DiscoveryState): Promise<void> {
    let models: LlamaCppModel[]
    try {
        models = await discoverLlamaCppModels(baseURL)
    } catch (error) {
        log.warn("Model discovery failed", {
            error: error instanceof Error ? error.message : String(error)
        })
        return
    }

    if (state.stopped || normalizeBaseURL(baseURL) !== state.cachedBaseURL) return
    if (models.length === 0) {
        log.warn("No models found in llama.cpp")
        return
    }

    state.models = models
    await (state.registration ??= ctx.provider.transform((catalog) => {
        if (state.stopped) return
        const existing = catalog.get(state.providerID)
        catalog.update(state.providerID, (provider: any) => {
            // Late discoveries may register after the configuration adapter.
            // Preserve its endpoint and activation rather than overriding them.
            if (!existing) {
                provider.name = "llama.cpp (local)"
                provider.activation = state.automatic ? "enabled" : "disabled"
                if (state.automatic) provider.canonical = "llama.cpp"
                provider.settings = {
                    ...provider.settings,
                    baseURL: `${state.cachedBaseURL}/v1`,
                }
            }
            provider.package ||= "@opencode/ai/providers/openai-compatible"
        })

        for (const model of state.models) {
            catalog.models.update(state.providerID, model.id, (modelInfo: any) => {
                applyModelInfo(model, modelInfo)
            })
        }
    }))

    await ctx.provider.reload()
    log.info(`Discovered ${models.length} models from llama.cpp`)

    // Warm up cache
    try {
        await modelStatusCache.getModels(baseURL, async () => {
            return models.map(m => m.id)
        })
    } catch {
        // Cache warming failed, not critical
    }
}

async function refreshModels(ctx: PluginContext, state: DiscoveryState): Promise<void> {
    // Use cached baseURL — never re-read config after startup
    let baseURL = state.cachedBaseURL

    // Fallback to catalog only if cache is empty (shouldn't happen after startup)
    if (!baseURL) {
        try {
            const providers = await ctx.provider.list()
            const provider = providers.data?.find((p: any) => p.id === state.providerID)
            if (provider) {
                baseURL = normalizeBaseURL(
                    (provider as any).settings?.baseURL || DEFAULT_LLAMA_CPP_URL
                )
            }
        } catch {
            // Catalog read failed
        }
    }

    if (state.stopped || !baseURL) return

    // Check health
    const isHealthy = await checkLlamaCppHealth(baseURL)
    if (!isHealthy) return

    // Discover and register models
    try {
        const models = await discoverLlamaCppModels(baseURL)
        if (state.stopped || normalizeBaseURL(baseURL) !== state.cachedBaseURL) return
        if (models.length > 0) {
            state.models = models
            if (!state.registration) await discoverAndRegister(ctx, baseURL, state)
            else await ctx.provider.reload()
        }
    } catch (error) {
        log.warn("Refresh failed", {error: String(error)})
    }
}
