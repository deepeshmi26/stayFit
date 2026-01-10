import { exec } from 'node:child_process'
import { promisify } from 'util'
import { join } from 'path'
import { BrowserWindow, ipcMain, globalShortcut } from 'electron'
import log from 'electron-log/main.js'

const execAsync = promisify(exec)

/**
 * Check if Chrome is running and get its window positions
 * Returns array of Chrome window bounds: [{x, y, width, height}, ...]
 */
export async function getChromeWindows () {
  if (process.platform !== 'darwin') {
    // For non-macOS, return empty array (feature only works on macOS)
    return []
  }

  try {
    // Use AppleScript to access Chrome directly (more reliable than System Events)
    // Chrome's bounds format is {left, top, right, bottom}
    const script = `
      tell application "System Events"
        if not (exists process "Google Chrome") and not (exists process "Chromium") then
          return ""
        end if
      end tell
      try
        tell application "Google Chrome"
          set windowList to {}
          repeat with w in windows
            try
              if visible of w then
                set windowBounds to bounds of w
                -- bounds format: {left, top, right, bottom}
                -- convert to: {x, y, width, height}
                set x to item 1 of windowBounds
                set y to item 2 of windowBounds
                set width to (item 3 of windowBounds) - x
                set height to (item 4 of windowBounds) - y
                set end of windowList to {x, y, width, height}
              end if
            end try
          end repeat
          return windowList
        end tell
      on error
        try
          tell application "Chromium"
            set windowList to {}
            repeat with w in windows
              try
                if visible of w then
                  set windowBounds to bounds of w
                  set x to item 1 of windowBounds
                  set y to item 2 of windowBounds
                  set width to (item 3 of windowBounds) - x
                  set height to (item 4 of windowBounds) - y
                  set end of windowList to {x, y, width, height}
                end if
              end try
            end repeat
            return windowList
          end tell
        on error errMsg
          return ""
        end try
      end try
    `
    const { stdout } = await execAsync(`osascript -e '${script}'`)

    if (!stdout || stdout.trim() === '') {
      log.debug('Stretchly: Chrome is not running or has no visible windows')
      return []
    }

    // Parse AppleScript output: comma-separated list "x1, y1, w1, h1, x2, y2, w2, h2, ..."
    const windows = []
    const numbers = stdout.trim().split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))

    // Each window has 4 values: x, y, width, height
    for (let i = 0; i < numbers.length; i += 4) {
      if (i + 3 < numbers.length) {
        windows.push({
          x: numbers[i],
          y: numbers[i + 1],
          width: numbers[i + 2],
          height: numbers[i + 3]
        })
      }
    }

    if (windows.length === 0) {
      log.debug('Stretchly: Chrome windows found but could not parse positions')
      log.debug(`Stretchly: Raw output: ${stdout}`)
    } else {
      log.info(`Stretchly: Detected ${windows.length} visible Chrome window(s)`)
    }

    return windows
  } catch (error) {
    log.warn('Stretchly: Could not detect Chrome windows:', error.message)
    return []
  }
}

/**
 * Check if Chrome is the active/frontmost application
 */
export async function isChromeActive () {
  if (process.platform !== 'darwin') {
    return false
  }

  try {
    const { stdout } = await execAsync(
      'osascript -e \'tell application "System Events" to get name of first application process whose frontmost is true\''
    )
    const appName = stdout.trim().toLowerCase()
    return appName.includes('chrome') || appName.includes('chromium')
  } catch (error) {
    log.warn('Stretchly: Could not check active application:', error.message)
    return false
  }
}

/**
 * Create Chrome monitoring function
 * Returns an object with start() and stop() methods
 */
