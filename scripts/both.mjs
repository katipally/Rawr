import { spawn } from 'node:child_process'

/** The app and the job daemon in one container, for a host that sells one process.
 *
 *  Two containers off the same image is the better shape and the one to move to: a
 *  job that wedges or leaks then takes down the daemon and not the app people are
 *  looking at. This exists because the difference on a free tier is between
 *  scheduled work happening and not happening at all.
 *
 *  It supervises rather than backgrounds: `a & b & wait` reports the shell's exit
 *  status, so a daemon that died at 03:00 leaves a container that still looks
 *  healthy and a queue that silently stops draining. Here, either child exiting
 *  takes the container down and the host restarts it.
 *
 *  Paths are the image's layout, from the repository root. See the Dockerfile. */
const CHILDREN = [
  ['web', 'apps/web/server.js'],
  ['worker', 'apps/worker/src/index.ts'],
]

let stopping = false

const children = CHILDREN.map(([name, entry]) => {
  const child = spawn(process.execPath, [entry], { stdio: 'inherit' })
  child.on('exit', (code, signal) => {
    if (stopping) return
    console.error(`[both] ${name} exited (${signal ?? code}). Stopping the container.`)
    stop(signal ? 1 : (code ?? 1))
  })
  return child
})

/** SIGTERM to each, then leave. The web server and the worker both drain on it,
 *  and the host's own kill timer is the backstop if one will not. */
const stop = (code) => {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  process.exitCode = code
}

process.on('SIGTERM', () => stop(0))
process.on('SIGINT', () => stop(0))
