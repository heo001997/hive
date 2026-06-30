import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  createWriteStream,
  type WriteStream
} from 'fs'
import { getHiveLogsDir } from './hive-paths'

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

interface LogEntry {
  timestamp: string
  level: string
  component: string
  message: string
  data?: Record<string, unknown>
  error?: {
    name: string
    message: string
    stack?: string
  }
}

interface LoggerOptions {
  component: string
  minLevel?: LogLevel
}

const LOG_LEVELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR'
}

// Configuration
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const MAX_LOG_FILES = 5

export class LoggerService {
  private static instance: LoggerService | null = null
  private logDir: string
  private currentLogFile: string
  private minLevel: LogLevel
  // The day (YYYY-MM-DD) and rotation index that `currentLogFile` encodes. Index 0
  // is `hive-<date>.log`; after a size-based rotation we move to `hive-<date>.1.log`,
  // `.2.log`, … — we open a fresh file rather than renaming the live one (renaming a
  // file with an open async stream races the not-yet-flushed buffer).
  private currentDate: string
  private rotationIndex = 0
  // Async file sink (a WriteStream) so logging never blocks the main event loop.
  // appendFileSync on the hot path stalls IPC/PTY delivery and shows up as
  // terminal lag — every log line was a synchronous disk write.
  private stream: WriteStream | null = null
  private streamPath: string | null = null
  // Bytes written to the current file, tracked in-memory so rotation doesn't need
  // a statSync syscall per log line.
  private currentBytes = 0
  // Once a console sink (stdout/stderr) has thrown EPIPE/EIO it stays broken;
  // writing to it again only re-triggers the failure (the feedback loop that
  // produced a 1GB/day log). Latch it off permanently for this process.
  private consoleBroken = false

  private constructor() {
    // Use ~/.hive/logs/ for logs (relocatable via HIVE_DATA_DIR for `pnpm dev`)
    this.logDir = getHiveLogsDir()
    this.ensureLogDir()
    this.currentDate = LoggerService.today()
    this.currentLogFile = this.logFileFor(this.currentDate, this.rotationIndex)
    this.minLevel = process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO
    this.cleanOldLogs()
  }

  /**
   * Stop routing log lines to the console. Called when stdout/stderr emit
   * EPIPE/EIO (their reader died): further console writes would just re-throw and,
   * via the uncaughtException handler, re-enter the logger forever.
   */
  disableConsole(): void {
    this.consoleBroken = true
  }

