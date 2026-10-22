import type {Plugin} from "@opencode/plugin"
import {log} from '../utils/log'

type PluginContext = Plugin.Context

export function createEventHook(ctx: PluginContext, refreshConfiguration: () => Promise<void>): (() => void) {
    const controller = new AbortController()

    // Subscribe to server events
    void (async () => {
        try {
            for await (const event of ctx.event.subscribe({signal: controller.signal})) {
                if (event.type === 'provider.updated' && event.location?.directory === ctx.location.directory) {
                    await refreshConfiguration()
                }
                // Monitor session events
                if (event.type === "session.created") {
                    log.debug(`Session event: ${event.type}`)
                }
            }
        } catch (error) {
            // Subscription was aborted or failed
            if (!controller.signal.aborted) {
                log.warn("Event subscription error", {error: String(error)})
            }
        }
    })()

    // Return cleanup function
    return () => {
        controller.abort()
    }
}