export function createChromeMonitor ({ breakType, getWins, setWins, createChromeOverlayWindows }) {
  let timer = null

  return {
    start () {
      if (process.platform !== 'darwin') {
        return // Only works on macOS
      }

      this.stop()

      log.info(`Stretchly: Starting Chrome monitoring for ${breakType} break`)

      timer = setInterval(async () => {
        const wins = getWins()
        const chromeActive = await isChromeActive()
        const chromeWindows = await getChromeWindows()

        // Clean up destroyed windows from array
        if (wins && wins.length > 0) {
          const validWins = wins.filter(win => win && !win.isDestroyed())
          setWins(validWins)
        }

        const validWins = getWins()

        // If overlay windows exist, check if Chrome is still active
        if (validWins && validWins.length > 0) {
          // Overlay exists - check if Chrome is still active
          if (!chromeActive || chromeWindows.length === 0) {
            // Chrome closed or became inactive - hide overlay
            log.info(`Stretchly: Chrome is no longer active, hiding ${breakType} break overlay`)
            for (const win of validWins) {
              if (win && !win.isDestroyed()) {
                win.hide()
              }
            }
            return // Keep monitoring to show again when Chrome becomes active
          }

          // Chrome is active - check if overlay is visible
          const isVisible = validWins.some(win => win && !win.isDestroyed() && win.isVisible())

          // If overlay was hidden and Chrome is now active, show it again
          if (!isVisible && chromeActive && chromeWindows.length > 0) {
            log.info(`Stretchly: Chrome is active again, showing ${breakType} break overlay`)
            // Recreate overlay to match current Chrome windows
            for (const win of validWins) {
              if (win && !win.isDestroyed()) {
                win.hide()
                win.destroy()
              }
            }
            setWins([])
            await createChromeOverlayWindows(breakType, chromeWindows, false)
            return
          }

          // Chrome is active and overlay is visible - update overlay positions if windows moved
          if (chromeWindows.length === validWins.length) {
            for (let i = 0; i < chromeWindows.length && i < validWins.length; i++) {
              const win = validWins[i]
              const chromeWindow = chromeWindows[i]
              if (win && !win.isDestroyed()) {
                const [currentX, currentY] = win.getPosition()
                const [currentWidth, currentHeight] = win.getSize()
                // Update position and size if Chrome window changed
                if (currentX !== chromeWindow.x || currentY !== chromeWindow.y ||
                                    currentWidth !== chromeWindow.width || currentHeight !== chromeWindow.height) {
                  win.setPosition(chromeWindow.x, chromeWindow.y)
                  win.setSize(chromeWindow.width, chromeWindow.height)
                  log.debug(`Stretchly: Updated overlay window ${i + 1} position/size`)
                }
                // Make sure overlay is visible
                if (!win.isVisible()) {
                  win.showInactive()
                }
              }
            }
          } else {
            // Number of Chrome windows changed - recreate overlays
            log.info(`Stretchly: Chrome window count changed, recreating ${breakType} break overlay`)
            for (const win of validWins) {
              if (win && !win.isDestroyed()) {
                win.hide()
                win.destroy()
              }
            }
            setWins([])
            await createChromeOverlayWindows(breakType, chromeWindows, false)
          }
          return
        }

        // No overlay windows exist - check if Chrome is now active
        if (!chromeActive || chromeWindows.length === 0) {
          return // Chrome not active yet, keep monitoring
        }

        // Chrome is now active and no overlay exists! Create overlay
        log.info(`Stretchly: Chrome became active during ${breakType} break, showing overlay`)
        await createChromeOverlayWindows(breakType, chromeWindows, false)
      }, 1000) // Check every second
    },

    stop () {
      if (timer) {
        clearInterval(timer)
        timer = null
        log.info('Stretchly: Stopped Chrome monitoring')
      }
    }
  }
}

/**
 * Create Chrome overlay windows for an active break
 */
