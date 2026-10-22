// Verify multiple canonical providers and directory loading in an isolated host.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'

const repo = fileURLToPath(new URL('..', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'llama-v2-'))
const env = {
    PATH: process.env.PATH, HOME: root,
    XDG_CONFIG_HOME: join(root, '.config'), XDG_DATA_HOME: join(root, '.local/share'),
    XDG_STATE_HOME: join(root, '.local/state'), XDG_CACHE_HOME: join(root, '.cache'),
    NO_COLOR: '1',
}
function run(args) {
    return new Promise((resolve, reject) => {
        const child = spawn('opencode', args, {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']})
        let stdout = '', stderr = ''
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        const timeout = setTimeout(() => child.kill('SIGKILL'), 30000)
        child.on('error', reject)
        child.on('close', code => {
            clearTimeout(timeout)
            if (code === 0) resolve(stdout.trim())
            else reject(new Error(`opencode ${args.join(' ')} exited ${code}\n${stderr}`))
        })
    })
}
let unexpectedRequests = 0
function fixture(id, context) {
    return createServer((request, response) => {
        if (request.url !== '/v1/models') {
            unexpectedRequests++
            response.writeHead(404).end()
            return
        }
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({data: [{id, name: id, created: 1700000000,
            context_length: context, capabilities: {function_calling: true}}]}))
    })
}
const first = fixture('first-model', 32768)
const second = fixture('second-model', 8192)
for (const server of [first, second]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const firstURL = `http://127.0.0.1:${first.address().port}/v1`
const secondURL = `http://127.0.0.1:${second.address().port}/v1`
const provider = (baseURL, canonical) => ({...(canonical ? {canonical} : {}),
    package: '@opencode/ai/providers/openai-compatible', settings: {baseURL}})
let success = false
try {
    assert.match(await run(['--version']), /\bv2\.1\.2\b/, 'Use OpenCode 2.1.2 for this compatibility test')
    await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({
        plugins: [repo],
        providers: {
            'llama.cpp': provider(firstURL),
            'local-models': provider(secondURL, 'llama.cpp'),
            'llama.cpp.named': provider(firstURL, 'llama.cpp'),
            'llama.cpp.ignored': provider(`${secondURL}/ignored`),
        },
    }))
    const reservation = createServer()
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const port = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    await run(['service', 'set', 'port', String(port)])
    const api = async path => JSON.parse(await run(['api', 'get',
        `${path}?${new URLSearchParams({'location[directory]': root})}`])).data
    const expected = [
        ['llama.cpp', 'first-model', 32768],
        ['local-models', 'second-model', 8192],
        ['llama.cpp.named', 'first-model', 32768],
    ]
    let plugin, models = []
    const deadline = Date.now() + 30000
    do {
        plugin = (await api('/api/plugin')).find(item => item.id === 'llama-cpp' || item.source?.path?.startsWith(repo))
        if (plugin?.state.status === 'failed') break
        models = await api('/api/model')
        if (plugin?.state.status === 'active' && expected.every(([providerID, id]) => models.some(model => model.providerID === providerID && model.id === id))) break
        await delay(100)
    } while (Date.now() < deadline)
    assert.equal(plugin?.state.status, 'active', JSON.stringify(plugin))
    for (const [providerID, id, context] of expected) {
        const model = models.find(model => model.providerID === providerID && model.id === id)
        assert.ok(model, `The plugin must discover ${id} for ${providerID}`)
        assert.equal(model.limit.context, context)
        assert.equal(model.capabilities.tools, true)
    }
    assert.ok(!models.some(model => model.providerID === 'local-models' && model.id === 'first-model'), 'Endpoint inventories must stay separate')
    assert.ok(!models.some(model => model.providerID === 'llama.cpp.ignored'), 'An ID prefix alone must not enable discovery')
    assert.equal(unexpectedRequests, 0)
    success = true
    console.log('OpenCode 2.1.2 smoke test passed: exact-ID and canonical providers discovered across two endpoints; prefix-only provider ignored.')
} finally {
    await run(['service', 'stop']).catch(() => {})
    for (const server of [first, second]) await new Promise(resolve => server.close(resolve))
    if (success) await rm(root, {recursive: true, force: true})
    else console.error(`Isolated diagnostics retained at ${root}`)
}
