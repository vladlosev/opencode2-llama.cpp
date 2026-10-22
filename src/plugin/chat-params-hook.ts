import type {Plugin} from "@opencode/plugin"

type PluginContext = Plugin.Context
import {getLoadedModels} from './get-loaded-models'
import {normalizeBaseURL} from '../utils/llama-cpp-api'
import {categorizeError, retryWithBackoff} from '../utils'
import {log} from '../utils/log'

export async function createChatParamsHook(ctx: PluginContext): Promise<(() => Promise<void>) | void> {
    // Register session context hook for model validation
    const registration = await ctx.session.hook("context", async (event) => {
        const modelID = event.model?.id
        const providerID = event.model?.providerID

        // Only validate llama.cpp models
        if (providerID !== 'llama.cpp' || !modelID) {
            return
        }

        try {
            // Read OpenCode's resolved provider settings.
            const {data: provider} = await ctx.provider.get({providerID})

            if (!provider) {
                log.warn("Provider not found")
                return
            }

            const baseURL = normalizeBaseURL(
                (provider as any).settings?.baseURL || "http://127.0.0.1:1234"
            )

            // Validate model is loaded with retry logic
            const validationResult = await retryWithBackoff(
                async () => {
                    const loadedModels = await getLoadedModels(baseURL)
                    const isModelLoaded = loadedModels.includes(modelID)

                    if (!isModelLoaded) {
                        throw new Error(`Model '${modelID}' not loaded`)
                    }

                    return loadedModels
                },
                2, // Max 2 retries
                500 // 500ms base delay
            )

            if (!validationResult.success) {
                // Model not loaded - add warning to context
                const errorCategory = categorizeError(validationResult.error || "Validation failed", {
                    baseURL,
                    modelId: modelID
                })

                log.warn("Model validation failed", {
                    model: modelID,
                    error: validationResult.error,
                    errorType: errorCategory.type,
                    severity: errorCategory.severity,
                    baseURL
                })

                // Add system message warning about model status
                event.system.push({
                    type: "text",
                    text: `[llama.cpp warning] Model '${modelID}' is not currently loaded on the llama.cpp server at ${baseURL}. ` +
                          `The request may fail. Error: ${errorCategory.message}`
                })
            } else {
                log.debug(`Model '${modelID}' validated successfully`)
            }
        } catch (error) {
            log.error("Model validation error", {error: String(error)})
        }
    })

    // Return cleanup function
    return async () => {
        await registration.dispose()
    }
}
