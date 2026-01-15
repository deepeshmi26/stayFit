import { log } from 'console'
import { app, BrowserWindow, globalShortcut, ipcMain, nativeTheme, powerMonitor } from 'electron'
import i18next from 'i18next'
import { join } from 'path'
import BreaksPlanner from './breaksPlanner.js'
import { loadIdeas } from './utils/appLifecycle.js'
import { breakComplete, enterManualAwaitPhase } from './utils/breakManager.js'
import { getChromeWindows } from './utils/chromeOverlay.js'
import { getSettings } from './utils/settings.js'
import { windowIconPath } from './utils/trayManager.js'
import { canPostpone, canSkip } from './utils/utils.js'
import { closeWindows, getBlurredBackgroundWindowOptions } from './utils/windowManager.js'

class BreakControl {
  settings = null
  breakPlanner = null
  nextIdea = null
  processWin = null
  microbreakWins = []
  breakWins = []
  microbreakIdeas
  breakIdeas
  pausedForSuspendOrLock = false
  updateTray = null // TODO: This update tray function should not be passed. Right now it has been passed as the code is intertwined
  constructor (processWin, updateTray) {
    this.processWin = processWin
    this.updateTray = updateTray
    this.microbreakWins = []
    this.breakWins = []
    this.pausedForSuspendOrLock = false
    this.settings = getSettings()
    this.breakPlanner = new BreaksPlanner()
    i18next.on('languageChanged', () => {
      const ideas = loadIdeas({ settings: this.settings, i18next })
      this.breakIdeas = ideas.breakIdeas
      this.microbreakIdeas = ideas.microbreakIdeas
    })

    this.breakPlanner.nextBreak()
    this.breakPlanner.on('startMicrobreakNotification', () => { this.startMicrobreakNotification() })
    this.breakPlanner.on('startBreakNotification', () => { this.startBreakNotification() })
    this.breakPlanner.on('startMicrobreak', () => { this.startMicrobreak() })
    this.breakPlanner.on('startBreak', () => { this.startBreak() })
    this.breakPlanner.on('finishMicrobreak', (shouldPlaySound, shouldPlanNext) => {
      if (this.settings.get('miniBreakManualFinish')) {
        enterManualAwaitPhase({ type: 'mini', shouldPlaySound, microbreakWins: this.microbreakWins, breakWins: this.breakWins, settings: this.settings, processWin: this.processWin })
        return
      }
      this.finishMicrobreak(shouldPlaySound, shouldPlanNext)
    })
    this.breakPlanner.on('finishBreak', (shouldPlaySound, shouldPlanNext) => {
      if (this.settings.get('longBreakManualFinish')) {
        enterManualAwaitPhase({ type: 'long', shouldPlaySound, microbreakWins: this.microbreakWins, breakWins: this.breakWins, settings: this.settings, processWin: this.processWin })
        return
      }
      this.finishBreak(shouldPlaySound, shouldPlanNext)
    })
    this.breakPlanner.on('postponeMicrobreak', () => { this.postponeMicrobreak() })
    this.breakPlanner.on('postponeBreak', () => { this.postponeBreak() })
    this.breakPlanner.on('skipToMicrobreak', (delay) => { this.skipToMicrobreak(delay) })
    this.breakPlanner.on('skipToBreak', (delay) => { this.skipToBreak(delay) })
    this.breakPlanner.on('resetBreaks', () => { this.resetBreaks() })
    this.breakPlanner.on('pauseBreaks', (milliseconds) => { this.pauseBreaks(milliseconds) })
    this.breakPlanner.on('resumeBreaks', () => { this.resumeBreaks() })
    this.breakPlanner.on('updateToolTip', () => { updateTray() })
    powerMonitor.on('suspend', () => this.onSuspendOrLock())
    powerMonitor.on('lock-screen', () => this.onSuspendOrLock())
    powerMonitor.on('resume', () => this.onResumeOrUnlock())
    powerMonitor.on('unlock-screen', () => this.onResumeOrUnlock())
  }

  onSuspendOrLock = () => {
    log.info('System: suspend or lock')
    if (this.settings.get('pauseForSuspendOrLock')) {
      if (this.breakPlanner.isPaused || this.breakPlanner.dndManager.isOnDnd ||
                this.breakPlanner.naturalBreaksManager.isSchedulerCleared ||
                this.breakPlanner.appExclusionsManager.isSchedulerCleared) {
        log.info('Stretchly: not pausing for suspendOrLock because paused already')
      } else {
        this.pausedForSuspendOrLock = true
        this.pauseBreaks(1)
        this.updateTray()
      }
    } else {
      log.info('Stretchly: not pausing for suspendOrLock because setting is disabled')
    }
  }

