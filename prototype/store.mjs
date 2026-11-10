// Saving state safely. A crash or power cut during a plain write leaves a cut-off file, and the loaders then
// start empty, which silently loses every job and chat. Writing beside the file and renaming cannot leave half a file.
import fs from 'node:fs'

export function writeAtomic(file, text, mode = 0o600) {
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, text, { mode })
  fs.renameSync(temp, file)
}

/** For files that change on every chat event: keeps only the newest content and writes it shortly after. */
export class WriteBehind {
  #waiting = new Map()
  #timer = null
  constructor(delayMs = 250) { this.delayMs = delayMs }

  later(file, content) {
    this.#waiting.set(file, content)
    this.#timer ??= setTimeout(() => this.flush(), this.delayMs)
  }

  /** A deleted chat must not be written back by a save that was still waiting. */
  cancel(file) { this.#waiting.delete(file) }

  flush() {
    clearTimeout(this.#timer)
    this.#timer = null
    for (const [file, content] of this.#waiting) {
      try { writeAtomic(file, content()) } catch (error) { console.error(`[bobbot] could not save ${file}: ${error.message}`) }
    }
    this.#waiting.clear()
  }
}