  static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService()
    }
    return LoggerService.instance
  }

  private ensureLogDir(): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true })
    }
  }

  private static today(): string {
    return new Date().toISOString().split('T')[0]
  }

  /** Path for a given day + rotation index. Index 0 keeps the original name. */
  private logFileFor(date: string, index: number): string {
    const suffix = index > 0 ? `.${index}` : ''
    return join(this.logDir, `hive-${date}${suffix}.log`)
  }

  private formatEntry(entry: LogEntry): string {
    // Multiple Hive processes (app, dev builds, desktop backend) append to the
    // same log file — the pid is what makes lines attributable to a process
    const parts = [
      `[${entry.timestamp}]`,
      `[pid:${process.pid}]`,
      `[${entry.level}]`,
      `[${entry.component}]`,
      entry.message
    ]

    if (entry.data) {
      parts.push(JSON.stringify(entry.data))
    }

    if (entry.error) {
      parts.push(`\n  Error: ${entry.error.name}: ${entry.error.message}`)
      if (entry.error.stack) {
        parts.push(`\n  Stack: ${entry.error.stack}`)
      }
    }

    return parts.join(' ') + '\n'
  }

  /**
   * Return (opening if needed) the write stream for the current log file. Switches
   * files when the date rolls. Seeds the in-memory byte counter from the file's
   * size on open so rotation accounts for pre-existing content. Returns null if a
   * stream can't be created (caller falls back to a best-effort sync append).
   */
  private getStream(): WriteStream | null {
    // Date roll (new day) → reset to index 0 of the new day → drop the old stream.
    const today = LoggerService.today()
    if (today !== this.currentDate) {
      this.currentDate = today
      this.rotationIndex = 0
      this.currentLogFile = this.logFileFor(today, 0)
      this.closeStream()
    }
    if (this.stream && this.streamPath === this.currentLogFile) return this.stream
    try {
      let startSize = 0
      try {
        startSize = statSync(this.currentLogFile).size
      } catch {
        // file doesn't exist yet → starts empty
      }
      const stream = createWriteStream(this.currentLogFile, { flags: 'a' })
      // A failing log file must never crash the process or bubble to
      // uncaughtException — swallow stream errors.
      stream.on('error', () => {})
      this.stream = stream
      this.streamPath = this.currentLogFile
      this.currentBytes = startSize
      return stream
    } catch {
      return null
    }
  }

  private closeStream(): void {
    if (this.stream) {
      try {
        this.stream.end()
      } catch {
        // ignore
      }
    }
    this.stream = null
    this.streamPath = null
  }

  /**
   * Size-based rotation: leave the full file as-is and advance to the next free
   * `hive-<date>.<n>.log`, where subsequent lines are written. We deliberately do
   * NOT rename the full file — it has an open async stream whose buffered tail is
   * still draining, and renaming the path out from under it races that flush
   * (which silently dropped rotation in testing). Opening a brand-new file for the
   * next slot is race-free. The previous implementation only re-derived the
   * date-based name, so within a single day it never rotated — unbounded growth.
   */
  private rotateLog(): void {
    this.closeStream()
    // Advance to the next index whose file does not yet exist (skips slots a
    // crashed/earlier same-day process may already hold).
    do {
      this.rotationIndex += 1
    } while (existsSync(this.logFileFor(this.currentDate, this.rotationIndex)))
    this.currentLogFile = this.logFileFor(this.currentDate, this.rotationIndex)
    this.currentBytes = 0
    this.cleanOldLogs()
  }

  /** Append one formatted line to the log file via the async stream. */
  private appendToFile(formatted: string): void {
    const stream = this.getStream()
    if (!stream) {
      try {
        appendFileSync(this.currentLogFile, formatted)
      } catch {
        // last resort: drop the line rather than throw on the logging path
      }
      return
    }
    stream.write(formatted)
    this.currentBytes += Buffer.byteLength(formatted)
    if (this.currentBytes >= MAX_LOG_FILE_SIZE) {
      this.rotateLog()
    }
  }

  private cleanOldLogs(): void {
    try {
      const files = readdirSync(this.logDir)
        .filter((f) => f.startsWith('hive-') && f.endsWith('.log'))
        .map((f) => ({
          name: f,
          path: join(this.logDir, f),
          mtime: statSync(join(this.logDir, f)).mtime
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

      // Keep only MAX_LOG_FILES most recent files
      if (files.length > MAX_LOG_FILES) {
        files.slice(MAX_LOG_FILES).forEach((file) => {
          try {
            unlinkSync(file.path)
          } catch {
            // Ignore deletion errors
          }
        })
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  private write(
    level: LogLevel,
    component: string,
    message: string,
    data?: Record<string, unknown>,
    error?: Error
  ): void {
    if (level < this.minLevel) return

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LOG_LEVELS[level],
      component,
      message,
      data
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    }

    const formatted = this.formatEntry(entry)

    // Write to file (async stream — never blocks the main event loop).
    this.appendToFile(formatted)

    // Also log to console in development — but only while the console sink is
    // alive. A write to a broken stdout/stderr throws EPIPE/EIO asynchronously,
    // which the uncaughtException handler would route back here; latching
    // consoleBroken off (see disableConsole) breaks that feedback loop.
    if (process.env.NODE_ENV === 'development' && !this.consoleBroken) {
      const consoleMethod =
        level === LogLevel.ERROR
          ? console.error
          : level === LogLevel.WARN
            ? console.warn
            : level === LogLevel.DEBUG
              ? console.debug
              : console.log
      try {
        consoleMethod(`[${entry.level}] [${component}]`, message, data || '', error || '')
      } catch (err) {
        // Synchronous console failure (e.g. EPIPE/EIO on the sink) → stop using it.
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'EPIPE' || code === 'EIO') this.consoleBroken = true
      }
    }
  }

  debug(component: string, message: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.DEBUG, component, message, data)
  }

  info(component: string, message: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.INFO, component, message, data)
  }

  warn(component: string, message: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.WARN, component, message, data)
  }

  error(component: string, message: string, error?: Error, data?: Record<string, unknown>): void {
    this.write(LogLevel.ERROR, component, message, data, error)
  }

  getLogDir(): string {
    return this.logDir
  }
}

// Create a logger instance for a specific component
export function createLogger(options: LoggerOptions): {
  debug: (message: string, data?: Record<string, unknown>) => void
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, error?: Error, data?: Record<string, unknown>) => void
} {
  const component = options.component

  return {
    debug: (message: string, data?: Record<string, unknown>) =>
      LoggerService.getInstance().debug(component, message, data),
    info: (message: string, data?: Record<string, unknown>) =>
      LoggerService.getInstance().info(component, message, data),
    warn: (message: string, data?: Record<string, unknown>) =>
      LoggerService.getInstance().warn(component, message, data),
    error: (message: string, error?: Error, data?: Record<string, unknown>) =>
      LoggerService.getInstance().error(component, message, error, data)
  }
}

// Export a lazy singleton facade so importing this module does not touch Electron app APIs.
export const logger = {
  debug: (component: string, message: string, data?: Record<string, unknown>): void =>
    LoggerService.getInstance().debug(component, message, data),
  info: (component: string, message: string, data?: Record<string, unknown>): void =>
    LoggerService.getInstance().info(component, message, data),
  warn: (component: string, message: string, data?: Record<string, unknown>): void =>
    LoggerService.getInstance().warn(component, message, data),
  error: (component: string, message: string, error?: Error, data?: Record<string, unknown>): void =>
    LoggerService.getInstance().error(component, message, error, data),
  getLogDir: (): string => LoggerService.getInstance().getLogDir()
}

// Export function to get log directory (for IPC)
export function getLogDir(): string {
  return logger.getLogDir()
}