  onResumeOrUnlock = () => {
    log.info('System: resume or unlock')
    if (this.pausedForSuspendOrLock) {
      this.pausedForSuspendOrLock = false
      this.resumeBreaks(false)
    } else {
      // corrrect the planner for the time spent in suspend
      this.breakPlanner.correctScheduler()
    }
    this.updateTray()
  }

  startMicrobreak = async () => {
    if (this.microbreakWins?.length > 0) {
      log.warn('Stretchly: Mini break already running, not starting Mini break')
      return
    }
    const chromeWindows = await getChromeWindows()

    if (chromeWindows.length > 0) {
      this.createChromeOverlayWindows('mini', chromeWindows)
    } else {
      log.info('Stretchly: No chrome windows detected')
      log.info('Stretchly: Chrome is not active, waiting for Chrome to become active before showing break')
      // Still emit the break started event so the timer runs
      // Start monitoring for Chrome activation
      // startChromeMonitoring('mini')
    }
    this.breakPlanner.emit('microbreakStarted', true)

    if (process.platform === 'darwin') {
      if (app.dock.isVisible) {
        app.dock.hide()
      }
    }
  }

  startBreak = async () => {
    if (this.breakWins?.length > 0) {
      log.warn('Stretchly: Long break already running, not starting Long break')
      return
    }
    const chromeWindows = await getChromeWindows()
    if (chromeWindows.length > 0) {
      this.createChromeOverlayWindows('long', chromeWindows)
    } else {
      log.info('Stretchly: No chrome windows detected')
      log.info('Stretchly: Chrome is not active, waiting for Chrome to become active before showing break')
      // Still emit the break started event so the timer runs
      // Start monitoring for Chrome activation
      // startChromeMonitoring('long')
    }
    this.breakPlanner.emit('breakStarted', true)

    if (process.platform === 'darwin') {
      if (app.dock.isVisible) {
        app.dock.hide()
      }
    }
  }

