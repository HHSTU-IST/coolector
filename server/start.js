import { spawn } from 'node:child_process'

const config = {
  appHost: process.env.APP_HOST ?? '0.0.0.0',
  appPort: process.env.APP_PORT ?? '5174',
  relayHost: process.env.HOST ?? process.env.RELAY_HOST ?? '0.0.0.0',
  relayPort: process.env.PORT ?? process.env.RELAY_PORT ?? '8787'
}

const processes = []
let isShuttingDown = false

function startProcess(name, command, args, env = {}) {
  const child = spawn(command, args, {
    env: {
      ...process.env,
      ...env
    },
    stdio: 'inherit'
  })

  processes.push({ name, child })

  child.on('exit', (code, signal) => {
    if (isShuttingDown) return

    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`
    console.error(`[start] ${name} exited with ${reason}`)
    shutdown(code && code > 0 ? code : 1)
  })
}

function shutdown(exitCode = 0) {
  if (isShuttingDown) return
  isShuttingDown = true

  for (const { child } of processes) {
    if (!child.killed) {
      child.kill('SIGTERM')
    }
  }

  setTimeout(() => {
    process.exit(exitCode)
  }, 300).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log('[start] Coolector quick start')
console.log(`[start] Web app: http://localhost:${config.appPort}`)
console.log(`[start] Relay:   http://localhost:${config.relayPort}`)

startProcess('web app', 'pnpm', ['exec', 'vite', '--host', config.appHost, '--port', config.appPort])
startProcess('relay server', 'node', ['server/relay-server.js'], {
  HOST: config.relayHost,
  PORT: config.relayPort
})
