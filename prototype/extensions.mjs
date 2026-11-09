// Things Bob can install when the owner asks and confirms: system and language packages, MCP servers and skills.
// Everything here only validates input and builds files and commands. Asking the owner happens in the server.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const fail = (code, detail) => Object.assign(new Error(code), { code, detail })

// ---- packages ----
const NPM = /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*(@[\w.+~^<>=*|-]+)?$/i
const PIP = /^[A-Za-z0-9][A-Za-z0-9._-]*(==[\w.+!*-]+)?$/
const APT = /^[a-z0-9][a-z0-9+.-]*$/
export const MANAGERS = ['npm', 'pip', 'apt']

/** Package names only: no URLs, paths, flags or shell syntax can get through. */
export function checkPackages(manager, list) {
  if (!MANAGERS.includes(manager)) throw fail('BAD_MANAGER')
  if (!Array.isArray(list) || list.length < 1 || list.length > 10) throw fail('BAD_PACKAGES')
  const re = { npm: NPM, pip: PIP, apt: APT }[manager]
  return list.map(item => {
    const name = String(item).trim()
    if (!re.test(name) || name.length > 100) throw fail('BAD_PACKAGE_NAME', name)
    return name
  })
}

/** The exact commands to run, as argument lists (never through a shell). */
export function installSteps(manager, packages, { venvDir }) {
  if (manager === 'npm') return [{ file: 'npm', args: ['install', '-g', ...packages] }]
  if (manager === 'apt') {
    return [
      { file: 'sudo', args: ['-n', 'apt-get', 'update'] },
      { file: 'sudo', args: ['-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '--no-install-recommends', '--', ...packages] },
    ]
  }
  const steps = []
  if (!fs.existsSync(path.join(venvDir, 'bin', 'pip'))) steps.push({ file: 'python3', args: ['-m', 'venv', venvDir] })
  steps.push({ file: path.join(venvDir, 'bin', 'pip'), args: ['install', ...packages] })
  return steps
}

export const showSteps = steps => steps.map(s => [s.file, ...s.args].join(' ')).join('\n')

function cleanEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (!/KEY|TOKEN|SECRET|PASSWORD|^BOBBOT_|^DEEPSEEK_/i.test(key)) env[key] = value
  return env
}

/** Runs the steps one after another and stops at the first failure. Returns the combined tail of the output. */
export async function runSteps(steps, { cwd, timeoutMs = 300_000 }) {
  const started = Date.now()
  let log = ''
  for (const step of steps) {
    const left = timeoutMs - (Date.now() - started)
    if (left <= 0) return { ok: false, text: `${log}\nTimed out.` }
    const result = await new Promise(resolve => {
      let out = ''
      let child
      try { child = spawn(step.file, step.args, { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) { resolve({ code: -1, out: error.message }); return }
      child.stdout.on('data', d => { out += d })
      child.stderr.on('data', d => { out += d })
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } out += '\nTimed out.'; }, left)
      child.on('error', error => { clearTimeout(timer); resolve({ code: -1, out: `${out}\n${error.message}` }) })
      child.on('close', code => { clearTimeout(timer); resolve({ code, out }) })
    })
    log += `$ ${[step.file, ...step.args].join(' ')}\n${result.out.slice(-3000)}\n`
    if (result.code !== 0) return { ok: false, text: `${log}\nFailed (exit code ${result.code}).` }
  }
  return { ok: true, text: log.slice(-6000) }
}

// ---- MCP servers ----
const MCP_NAME = /^[A-Za-z0-9_-]{1,32}$/
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const envKey = (server, variable) => `BOBBOT_X_${server.toUpperCase().replace(/-/g, '_')}_${variable}`

/** `url` makes it a remote (streamable HTTP) server, otherwise `command` starts a local one over stdio. */
export function checkMcp(input) {
  const name = String(input?.name ?? '')
  if (!MCP_NAME.test(name) || name.toLowerCase() === 'bobbot') throw fail('BAD_NAME')
  const names = list => {
    const out = (list ?? []).map(String)
    if (out.length > 10 || out.some(n => !ENV_NAME.test(n))) throw fail('BAD_ENV_NAMES')
    return out
  }
  if (input.url) {
    const url = String(input.url).trim()
    if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 300) throw fail('BAD_URL')
    const bearerName = input.bearer_name ? names([input.bearer_name])[0] : null
    return { name, transport: 'http', url, bearerName, envNames: [], args: [], command: '' }
  }
  const command = String(input.command ?? '').trim()
  if (!command || command.length > 200 || /[\s\u0000-\u001f]/.test(command)) throw fail('BAD_COMMAND')
  const args = (input.args ?? []).map(String)
  if (args.length > 30 || args.some(a => a.length > 500 || /[\u0000-\u0008\u000e-\u001f]/.test(a))) throw fail('BAD_ARGS')
  return { name, transport: 'stdio', command, args, envNames: names(input.env_names), url: '', bearerName: null }
}

