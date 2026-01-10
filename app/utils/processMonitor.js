import { spawn } from 'child_process'
import { join } from 'path'
import log from 'electron-log/main.js'

class ProcessMonitor {
  constructor ({ app, settings }) {
    this.app = app
    this.settings = settings
    this.restartEnabled = settings.get('autoRestartOnCrash', true)
    this.restartDelay = 5000 // 5 seconds
    this.restartTimer = null
    this.isStopped = false
    this.willQuitHandler = null
  }

  start () {
    if (!this.restartEnabled) {
      log.info('Stretchly: Process monitor disabled')
      return
    }

    if (this.willQuitHandler) {
      // Already started
      return
    }

    log.info('Stretchly: Process monitor started (auto-restart enabled)')

    // Initialize isQuitting flag if not set
    if (this.app.isQuitting === undefined) {
      this.app.isQuitting = false
    }

    // Monitor for unexpected app termination
    this.willQuitHandler = (event) => {
      // Don't do anything if already stopped or if this is a graceful quit
      if (this.isStopped || this.app.isQuitting || !this.restartEnabled) {
        return
      }

      log.info('Stretchly: Detected unexpected quit, will restart')
      event.preventDefault()
      this.scheduleRestart()
    }

    this.app.on('will-quit', this.willQuitHandler)

    // Also monitor process exit for crashes
    process.on('exit', (code) => {
      if (code !== 0 && this.restartEnabled && !this.app.isQuitting && !this.isStopped) {
        log.warn(`Stretchly: Process exited with code ${code}, scheduling restart`)
        // Note: We can't prevent exit here, but we can spawn a new process
        // This will be handled by a wrapper script or system service in production
      }
    })
  }

  scheduleRestart () {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
    }

    log.info(`Stretchly: Scheduling restart in ${this.restartDelay / 1000} seconds...`)
    this.restartTimer = setTimeout(() => {
      this.restart()
    }, this.restartDelay)
  }

  restart () {
    // Mark as stopped to prevent loops
    this.isStopped = true

    // Remove event listener before restarting
    if (this.willQuitHandler) {
      this.app.removeListener('will-quit', this.willQuitHandler)
      this.willQuitHandler = null
    }

    log.info('Stretchly: Restarting application...')

    // Get the path to restart
    const isPackaged = this.app.isPackaged

    let executablePath
    let args = []

    if (isPackaged) {
      // In packaged app, use the app executable
      executablePath = process.execPath
    } else {
      // In development, use electron from node_modules
      const appPath = this.app.getAppPath()
      executablePath = join(appPath, 'node_modules', '.bin', 'electron')
      args = [appPath]
    }

    // Spawn new process
    try {
      const child = spawn(executablePath, args, {
        detached: true,
        stdio: 'ignore'
      })

      child.unref()
      log.info('Stretchly: New process spawned, exiting current instance')
    } catch (error) {
      log.error('Stretchly: Failed to restart application:', error)
    }

    // Exit current process after a short delay
    // Set isQuitting to prevent will-quit handler from firing
    this.app.isQuitting = true
    setTimeout(() => {
      this.app.exit(0)
    }, 1000)
  }

  stop () {
    if (this.isStopped) {
      return // Already stopped, prevent multiple calls
    }

    this.isStopped = true

    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }

    // Remove the event listener to prevent loops
    if (this.willQuitHandler) {
      this.app.removeListener('will-quit', this.willQuitHandler)
      this.willQuitHandler = null
    }

    log.info('Stretchly: Process monitor stopped')
  }
}

export default ProcessMonitor
