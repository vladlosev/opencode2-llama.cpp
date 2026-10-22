// Verify directory loading and late provider configuration in an isolated host.
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
const fixture = createServer((request, response) => {
    assert.equal(request.url, '/v1/models')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({data: [{id: 'fixture-model', name: 'Fixture Model', created: 1700000000,
        context_length: 32768, capabilities: {function_calling: true}}]}))
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
let success = false
try {
    assert.match(await run(['--version']), /\bv2\.1\.2\b/, 'Use OpenCode 2.1.2 for this compatibility test')
    await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({
        plugins: [repo],
        providers: {'llama.cpp': {package: '@opencode/ai/providers/openai-compatible',
            settings: {baseURL: `http://127.0.0.1:${fixture.address().port}/v1`}}},
    }))
    const reservation = createServer()
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const port = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    await run(['service', 'set', 'port', String(port)])
    const api = async path => JSON.parse(await run(['api', 'get',
        `${path}?${new URLSearchParams({'location[directory]': root})}`])).data
    let plugin, model
    const deadline = Date.now() + 30000
    do {
        plugin = (await api('/api/plugin')).find(item => item.id === 'llama-cpp' || item.source?.path?.startsWith(repo))
        if (plugin?.state.status === 'failed') break
        model = (await api('/api/model')).find(item => item.providerID === 'llama.cpp' && item.id === 'fixture-model')
        if (plugin?.state.status === 'active' && model) break
        await delay(100)
    } while (Date.now() < deadline)
    assert.equal(plugin?.state.status, 'active', JSON.stringify(plugin))
    assert.ok(model, 'The plugin must discover the endpoint configured after its setup')
    assert.equal(model.name, 'Fixture Model')
    assert.equal(model.limit.context, 32768)
    assert.equal(model.capabilities.tools, true)
    success = true
    console.log('OpenCode 2.1.2 smoke test passed: directory plugin active; configured models discovered.')
} finally {
    await run(['service', 'stop']).catch(() => {})
    await new Promise(resolve => fixture.close(resolve))
    if (success) await rm(root, {recursive: true, force: true})
    else console.error(`Isolated diagnostics retained at ${root}`)
}