/** The extra DSH config that mounts the owner's MCP servers. A server that fails to start never stops Bob. */
export function mcpPatch(servers) {
  if (!servers.length) return ''
  const rows = servers.map(s => {
    const lines = [`    - id: mcp-${s.name}`, `      name: '@deepseek-ai/dsh-mcp-client'`, `      config:`, `        serverName: ${JSON.stringify(s.name)}`]
    if (s.transport === 'stdio') {
      lines.push(`        transport: stdio`, `        command: ${JSON.stringify(s.command)}`, `        args: ${JSON.stringify(s.args)}`)
      if (s.envNames.length) lines.push(`        env:`, ...s.envNames.map(n => `          ${n}: !!js process.env.${envKey(s.name, n)} ?? ""`))
    } else {
      lines.push(`        transport: streamable-http`, `        url: ${JSON.stringify(s.url)}`)
      if (s.bearerName) lines.push(`        headers:`, `          Authorization: !!js '\`Bearer \${process.env.${envKey(s.name, s.bearerName)} ?? ""}\`'`)
    }
    return lines.join('\n')
  })
  return `- insert:\n${rows.join('\n')}\n`
}

export class Extensions {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, 'extensions.json')
    this.patchFile = path.join(dir, 'dsh-extensions.patch.yml')
    this.skillsDir = path.join(dir, 'skills')
    this.venvDir = path.join(dir, 'tools', 'venv')
    fs.mkdirSync(this.skillsDir, { recursive: true })
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { /* first run */ }
    this.mcp = saved.mcp ?? []
    this.secrets = saved.secrets ?? {}
  }

  #save() { fs.writeFileSync(this.file, JSON.stringify({ mcp: this.mcp, secrets: this.secrets }), { mode: 0o600 }) }

  addMcp(spec) {
    if (!this.mcp.some(s => s.name === spec.name) && this.mcp.length >= 10) throw fail('TOO_MANY_MCP')
    this.mcp = [...this.mcp.filter(s => s.name !== spec.name), spec]
    this.#save()
  }
  removeMcp(name) {
    this.mcp = this.mcp.filter(s => s.name !== name)
    for (const key of Object.keys(this.secrets)) if (key.startsWith(`${name}.`)) delete this.secrets[key]
    this.#save()
  }
  /** Which secrets a server needs, and whether each is set (never the value). */
  secretStatus(server) {
    const names = server.transport === 'stdio' ? server.envNames : server.bearerName ? [server.bearerName] : []
    return names.map(n => ({ name: n, set: Boolean(this.secrets[`${server.name}.${n}`]) }))
  }
  setSecret(serverName, variable, value) {
    const server = this.mcp.find(s => s.name === serverName)
    if (!server || !this.secretStatus(server).some(s => s.name === variable)) throw fail('NO_SUCH_SECRET')
    const text = String(value ?? '')
    if (!text || text.length > 2000 || /[\u0000-\u001f]/.test(text)) throw fail('BAD_SECRET')
    this.secrets[`${serverName}.${variable}`] = text
    this.#save()
  }
  /** Writes the DSH overlay and returns the files and environment for the next DSH launch. */
  launchExtras() {
    const yaml = mcpPatch(this.mcp)
    const patches = []
    if (yaml) { fs.writeFileSync(this.patchFile, yaml); patches.push(this.patchFile) }
    const env = { BOBBOT_SKILLS_DIR: this.skillsDir }
    for (const server of this.mcp) {
      for (const { name } of this.secretStatus(server)) env[envKey(server.name, name)] = this.secrets[`${server.name}.${name}`] ?? ''
    }
    return { patches, env }
  }

  // ---- skills ----
  listSkills() {
    return fs.readdirSync(this.skillsDir, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(this.skillsDir, e.name, 'SKILL.md'))).map(e => {
      const text = fs.readFileSync(path.join(this.skillsDir, e.name, 'SKILL.md'), 'utf8')
      return { name: e.name, description: /^description:\s*(.+)$/m.exec(text)?.[1]?.replace(/^"|"$/g, '') ?? '' }
    })
  }
  writeSkill(skill) {
    if (!fs.existsSync(path.join(this.skillsDir, skill.name)) && this.listSkills().length >= 50) throw fail('TOO_MANY_SKILLS')
    const dir = path.join(this.skillsDir, skill.name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skill.file)
  }
  removeSkill(name) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || !fs.existsSync(path.join(this.skillsDir, name))) throw fail('NO_SUCH_SKILL')
    fs.rmSync(path.join(this.skillsDir, name), { recursive: true, force: true })
  }
}

// ---- skills ----
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_SKILL_CHARS = 40_000

/** A skill is a folder with a SKILL.md: frontmatter with a name and description, then the instructions. */
export function checkSkill({ name, description, instructions }) {
  const skillName = String(name ?? '').trim()
  if (!SKILL_NAME.test(skillName) || skillName.length > 40) throw fail('BAD_SKILL_NAME')
  const desc = String(description ?? '').replace(/\s+/g, ' ').trim()
  if (!desc || desc.length > 300) throw fail('BAD_DESCRIPTION')
  const body = String(instructions ?? '').trim()
  if (!body || body.length > 20_000) throw fail('BAD_INSTRUCTIONS')
  return { name: skillName, description: desc, body, file: `---\nname: ${skillName}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body}\n` }
}

/** For a SKILL.md fetched from a web address: it must carry its own valid frontmatter. */
export function parseSkillFile(text, fallbackName) {
  if (text.length > MAX_SKILL_CHARS) throw fail('SKILL_TOO_LARGE')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text.trim())
  if (!match) throw fail('NO_FRONTMATTER')
  const field = key => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, '')
  return checkSkill({ name: field('name') ?? fallbackName, description: field('description'), instructions: match[2] })
}
