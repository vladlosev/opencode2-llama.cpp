import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Model, Plugin, Provider} from '@opencode/plugin'
import type {ProviderEditor, ProviderRecord} from '@opencode/plugin/promise/provider'
import type {SessionContext} from '@opencode/plugin/promise/session'
import {modelStatusCache} from '../src/cache'
import {LlamaCppPlugin} from '../index'

// The 2.1.2 editor creates missing provider/model definitions on update.
// Replaying it exercises the plugin's contribution rather than mocked calls.
function createContext(provider?: Provider.Info, directory = '/isolated-project') {
    const transforms = new Set<(editor: ProviderEditor) => void>()
    let configured = provider
    let hook: ((event: SessionContext) => Promise<void> | void) | undefined
    let notify: (() => void) | undefined
    let eventSignal: AbortSignal | undefined
    const records = () => {
        const entries = new Map<string, ProviderRecord>()
        const entry = (id: string) => {
            if (!entries.has(id)) entries.set(id, {provider: Provider.Info.empty(Provider.ID.make(id)), models: new Map()})
            return entries.get(id)!
        }
        const editor = {
            update: (id, update) => update(entry(id).provider as Parameters<typeof update>[0]),
            models: {update: (id, modelID, update) => {
                const models = entry(id).models as Map<string, Model.Info>
                if (!models.has(modelID)) models.set(modelID, Model.Info.default(Provider.ID.make(id), Model.ID.make(modelID)))
                update(models.get(modelID)! as Parameters<typeof update>[0])
            }},
        } as ProviderEditor
        for (const transform of transforms) transform(editor)
        // OpenCode's configuration adapter applies settings after user plugins.
        if (configured) {
            const record = entry(configured.id)
            entries.set(configured.id, {...record, provider: {...record.provider, ...configured}})
        }
        return entries
    }
    const location = {directory}
    const ctx = {
        app: {version: '2.1.2'}, location, options: {},
        provider: {
            get: async ({providerID}: {providerID: string}) => {
                const record = records().get(providerID)
                if (!record) throw new Error('Provider not found')
                return {location, data: record.provider}
            },
            list: async () => ({location, data: [...records().values()].map(record => record.provider)}),
            transform: async (transform: (editor: ProviderEditor) => void) => {
                transforms.add(transform)
                return {dispose: async () => { transforms.delete(transform) }}
            },
            reload: async () => { records() },
        },
        session: {hook: async (_name: string, callback: typeof hook) => {
            hook = callback
            return {dispose: async () => { hook = undefined }}
        }},
        event: {subscribe: ({signal}: {signal: AbortSignal}) => {
            eventSignal = signal
            return (async function* () {
                while (!signal.aborted) {
                    await new Promise<void>(resolve => {
                        notify = resolve
                        signal.addEventListener('abort', () => resolve(), {once: true})
                    })
                    if (!signal.aborted) yield {type: 'provider.updated', location}
                }
            })()
        }},
    } as unknown as Plugin.Context
    return {
        ctx, records,
        configure: (value: Provider.Info) => { configured = value; notify?.() },
        get registrationCount() { return transforms.size },
        get eventSignal() { return eventSignal },
        request: async (providerID = 'llama.cpp', id = 'qwen/test') => {
            const event = {model: {providerID, id}, system: []} as unknown as SessionContext
            await hook?.(event)
            return event
        },
    }
}

function configured(baseURL: string): Provider.Info {
    return {...Provider.Info.empty(Provider.ID.make('llama.cpp')), activation: 'enabled',
        package: '@opencode/ai/providers/openai-compatible', settings: {baseURL}}
}