export async function createChromeOverlayWindows ({
  breakType,
  chromeWindows,
  isInitialStart,
  microbreakWins,
  breakWins,
  settings,
  breakPlanner,
  windowIconPath,
  getBlurredBackgroundWindowOptions,
  calculateBackgroundColor,
  microbreakIdeas,
  breakIdeas,
  finishMicrobreak,
  finishBreak,
  postponeMicrobreak,
  postponeBreak,
  canPostpone,
  canSkip,
  updateTray
}) {
  const isMini = breakType === 'mini'

  // Clear existing windows array
  if (isMini) {
    microbreakWins.length = 0
  } else {
    breakWins.length = 0
  }

  const breakDuration = isMini ? settings.get('microbreakDuration') : settings.get('breakDuration')
  const strictMode = isMini ? settings.get('microbreakStrictMode') : settings.get('breakStrictMode')
  const postponesLimit = isMini ? settings.get('microbreakPostponesLimit') : settings.get('breakPostponesLimit')
  const postponableDurationPercent = isMini ? settings.get('microbreakPostponableDurationPercent') : settings.get('breakPostponableDurationPercent')
  const postponable = isMini
    ? (settings.get('microbreakPostpone') && breakPlanner.postponesNumber < postponesLimit && postponesLimit > 0)
    : (settings.get('breakPostpone') && breakPlanner.postponesNumber < postponesLimit && postponesLimit > 0)
  const showBreaksAsRegularWindows = settings.get('showBreaksAsRegularWindows')
  const modalPath = isMini
    ? 'file://' + join(__dirname, '../microbreak.html')
    : 'file://' + join(__dirname, '../break.html')
  const backgroundColor = isMini
    ? calculateBackgroundColor(settings.get('miniBreakColor'))
    : calculateBackgroundColor(settings.get('mainColor'))
  const preloadPath = isMini
    ? join(__dirname, '../microbreak-preload.mjs')
    : join(__dirname, '../break-preload.mjs')
  const loadedEvent = isMini ? 'mini-break-loaded' : 'long-break-loaded'
  const startEvent = isMini ? 'microbreakStarted' : 'breakStarted'

  // Get idea - use default since nextIdea may have been consumed
  const idea = isMini
    ? (settings.get('ideas') ? microbreakIdeas.randomElement : [''])
    : (settings.get('ideas') ? breakIdeas.randomElement : ['', ''])

  // Re-register IPC handlers (remove existing first to avoid duplicate registration)
  if (isMini) {
    ipcMain.removeHandler('send-mini-break-data')
    ipcMain.handle('send-mini-break-data', (event) => {
      const startTime = Date.now()
      const shortcut = settings.get('endBreakShortcut')
      if (shortcut) {
        globalShortcut.register(shortcut, () => {
          const passedPercent = (Date.now() - startTime) / breakDuration * 100
          if (passedPercent >= 100) {
            finishMicrobreak(false)
            return
          }
          if (canPostpone(postponable, passedPercent, postponableDurationPercent)) {
            postponeMicrobreak()
          } else if (canSkip(strictMode, postponable, passedPercent, postponableDurationPercent)) {
            finishMicrobreak(false)
          }
        })
      }
      return [idea, startTime, breakDuration, strictMode,
        postponable, postponableDurationPercent, backgroundColor]
    })
  } else {
    ipcMain.removeHandler('send-long-break-data')
    ipcMain.handle('send-long-break-data', (event) => {
      const startTime = Date.now()
      const shortcut = settings.get('endBreakShortcut')
      if (shortcut) {
        globalShortcut.register(shortcut, () => {
          const passedPercent = (Date.now() - startTime) / breakDuration * 100
          if (passedPercent >= 100) {
            finishBreak(false)
            return
          }
          if (canPostpone(postponable, passedPercent, postponableDurationPercent)) {
            postponeBreak()
          } else if (canSkip(strictMode, postponable, passedPercent, postponableDurationPercent)) {
            finishBreak(false)
          }
        })
      }
      return [idea, startTime, breakDuration, strictMode,
        postponable, postponableDurationPercent, backgroundColor]
    })
  }

  // Create overlay windows for each Chrome window
  for (let i = 0; i < chromeWindows.length; i++) {
    const chromeWindow = chromeWindows[i]
    const windowOptions = {
      width: chromeWindow.width,
      height: chromeWindow.height,
      x: chromeWindow.x,
      y: chromeWindow.y,
      autoHideMenuBar: true,
      icon: windowIconPath(),
      resizable: false,
      frame: false,
      show: false,
      backgroundThrottling: false,
      transparent: true,
      ...getBlurredBackgroundWindowOptions(),
      backgroundColor,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      title: 'Stretchly',
      titleBarStyle: 'hidden',
      titleBarOverlay: true,
      webPreferences: {
        preload: preloadPath,
        sandbox: false
      }
    }

    let breakWinLocal = new BrowserWindow(windowOptions)
    breakWinLocal.setSize(windowOptions.width, windowOptions.height)

    breakWinLocal.once('ready-to-show', () => {
      log.info('Stretchly: ready-to-show fired')
    })

    ipcMain.once(loadedEvent, () => {
      log.info(`Stretchly: ${breakType} break window loaded`)
      if (showBreaksAsRegularWindows) {
        breakWinLocal.show()
      } else {
        breakWinLocal.showInactive()
      }

      log.info(`Stretchly: showing Chrome overlay window ${i + 1} of ${chromeWindows.length}`)
      if (process.platform === 'darwin') {
        breakWinLocal.setMinimizable(false)
        breakWinLocal.setClosable(false)
        breakWinLocal.setFullScreen(false)
        breakWinLocal.setKiosk(false)
      }
      if (i === 0) {
        // Only emit start event if this is the initial break start, not when recreating windows
        if (isInitialStart) {
          breakPlanner.emit(startEvent, true)
          log.info(`Stretchly: starting ${breakType} break over Chrome`)
        } else {
          log.info(`Stretchly: recreating ${breakType} break overlay over Chrome (break already running)`)
        }
      }
      updateTray()
    })

    breakWinLocal.loadURL(modalPath)
    breakWinLocal.setVisibleOnAllWorkspaces(true)
    breakWinLocal.setAlwaysOnTop(true, 'pop-up-menu')
    if (breakWinLocal) {
      breakWinLocal.on('close', (e) => {
        const currentStrictMode = isMini ? settings.get('microbreakStrictMode') : settings.get('breakStrictMode')
        if (breakPlanner.scheduler.timeLeft > 0 && currentStrictMode) {
          log.info('Stretchly: preventing closing break window as in strict mode')
          e.preventDefault()
        }
      })
      breakWinLocal.once('closed', () => {
        breakWinLocal = null
      })
    }
    if (isMini) {
      microbreakWins.push(breakWinLocal)
    } else {
      breakWins.push(breakWinLocal)
    }
  }
}
