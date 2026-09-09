import { copyFile, mkdir } from 'node:fs/promises'
await mkdir(new URL('../dist/', import.meta.url), { recursive: true })
await copyFile(new URL('../client/index.js', import.meta.url), new URL('../dist/client.js', import.meta.url))
