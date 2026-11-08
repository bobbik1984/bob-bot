// Files and shell commands on the machine BobBot runs on. The server decides what needs the owner's approval;
// this module only does the work and refuses folders that hold credentials.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_READ_CHARS = 60_000
const MAX_WRITE_CHARS = 200_000
const MAX_OUTPUT_CHARS = 12_000
const MAX_LISTED = 200
export const MAX_COMMAND_SECONDS = 300

/** Real path of the nearest existing ancestor plus the rest, so a symlink cannot hide a protected folder. */
function realish(p) {
  let current = path.resolve(p)
  const rest = []
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...rest) } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(p)
      rest.unshift(path.basename(current))
      current = parent
    }
  }
}
const inside = (child, parent) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Environment for commands: no API keys or tokens from the BobBot process. */
function cleanEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/KEY|TOKEN|SECRET|PASSWORD|^BOBBOT_|^DEEPSEEK_/i.test(key)) env[key] = value
  }
  return env
}

function clip(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  const half = MAX_OUTPUT_CHARS / 2
  return `${text.slice(0, half)}\n... (${text.length - MAX_OUTPUT_CHARS} characters omitted) ...\n${text.slice(-half)}`
}

export function createHostTools(dataDir) {
  const workspace = path.join(dataDir, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const workspaceReal = realish(workspace)
  const dataReal = realish(dataDir)
  const home = os.homedir()
  const guarded = [path.join(home, '.ssh'), path.join(home, '.gnupg'), '/etc/shadow', '/etc/sudoers', '/etc/sudoers.d'].map(realish)

  /** Relative paths start in the workspace. `blocked` covers BobBot's own data (keys, PIN, browser profile) and credential folders. */
  function classify(input) {
    const resolved = path.resolve(workspaceReal, String(input ?? '.'))
    const real = realish(resolved)
    const inWorkspace = inside(real, workspaceReal)
    const blocked = (!inWorkspace && inside(real, dataReal)) || guarded.some(g => inside(real, g))
    return { path: real, inWorkspace, blocked }
  }

  function listFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    const lines = entries.slice(0, MAX_LISTED).map(entry => {
      let size = ''
      if (entry.isFile()) { try { size = ` ${fs.statSync(path.join(dir, entry.name)).size} bytes` } catch { /* vanished */ } }
      return `${entry.name}${entry.isDirectory() ? '/' : ''}${size}`
    })
    const more = entries.length > MAX_LISTED ? `\n... and ${entries.length - MAX_LISTED} more` : ''
    return `${dir}\n${lines.join('\n') || '(empty folder)'}${more}`
  }

  function readFile(file, maxChars) {
    const limit = Math.min(Math.max(Number(maxChars) || MAX_READ_CHARS, 1), MAX_READ_CHARS)
    const stat = fs.statSync(file)
    if (stat.isDirectory()) throw new Error('That is a folder. Use list_files instead.')
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, limit * 4))
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0)
      const text = buffer.subarray(0, bytes).toString('utf8')
      if (text.includes('\u0000')) throw new Error('That looks like a binary file, not text.')
      const cut = text.length > limit || stat.size > bytes
      return cut ? `${text.slice(0, limit)}\n... (file is longer, showing the first ${Math.min(text.length, limit)} characters)` : text
    } finally { fs.closeSync(fd) }
  }

  function writeFile(file, content, append) {
    const text = String(content ?? '')
    if (text.length > MAX_WRITE_CHARS) throw new Error(`Too long to write in one go (limit ${MAX_WRITE_CHARS} characters).`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (append) fs.appendFileSync(file, text)
    else fs.writeFileSync(file, text)
    return `${append ? 'Appended' : 'Wrote'} ${text.length} characters to ${file}`
  }

  function runCommand(command, { cwd = workspaceReal, timeoutSeconds = 60 } = {}) {
    const seconds = Math.min(Math.max(Number(timeoutSeconds) || 60, 1), MAX_COMMAND_SECONDS)
    return new Promise(resolve => {
      const win = process.platform === 'win32'
      let child
      try {
        child = spawn(win ? 'powershell.exe' : '/bin/bash', win ? ['-NoProfile', '-Command', command] : ['-c', command], {
          cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: !win,
        })
      } catch (error) { resolve(`Could not start the command: ${error.message}`); return }
      let out = ''
      let timedOut = false
      const take = chunk => { out += chunk; if (out.length > 2_000_000) out = out.slice(-1_000_000) }
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      const timer = setTimeout(() => {
        timedOut = true
        try { if (win) child.kill(); else process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      }, seconds * 1000)
      child.on('error', error => { clearTimeout(timer); resolve(`Could not start the command: ${error.message}`) })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        const status = timedOut ? `timed out after ${seconds}s and was stopped` : signal ? `stopped by ${signal}` : `exit code ${code}`
        resolve(`${status}\n${clip(out) || '(no output)'}`)
      })
    })
  }

  return { workspace: workspaceReal, classify, listFiles, readFile, writeFile, runCommand }
}
