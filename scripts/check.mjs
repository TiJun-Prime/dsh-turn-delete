import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env, ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}`))
    })
  })
}

// `npm_execpath` is set by npm while a script runs; going through the current
// Node binary keeps this working on Windows, where the `npm` shim is a `.cmd`
// file that spawn() cannot execute directly.
const npmCli = process.env.npm_execpath
const npm = npmCli === undefined
  ? (args) => run('npm', args, { shell: process.platform === 'win32' })
  : (args) => run(process.execPath, [npmCli, ...args])

await npm(['run', 'build'])
await npm(['test'])
await npm(['run', 'smoke'])
await npm(['pack', '--dry-run'])
