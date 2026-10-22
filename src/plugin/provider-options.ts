export function isLlamaCppProvider(provider: {id: string, canonical?: string}): boolean {
    return provider.id === 'llama.cpp' || provider.canonical === 'llama.cpp'
}