describe('OpenCode 2.1.2 compatibility', () => {
    const cleanups: Plugin.Cleanup[] = []
    let inventory: Array<Record<string, unknown>>
    let requests: string[]
    let offline: boolean

    beforeEach(() => {
        vi.useFakeTimers()
        modelStatusCache.invalidateAll()
        inventory = [{id: 'qwen/test', name: 'Test Qwen', created: 1700000000,
            context_length: 32768, capabilities: {function_calling: true, vision: true}}]
        requests = []
        offline = false
        vi.stubGlobal('fetch', async (url: string) => {
            requests.push(url)
            if (offline || !url.includes(':8080/')) throw new Error('ECONNREFUSED')
            return Response.json({data: inventory})
        })
        vi.spyOn(console, 'info').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
        modelStatusCache.invalidateAll()
        vi.useRealTimers()
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
        vi.restoreAllMocks()
    })

    async function start(context: ReturnType<typeof createContext>) {
        const cleanup = await LlamaCppPlugin.setup(context.ctx)
        if (cleanup) cleanups.push(cleanup)
        return cleanup!
    }

    it('discovers configured models through the native provider editor', async () => {
        const context = createContext(configured('http://configured:8080/v1'))
        await start(context)
        expect(requests.every(url => url === 'http://configured:8080/v1/models')).toBe(true)
        expect(context.records().get('llama.cpp')!.models.get('qwen/test')).toMatchObject({
            name: 'Test Qwen', modelID: 'qwen/test', providerID: 'llama.cpp',
            limit: {context: 32768}, capabilities: {tools: true, input: ['text', 'image'], output: ['text']},
        })
    })

    it('creates a runnable native provider when a local server is autodetected', async () => {
        const context = createContext()
        await start(context)
        expect(context.records().get('llama.cpp')!.provider).toMatchObject({
            activation: 'enabled', package: '@opencode/ai/providers/openai-compatible',
            settings: {baseURL: 'http://127.0.0.1:8080/v1'},
        })
        expect(context.records().get('llama.cpp')!.models.has('qwen/test')).toBe(true)
    })

    it('reads the project JSONC file before provider settings are available', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'llama-config-'))
        vi.stubEnv('HOME', directory)
        try {
            writeFileSync(join(directory, 'opencode.jsonc'), `{
                // Settings are not in the provider registry yet.
                "providers": {"llama.cpp": {"settings": {"baseURL": "http://configured:8080/v1",},},},
            }`)
            const context = createContext(undefined, directory)
            await start(context)
            expect(requests.every(url => url === 'http://configured:8080/v1/models')).toBe(true)
            expect(context.records().get('llama.cpp')!.models.has('qwen/test')).toBe(true)
        } finally {
            rmSync(directory, {recursive: true})
        }
    })

    it('discovers settings applied after plugin setup without looping on its own reload', async () => {
        const context = createContext()
        await start(context)
        context.configure(configured('http://configured:8080/v1'))
        await vi.advanceTimersByTimeAsync(0)
        expect(requests.at(-1)).toBe('http://configured:8080/v1/models')
        const count = requests.length
        context.configure(configured('http://configured:8080/v1'))
        await vi.advanceTimersByTimeAsync(0)
        expect(requests).toHaveLength(count)
    })

    it('refreshes a single transform and releases registrations and timers on unload', async () => {
        const context = createContext(configured('http://configured:8080/v1'))
        const cleanup = await start(context)
        inventory = [{id: 'replacement'}]
        await vi.advanceTimersByTimeAsync(60000)
        expect([...context.records().get('llama.cpp')!.models.keys()]).toEqual(['replacement'])
        expect(context.registrationCount).toBe(1)
        await cleanup()
        expect(context.registrationCount).toBe(0)
        expect(context.eventSignal?.aborted).toBe(true)
        const count = requests.length
        await vi.advanceTimersByTimeAsync(120000)
        expect(requests).toHaveLength(count)
    })

    it('withdraws autodetected models when late configuration selects an offline endpoint', async () => {
        const context = createContext()
        await start(context)
        expect(context.records().get('llama.cpp')!.models.has('qwen/test')).toBe(true)
        context.configure(configured('http://offline:9090/v1'))
        await vi.advanceTimersByTimeAsync(0)
        expect(context.records().get('llama.cpp')!.models.size).toBe(0)
    })

    it('retries an offline configured endpoint on the existing refresh interval', async () => {
        const context = createContext(configured('http://configured:8080/v1'))
        offline = true
        await start(context)
        expect(context.records().get('llama.cpp')!.models.size).toBe(0)
        offline = false
        await vi.advanceTimersByTimeAsync(60000)
        expect(context.records().get('llama.cpp')!.models.has('qwen/test')).toBe(true)
    })

    it('disposes a registration that is still pending when the plugin unloads', async () => {
        const context = createContext(configured('http://configured:8080/v1'))
        offline = true
        const cleanup = await start(context)
        offline = false
        const transform = context.ctx.provider.transform
        let finishRegistration!: () => void
        vi.spyOn(context.ctx.provider, 'transform').mockImplementation(async callback => {
            const registration = await transform(callback)
            await new Promise<void>(resolve => { finishRegistration = resolve })
            return registration
        })
        await vi.advanceTimersByTimeAsync(60000)
        expect(context.registrationCount).toBe(1)
        const closing = cleanup()
        finishRegistration()
        await closing
        expect(context.registrationCount).toBe(0)
    })

    it('validates selected models using the native provider API and ignores other providers', async () => {
        const context = createContext(configured('http://configured:8080/v1'))
        await start(context)
        expect((await context.request()).system).toEqual([])
        const missing = context.request('llama.cpp', 'missing')
        await vi.advanceTimersByTimeAsync(2000)
        expect((await missing).system).toEqual([expect.objectContaining({text: expect.stringContaining('missing')})])
        expect((await context.request('other', 'missing')).system).toEqual([])
    })
})
