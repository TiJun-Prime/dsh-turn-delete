import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}`))
    })
  })
}

// Spawn the tools' JS entry points through the current Node binary rather than
// the `node_modules/.bin` shims: on Windows those shims are `.cmd` files that
// spawn() cannot execute without a shell, so the build failed with ENOENT.
const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const tsdown = fileURLToPath(new URL('../node_modules/tsdown/dist/run.mjs', import.meta.url))

await rm(new URL('../lib', import.meta.url), { recursive: true, force: true })
await run(process.execPath, [tsc, '--noEmit'])
await run(process.execPath, [tsdown, '--config', 'tsdown.config.ts'])