  createChromeOverlayWindows = (type, chromeWindows) => {
    if (chromeWindows.length === 0) {
      log.info('Stretchly: No chrome windows detected')
      return
    }
    const isMini = type === 'mini'

    const breakDuration = isMini ? this.settings.get('microbreakDuration') : this.settings.get('breakDuration')
    const strictMode = isMini ? this.settings.get('microbreakStrictMode') : this.settings.get('breakStrictMode')
    const postponesLimit = isMini ? this.settings.get('microbreakPostponesLimit') : this.settings.get('breakPostponesLimit')
    const postponableDurationPercent = isMini ? this.settings.get('microbreakPostponableDurationPercent') : this.settings.get('breakPostponableDurationPercent')
    const postponable = (isMini ? this.settings.get('microbreakPostpone') : this.settings.get('breakPostpone')) && this.breakPlanner.postponesNumber < postponesLimit && postponesLimit > 0
    const showBreaksAsRegularWindows = this.settings.get('showBreaksAsRegularWindows')
    const modalPath = isMini ? 'file://' + join(__dirname, '/microbreak.html') : 'file://' + join(__dirname, '/break.html')
    const backgroundColor = isMini ? this.calculateBackgroundColor(this.settings.get('miniBreakColor')) : this.calculateBackgroundColor(this.settings.get('mainColor'))
    const preloadPath = isMini
      ? join(__dirname, '/microbreak-preload.mjs')
      : join(__dirname, '/break-preload.mjs')
    const loadedEvent = isMini ? 'mini-break-loaded' : 'long-break-loaded'
    const idea = this.nextIdea || (isMini
      ? (this.settings.get('ideas') ? this.microbreakIdeas.randomElement : [''])
      : (this.settings.get('ideas') ? this.breakIdeas.randomElement : ['', '']))
    this.nextIdea = null

    if (!this.settings.get('silentNotifications')) {
      const sound = this.settings.get(type === 'mini' ? 'miniBreakStartSound' : 'longBreakStartSound')
      if (sound !== 'silence') {
        this.processWin.webContents.send('play-sound', sound, this.settings.get('volume'))
      }
    }

    if (isMini) {
      ipcMain.removeHandler('send-mini-break-data')
      ipcMain.handle('send-mini-break-data', (event) => {
        const startTime = Date.now()
        const shortcut = this.settings.get('endBreakShortcut')
        if (shortcut) {
          globalShortcut.register(shortcut, () => {
            const passedPercent = (Date.now() - startTime) / breakDuration * 100
            if (passedPercent >= 100) {
              this.finishMicrobreak(false)
              return
            }
            if (canPostpone(postponable, passedPercent, postponableDurationPercent)) {
              this.postponeMicrobreak()
            } else if (canSkip(strictMode, postponable, passedPercent, postponableDurationPercent)) {
              this.finishMicrobreak(false)
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
        const shortcut = this.settings.get('endBreakShortcut')
        if (shortcut) {
          globalShortcut.register(shortcut, () => {
            const passedPercent = (Date.now() - startTime) / breakDuration * 100
            if (passedPercent >= 100) {
              this.finishBreak(false)
              return
            }
            if (canPostpone(postponable, passedPercent, postponableDurationPercent)) {
              this.postponeBreak()
            } else if (canSkip(strictMode, postponable, passedPercent, postponableDurationPercent)) {
              this.finishBreak(false)
            }
          })
        }
        return [idea, startTime, breakDuration, strictMode,
          postponable, postponableDurationPercent, backgroundColor]
      })
    }

    for (let i = 0; i < chromeWindows.length; i++) {
      const chromeWindow = chromeWindows[i]
      const windowOptions = {
        width: chromeWindow.width,
        height: chromeWindow.height,
        x: chromeWindow.x,
        y: chromeWindow.y,
        autoHideMenuBar: true,
        icon: windowIconPath({ settings: this.settings, nativeTheme, __dirname }),
        resizable: false,
        frame: false,
        show: false,
        backgroundThrottling: false,
        transparent: true,
        ...getBlurredBackgroundWindowOptions(this.settings),
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
        log.info(`Stretchly: ${type} break window loaded`)
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
        this.updateTray()
      })
      breakWinLocal.loadURL(modalPath)
      breakWinLocal.setVisibleOnAllWorkspaces(false)
      breakWinLocal.setAlwaysOnTop(true, 'pop-up-menu')
      if (breakWinLocal) {
        breakWinLocal.on('close', (e) => {
          if (this.breakPlanner.scheduler.timeLeft > 0 && this.settings.get(type === 'mini' ? 'microbreakStrictMode' : 'breakStrictMode')) {
            log.info('Stretchly: preventing closing break window as in strict mode')
            e.preventDefault()
          }
        })
        breakWinLocal.once('closed', () => {
          breakWinLocal = null
        })
      }
      type === 'mini' ? this.microbreakWins.push(breakWinLocal) : this.breakWins.push(breakWinLocal)
    }
  }

  calculateBackgroundColor (color) {
    let opacityMultiplier = 1
    if (this.settings.get('transparentMode')) {
      opacityMultiplier = this.settings.get('opacity')
    }
    return color + Math.round(opacityMultiplier * 255).toString(16).padStart(2, '0')
  }

  finishMicrobreak = (shouldPlaySound = true, shouldPlanNext = true) => {
    breakComplete({ shouldPlaySound, windows: this.microbreakWins, breakType: 'mini', settings: this.settings, processWin: this.processWin, closeWindows })
    this.microbreakWins = []
    log.info(`Stretchly: finishing Mini break (shouldPlanNext: ${shouldPlanNext})`)
    if (shouldPlanNext) {
      this.breakPlanner.nextBreak()
    } else {
      this.breakPlanner.clear()
    }
    this.updateTray()
  }

  finishBreak = (shouldPlaySound = true, shouldPlanNext = true) => {
    breakComplete({ shouldPlaySound, windows: this.breakWins, breakType: 'long', settings: this.settings, processWin: this.processWin, closeWindows })
    this.breakWins = []
    log.info(`Stretchly: finishing Long break (shouldPlanNext: ${shouldPlanNext})`)
    if (shouldPlanNext) {
      this.breakPlanner.nextBreak()
    } else {
      this.breakPlanner.clear()
    }
    this.updateTray()
  }

  postponeMicrobreak = () => {
    breakComplete({ shouldPlaySound: false, windows: this.microbreakWins, breakType: 'mini', settings: this.settings, processWin: this.processWin, closeWindows })
    this.microbreakWins = []
    this.breakPlanner.postponeMicrobreak()
    log.info('Stretchly: postponing Mini break')
    this.updateTray()
  }

  postponeBreak = () => {
    breakComplete({ shouldPlaySound: false, windows: this.breakWins, breakType: 'long', settings: this.settings, processWin: this.processWin, closeWindows })
    this.breakWins = []
    this.breakPlanner.postponeBreak()
    log.info('Stretchly: postponing Long break')
    this.updateTray()
  }

  skipToMicrobreak = async (delay) => {
    if (this.microbreakWins?.length > 0) {
      breakComplete({ shouldPlaySound: false, windows: this.microbreakWins, breakType: 'mini', settings: this.settings, processWin: this.processWin, closeWindows })
      this.microbreakWins = []
    }
    if (this.breakWins?.length > 0) {
      breakComplete({ shouldPlaySound: false, windows: this.breakWins, breakType: 'long', settings: this.settings, processWin: this.processWin, closeWindows })
      this.breakWins = []
    }
    if (delay) {
      this.breakPlanner.skipToMicrobreak(delay)
      log.info(`Stretchly: skipping to Mini break in ${delay}ms`)
    } else {
      this.breakPlanner.skipToMicrobreak()
      log.info('Stretchly: skipping to Mini break')
    }
    this.updateTray()
  }

  skipToBreak = (delay) => {
    if (this.microbreakWins?.length > 0) {
      breakComplete({ shouldPlaySound: false, windows: this.microbreakWins, breakType: 'mini', settings: this.settings, processWin: this.processWin, closeWindows })
      this.microbreakWins = []
    }
    if (this.breakWins?.length > 0) {
      breakComplete({ shouldPlaySound: false, windows: this.breakWins, breakType: 'long', settings: this.settings, processWin: this.processWin, closeWindows })
      this.breakWins = []
    }
    if (delay) {
      this.breakPlanner.skipToBreak(delay)
      log.info(`Stretchly: skipping to Long break in ${delay}ms`)
    } else {
      this.breakPlanner.skipToBreak()
      log.info('Stretchly: skipping to Long break')
    }
    this.updateTray()
  }

  resetBreaks = () => {
    if (this.microbreakWins?.length > 0) {
      breakComplete({ shouldPlaySound: false, windows: this.microbreakWins, breakType: 'mini', settings: this.settings, processWin: this.processWin, closeWindows })
      this.microbreakWins = []
    }
    if (this.breakWins?.length > 0) {
      breakComplete({ shouldPlaySound: false, windows: this.breakWins, breakType: 'long', settings: this.settings, processWin: this.processWin, closeWindows })
      this.breakWins = []
    }

    this.breakPlanner.reset()
    log.info('Stretchly: resetting breaks')
    this.updateTray()
  }

  pauseBreaks = (milliseconds) => {
    if (this.microbreakWins?.length > 0) {
      this.finishMicrobreak(false)
    }
    if (this.breakWins?.length > 0) {
      this.finishBreak(false)
    }
    this.breakPlanner.pause(milliseconds)
    log.info(`Stretchly: pausing breaks for ${milliseconds}ms`)
    this.updateTray()
  }

  resumeBreaks = (notify = true) => {
    if (this.breakPlanner.dndManager.isOnDnd) {
      log.info('Stretchly: not resuming breaks because in Do Not Disturb')
    } else {
      this.breakPlanner.resume()
      log.info('Stretchly: resuming breaks')
      if (notify) {
        this.processWin.webContents.send('show-notification',
          i18next.t('main.resumingBreaks'),
          this.settings.get('silentNotifications')
        )
      }
    }
    this.updateTray()
  }

  startMicrobreakNotification = () => {
    this.processWin.webContents.send('show-notification',
      i18next.t('main.microbreakIn', { seconds: this.settings.get('microbreakNotificationInterval') / 1000 }),
      this.settings.get('silentNotifications')
    )
    log.info('Stretchly: showing Mini break notification')
    this.breakPlanner.nextBreakAfterNotification()
    this.updateTray()
  }

  startBreakNotification = () => {
    this.processWin.webContents.send('show-notification',
      i18next.t('main.breakIn', { seconds: this.settings.get('breakNotificationInterval') / 1000 }),
      this.settings.get('silentNotifications')
    )
    log.info('Stretchly: showing Long break notification')
    this.breakPlanner.nextBreakAfterNotification()
    this.updateTray()
  }
}

export default BreakControl
