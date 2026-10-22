import {Plugin} from "@opencode/plugin"
import {createConfigHook} from './config-hook'
import {createChatParamsHook} from './chat-params-hook'
import {createEventHook} from './event-hook'
import {log} from '../utils/log'

/**
 * llama.cpp Plugin - V2 Version
 *
 * Features:
 * - Auto-detection of running llama.cpp instance
 * - Dynamic model discovery from llama.cpp API
 * - Real-time model validation with smart error handling
 * - Comprehensive caching system with API call reduction
 */
export const LlamaCppPlugin = Plugin.define({
    id: "llama-cpp",
    async setup(ctx) {
        log.info("llama.cpp plugin initialized")

        // Register provider transform for auto-detection and model discovery
        const config = await createConfigHook(ctx)

        // Register session hook for model validation
        const chatCleanup = await createChatParamsHook(ctx)

        // Register event subscription
        const eventCleanup = createEventHook(ctx, config.refreshConfiguration)

        // Return cleanup function
        return async () => {
            await config.cleanup()
            if (chatCleanup) await chatCleanup()
            if (eventCleanup) eventCleanup()
        }
    },
})
