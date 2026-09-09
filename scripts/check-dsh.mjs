// Test the plugin against one exact DSH release without replacing development dependencies.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version ?? '')) {
  throw new Error('Usage: npm run check:dsh -- <exact DSH version>')
}
const root = fileURLToPath(new URL('../', import.meta.url))
const target = join(root, '.acceptance', 'compatibility', version)
await mkdir(target, { recursive: true })
for (const name of ['src', 'client', 'test', 'scripts', 'tsconfig.json', 'tsconfig.test.json', 'vitest.config.ts', 'cordis.patch.yml']) {
  await cp(join(root, name), join(target, name), { recursive: true, filter: source => !basename(source).startsWith('.') })
}
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
// Union of the package names in the five tested full DSH installations.
const packages = JSON.parse(await readFile(join(root, 'scripts/dsh-packages.json'), 'utf8'))
manifest.private = true
manifest.devDependencies['@deepseek-ai/dsh'] = version
// Pin peers and transitive DSH services, so npm cannot silently mix host versions.
for (const group of ['peerDependencies', 'devDependencies']) {
  for (const name of Object.keys(manifest[group])) {
    if (name.startsWith('@deepseek-ai/dsh-')) manifest[group][name] = version
  }
}
manifest.overrides = Object.fromEntries(packages.map(name => [name, version]))
await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this script with npm run check:dsh so it can reuse the active npm CLI.')
const env = { ...process.env, npm_config_devdir: join(root, '.acceptance', 'node-gyp') }
function run(args) {
  const child = spawnSync(process.execPath, [npm, ...args], { cwd: target, env, stdio: 'inherit' })
  if (child.error) throw child.error
  if (child.status !== 0) process.exit(child.status ?? 1)
}
run(['install', '--no-audit', '--no-fund'])
const installed = JSON.parse(await readFile(join(target, 'package-lock.json'), 'utf8'))
const mixed = Object.entries(installed.packages).filter(([path, pkg]) =>
  /node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(path) && pkg.version !== version)
if (mixed.length) throw new Error(`Mixed DSH versions: ${mixed.map(([path, pkg]) => `${path}@${pkg.version}`).join(', ')}`)
run(['run', 'check'])
const web = spawnSync(process.execPath, ['test/web-smoke.mjs', version], { cwd: target, env, stdio: 'inherit' })
if (web.error) throw web.error
if (web.status !== 0) process.exit(web.status ?? 1)
console.log(`PASS: DSH ${version}, Node ${process.version}; isolated checks completed.`)
