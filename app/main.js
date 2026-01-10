import {
  BrowserWindow, Menu,
  Tray,
  app,
  dialog, globalShortcut,
  ipcMain,
  nativeTheme,
  powerMonitor,
  screen, shell
} from 'electron'
import log from 'electron-log/main.js'
import Store from 'electron-store'
import humanizeDuration from 'humanize-duration'
import i18next from 'i18next'
import { DateTime } from 'luxon'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFile, writeFile } from 'node:fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { resolveLocalImage } from './utils/imageResolver.js'

import BreaksPlanner from './breaksPlanner.js'
import AutostartManager from './utils/autostartManager.js'
import { registerBreakShortcuts } from './utils/breakShortcuts.js'
import { createChromeMonitor, createChromeOverlayWindows as createChromeOverlayWindowsUtil, getChromeWindows, isChromeActive } from './utils/chromeOverlay.js'
import Command from './utils/commands.js'
import defaultSettings from './utils/defaultSettings.js'
import DisplayManager from './utils/displayManager.js'
import ProcessMonitor from './utils/processMonitor.js'
import {
  canPostpone, canSkip, formatTimeRemaining,
  insideFlatpak, insideSnap, insideWindowsPortable,
  insideWindowsStore
} from './utils/utils.js'
import { calculateBackgroundColor as calculateBackgroundColorUtil, closeWindows, createContributorSettingsWindow as createContributorSettingsWindowUtil, createMyStretchlyWindow as createMyStretchlyWindowUtil, createPreferencesWindow as createPreferencesWindowUtil, createProcessWindow, createSyncPreferencesWindow as createSyncPreferencesWindowUtil, createWelcomeWindow as createWelcomeWindowUtil, getBlurredBackgroundWindowOptions as getBlurredBackgroundWindowOptionsUtil } from './utils/windowManager.js'
import { breakComplete, enterManualAwaitPhase } from './utils/breakManager.js'
import { trayIconPath, windowIconPath, getTrayMenuTemplate, updateToolTip } from './utils/trayManager.js'
import { registerIpcHandlers } from './utils/ipcHandlers.js'
import { startI18next, loadIdeas, planVersionCheck } from './utils/appLifecycle.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

process.on('uncaughtException', (err, _) => {
  log.error(err)
  const dialogOpts = {
    type: 'error',
    title: 'Stretchly',
    message: 'An error occured while running Stretchly and it will now quit. To report the issue, click Report.',
    buttons: ['Report', 'OK']
  }
  dialog.showMessageBox(dialogOpts).then((returnValue) => {
    if (returnValue.response === 0) {
      shell.openExternal('https://github.com/hovancik/stretchly/issues')
    }
    app.quit()
  })
})

// Prevent termination during breaks
function isInBreak () {
  if (!breakPlanner || !settings) return false
  const ref = breakPlanner.scheduler.reference
  const inMicrobreak = ref === 'finishMicrobreak' && settings.get('microbreakStrictMode')
  const inBreak = ref === 'finishBreak' && settings.get('breakStrictMode')
  return inMicrobreak || inBreak
}

// Handle SIGTERM (graceful termination request)
process.on('SIGTERM', (signal) => {
  if (isInBreak()) {
    log.warn('Stretchly: SIGTERM received but break is active - ignoring')
    // Don't exit - signal is ignored
    return
  }
  log.info('Stretchly: SIGTERM received, shutting down gracefully')
  app.isQuitting = true
  app.quit()
})

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', (signal) => {
  if (isInBreak()) {
    log.warn('Stretchly: SIGINT received but break is active - ignoring')
    // Don't exit - signal is ignored
    return
  }
  log.info('Stretchly: SIGINT received, shutting down gracefully')
  app.isQuitting = true
  app.quit()
})

// Note: SIGKILL cannot be caught - it's a force kill that bypasses all handlers

nativeTheme.on('updated', function theThemeHasChanged () {
  if (!gotTheLock) {
    return
  }
  updateTray()
})

let microbreakIdeas
let breakIdeas
let breakPlanner
let appIcon = null
let autostartManager = null
let displayManager = null
let processWin = null
let microbreakWins = null
let breakWins = null
let chromeMonitor = null
let preferencesWin = null
let welcomeWin = null
let contributorPreferencesWin = null
let syncPreferencesWin = null
let myStretchlyWin = null
let settings
let pausedForSuspendOrLock = false
let nextIdea = null
let updateChecker
let currentTrayIconPath = null
let currentTrayMenuTemplate = null
let processMonitor = null
let trayUpdateIntervalObj = null

if (insideWindowsPortable()) {
  const portableDataPath = join(process.env.PORTABLE_EXECUTABLE_DIR, 'Data')
  if (!existsSync(portableDataPath)) {
    mkdirSync(portableDataPath, { recursive: true })
  }
  app.setPath('userData', portableDataPath)
}

log.initialize({ preload: true })

// https://stackoverflow.com/questions/65859634/notification-from-electron-shows-electron-app-electron/65863174#65863174
if (process.platform === 'win32') {
  app.setAppUserModelId('Stretchly')
}

const global = {
  isNewVersion: false,
  isContributor: false
}

ipcMain.on('set-global-value', (event, name, value) => {
  global[name] = value
})

ipcMain.handle('get-global-value', (event, name) => {
  return global[name]
})

const commandLineArguments = process.argv
  .slice(app.isPackaged ? 1 : 2)

const gotTheLock = app.requestSingleInstanceLock(commandLineArguments)

if (!gotTheLock) {
  const cmd = new Command(commandLineArguments, app.getVersion(), false)
  cmd.runOrForward()
  app.quit()
} else {
  app.on('second-instance', (event, commandLine, workingDirectory, commandLineArguments) => {
    log.info(`Stretchly: arguments received from second instance: ${commandLineArguments}`)
    const cmd = new Command(commandLineArguments, app.getVersion())

    if (!cmd.hasSupportedCommand) {
      return
    }

    if (!cmd.checkInMain()) {
      log.info(`Stretchly: command '${cmd.command}' executed in second instance, dropped in main instance`)
      return
    }

    switch (cmd.command) {
      case 'reset':
        log.info('Stretchly: resetting breaks (requested by second instance)')
        resetBreaks()
        break

      case 'mini': {
        log.info('Stretchly: skip to Mini break (requested by second instance)')
        const delay = cmd.waitToMs()
        if (delay === -1) {
          log.error('Stretchly: error parsing wait interval to ms because of invalid value')
          return
        }
        if (cmd.options.title) nextIdea = [cmd.options.title]
        if (!cmd.options.noskip || delay) skipToMicrobreak(delay)
        break
      }

      case 'long': {
        log.info('Stretchly: skip to Long break (requested by second instance)')
        const delay = cmd.waitToMs()
        if (delay === -1) {
          log.error('Stretchly: error parsing wait interval to ms because of invalid value')
          return
        }
        nextIdea = [cmd.options.title ? cmd.options.title : null, cmd.options.text ? cmd.options.text : null]
        if (!cmd.options.noskip || delay) skipToBreak(delay)
        break
      }

      case 'resume':
        log.info('Stretchly: resume Breaks (requested by second instance)')
        if (breakPlanner.isPaused) resumeBreaks(false)
        break

      case 'toggle':
        log.info('Stretchly: toggle Breaks (requested by second instance)')
        if (breakPlanner.isPaused) resumeBreaks(false)
        else pauseBreaks(1)
        break

      case 'pause': {
        log.info('Stretchly: pause Breaks (requested by second instance)')
        const duration = cmd.durationToMs(settings)
        // -1 indicates an invalid value
        if (duration === -1) {
          log.error('Stretchly: error when parsing duration to ms because of invalid value')
          return
        }
        pauseBreaks(duration)
        break
      }

      case 'preferences':
        log.info('Stretchly: open Preferences window (requested by second instance)')
        createPreferencesWindow()
        break
    }
  })
}

app.on('ready', initialize)
app.on('window-all-closed', () => {
  // do nothing, so app wont get closed
})

// Initialize isQuitting flag for process monitor
app.isQuitting = false

app.on('before-quit', (event) => {
  if ((breakPlanner.scheduler.reference === 'finishMicrobreak' && settings.get('microbreakStrictMode')) ||
    (breakPlanner.scheduler.reference === 'finishBreak' && settings.get('breakStrictMode'))
  ) {
    log.info('Stretchly: preventing app closure (in break with strict mode)')
    event.preventDefault()
  } else {
    // Mark as graceful quit to prevent auto-restart
    app.isQuitting = true

    // Stop process monitor
    if (processMonitor) {
      processMonitor.stop()
    }

    globalShortcut.unregisterAll()
    // Clean up D-Bus connections
    if (autostartManager) {
      autostartManager.disconnect()
    }
    // Don't call app.quit() here - it's already being called, we just need to allow it
  }
})

async function initialize (isAppStart = true) {
  if (!gotTheLock) {
    return
  }
  // TODO maybe we should not reinitialize but handle everything when we save new values for preferences
  log.info(`Stretchly: ${isAppStart ? '' : 're'}initializing...`)

  EventEmitter.setMaxListeners(200) // for watching Store changes
  if (!settings) {
    settings = new Store({
      defaults: defaultSettings,
      beforeEachMigration: (store, context) => {
        log.info(`Stretchly: migrating preferences from Stretchly v${context.fromVersion} to v${context.toVersion}`)
      },
      migrations: {
        '1.13.0': store => {
          if (store.has('pauseBreaksShortcut')) {
            store.set('pauseBreaksToggleShortcut', store.get('pauseBreaksShortcut'))
            log.info(`Stretchly: settings pauseBreaksToggleShortcut to "${store.get('pauseBreaksShortcut')}"`)
            store.delete('pauseBreaksShortcut')
            log.info('Stretchly: removing pauseBreaksShortcut')
          } else {
            log.info('Stretchly: not migrating pauseBreaksShortcut')
          }
          if (store.has('pauseBreaksShortcut')) {
            store.delete('resumeBreaksShortcut')
            log.info('Stretchly: removing resumeBreaksShortcut')
          }
        },
        '1.17.0': store => {
          if (store.has('showBreakActionsInStrictMode')) {
            store.set('showTrayMenuInStrictMode', store.get('showBreakActionsInStrictMode'))
            log.info(`Stretchly: settings showTrayMenuInStrictMode to "${store.get('showBreakActionsInStrictMode')}"`)
            store.delete('showBreakActionsInStrictMode')
            log.info('Stretchly: removing showBreakActionsInStrictMode')
          } else {
            log.info('Stretchly: not migrating showBreakActionsInStrictMode')
          }
        },
        '1.18.2': store => {
          if (insideFlatpak() || insideWindowsStore() || insideSnap()) {
            if (!store.get('disableAppUpdateFeatures')) {
              store.set('disableAppUpdateFeatures', true)
              log.info('Stretchly: setting disableAppUpdateFeatures to true because we are in Flatpak/Windows Store/Snap build')
            }
          }
        },
        '1.19.0': store => {
          if (store.has('audio')) {
            const legacyAudio = store.get('audio')
            store.set('longBreakAudio', legacyAudio)
            log.info(`Stretchly: migrating audio to longBreakAudio with value "${legacyAudio}"`)
            store.delete('audio')
            log.info('Stretchly: removing audio')
          } else {
            log.info('Stretchly: not migrating audio to longBreakAudio')
          }
          if (store.has('microbreakStartSoundPlaying')) {
            const val = store.get('microbreakStartSoundPlaying') ? store.get('miniBreakAudio') : 'silence'
            store.set('miniBreakStartSound', val)
            log.info(`Stretchly: migrating microbreakStartSoundPlaying to miniBreakStartSound with value "${val}"`)
            store.delete('microbreakStartSoundPlaying')
            log.info('Stretchly: removing microbreakStartSoundPlaying')
          } else {
            log.info('Stretchly: not migrating microbreakStartSoundPlaying')
          }
          if (store.has('breakStartSoundPlaying')) {
            const val = store.get('breakStartSoundPlaying') ? store.get('longBreakAudio') : 'silence'
            store.set('longBreakStartSound', val)
            log.info(`Stretchly: migrating breakStartSoundPlaying to longBreakStartSound with value "${val}"`)
            store.delete('breakStartSoundPlaying')
            log.info('Stretchly: removing breakStartSoundPlaying')
          } else {
            log.info('Stretchly: not migrating breakStartSoundPlaying')
          }
        },
        '1.20.0': store => {
          if (store.has('timeToBreakInTray')) {
            if (store.get('timeToBreakInTray')) {
              store.set('trayIconStyle', 'time')
              log.info('Stretchly: migrating timeToBreakInTray to trayIconStyle="time"')
            } else {
              store.set('trayIconStyle', 'default')
              log.info('Stretchly: migrating tray settings to trayIconStyle="default"')
            }
            store.delete('timeToBreakInTray')
          }
        }
      },
      watch: true
    })
    log.info('Stretchly: loading preferences')
    Store.initRenderer()
    Object.entries(settings.store).forEach(([key, _]) => {
      settings.onDidChange(key, (newValue, oldValue) => {
        log.info(`Stretchly: setting '${key}' to '${JSON.stringify(newValue)}' (was '${JSON.stringify(oldValue)}')`)
      })
    })
  }
  if (!breakPlanner) {
    breakPlanner = new BreaksPlanner(settings)
    breakPlanner.nextBreak()
    breakPlanner.on('startMicrobreakNotification', () => { startMicrobreakNotification() })
    breakPlanner.on('startBreakNotification', () => { startBreakNotification() })
    breakPlanner.on('startMicrobreak', () => { startMicrobreak() })
    breakPlanner.on('finishMicrobreak', (shouldPlaySound, shouldPlanNext) => {
      if (settings.get('miniBreakManualFinish')) {
        enterMiniBreakManualContinuation(shouldPlaySound)
        return
      }
      finishMicrobreak(shouldPlaySound, shouldPlanNext)
    })
    breakPlanner.on('startBreak', () => { startBreak() })
    breakPlanner.on('finishBreak', (shouldPlaySound, shouldPlanNext) => {
      if (settings.get('longBreakManualFinish')) {
        enterLongBreakManualContinuation(shouldPlaySound)
        return
      }
      finishBreak(shouldPlaySound, shouldPlanNext)
    })
    breakPlanner.on('resumeBreaks', () => { resumeBreaks() })
    breakPlanner.on('updateToolTip', function () {
      updateTray()
    })
  } else {
    breakPlanner.clear()
    breakPlanner.appExclusionsManager.reinitialize(settings)
    breakPlanner.doNotDisturb(settings.get('monitorDnd'))
    breakPlanner.naturalBreaks(settings.get('naturalBreaks'))
    breakPlanner.nextBreak()
  }

  autostartManager = new AutostartManager({
    app,
    settings
  })

  if (!settings.get('_migratedOpenAtLogin')) {
    // one time migration with 1.20 or after
    settings.set('openAtLogin', await autostartManager.autoLaunchStatus())
    settings.set('_migratedOpenAtLogin', true)
    log.info('Stretchly: Migrated to openAtLogin')
  }

  const currentAutostartValue = await autostartManager.autoLaunchStatus()
  const openAtLogin = settings.get('openAtLogin')
  if (openAtLogin !== currentAutostartValue) {
    autostartManager.setAutostartEnabled(openAtLogin)
  }
  log.info(`Stretchly: attempting to set autostart to ${openAtLogin}`)

  // Initialize process monitor for auto-restart
  processMonitor = new ProcessMonitor({
    app,
    settings
  })
  processMonitor.start()

  const imagesDir = join(app.getPath('userData'), 'images')
  if (!existsSync(imagesDir)) {
    try {
      mkdirSync(imagesDir, { recursive: true })
    } catch (error) {
      log.error('Stretchly: error creating images directory', error)
    }
  }
  // Initialize portal early for Flatpak so it's ready when user opens preferences
  if (insideFlatpak()) {
    autostartManager.flatpakPortalManager.initialize().catch(err => {
      log.error('Stretchly: Failed to initialize portal manager during startup:', err)
    })
  }

  displayManager = new DisplayManager(settings)

  startI18next({ settings, __dirname })
  startProcessWin()
  createWelcomeWindow()
  nativeTheme.themeSource = settings.get('themeSource')

  readFile(join(app.getPath('userData'), 'stamp'), 'utf8', (err, data) => {
    if (err) {
      return
    }
    if (DateTime.fromISO(data).month === DateTime.now().month) {
      global.isContributor = true
      log.info('Stretchly: Thanks for your contributions!')
      if (preferencesWin) {
        preferencesWin.webContents.send('enable-contributor-preferences')
      }
      updateTray()
    }
  })
  startPowerMonitoring()
  if (preferencesWin) {
    preferencesWin.webContents.send('renderSettings', settings.store)
  }
  if (welcomeWin) {
    welcomeWin.webContents.send('renderSettings', settings.store)
  }
  if (contributorPreferencesWin) {
    contributorPreferencesWin.webContents.send('renderSettings', settings.store)
  }
  globalShortcut.unregisterAll()

  registerBreakShortcuts({
    settings,
    log,
    globalShortcut,
    breakPlanner,
    functions: { pauseBreaks, resumeBreaks, skipToBreak, skipToMicrobreak, resetBreaks }
  })

  // Register IPC handlers
  registerIpcHandlers({
    postponeMicrobreak,
    postponeBreak,
    finishMicrobreak,
    finishBreak,
    breakPlanner,
    settings,
    i18next,
    nativeTheme,
    autostartManager,
    updateTray,
    createPreferencesWindow,
    createContributorSettingsWindow,
    createSyncPreferencesWindow,
    createMyStretchlyWindow: ({ __dirname, displayManager, windowIconPath, provider }) => createMyStretchlyWindowUtil({ __dirname, displayManager, windowIconPath, provider }),
    getMyStretchlyWin: () => myStretchlyWin,
    setMyStretchlyWin: (win) => { myStretchlyWin = win },
    getPreferencesWin: () => preferencesWin,
    setPreferencesWin: (win) => { preferencesWin = win },
    initialize,
    defaultSettings,
    processWin,
    humanizeDuration,
    displayManager,
    windowIconPath: windowIconPathWrapper,
    global
  })

  updateTray()
}

i18next.on('languageChanged', () => {
  if (welcomeWin) {
    welcomeWin.webContents.send('translate')
  }
  if (preferencesWin) {
    preferencesWin.webContents.send('translate')
  }
  updateTray()
  const ideas = loadIdeas({ settings, i18next })
  breakIdeas = ideas.breakIdeas
  microbreakIdeas = ideas.microbreakIdeas
})

function onSuspendOrLock () {
  log.info('System: suspend or lock')
  if (settings.get('pauseForSuspendOrLock')) {
    if (breakPlanner.isPaused || breakPlanner.dndManager.isOnDnd ||
      breakPlanner.naturalBreaksManager.isSchedulerCleared ||
      breakPlanner.appExclusionsManager.isSchedulerCleared) {
      log.info('Stretchly: not pausing for suspendOrLock because paused already')
    } else {
      pausedForSuspendOrLock = true
      pauseBreaks(1)
      updateTray()
    }
  } else {
    log.info('Stretchly: not pausing for suspendOrLock because setting is disabled')
  }
}

function onResumeOrUnlock () {
  log.info('System: resume or unlock')
  if (pausedForSuspendOrLock) {
    pausedForSuspendOrLock = false
    resumeBreaks(false)
  } else {
    // corrrect the planner for the time spent in suspend
    breakPlanner.correctScheduler()
  }
  updateTray()
}

function startPowerMonitoring () {
  powerMonitor.on('suspend', onSuspendOrLock)
  powerMonitor.on('lock-screen', onSuspendOrLock)
  powerMonitor.on('resume', onResumeOrUnlock)
  powerMonitor.on('unlock-screen', onResumeOrUnlock)
}

// closeWindows is now imported from utils/windowManager.js

// trayIconPath and windowIconPath are now imported from utils/trayManager.js
// Create wrapper functions that pass the required dependencies
function trayIconPathWrapper () {
  if (!breakPlanner || !settings) {
    // Return a default path if breakPlanner isn't initialized yet
    return join(__dirname, '/images/app-icons/icon.png')
  }
  return trayIconPath({ breakPlanner, settings, nativeTheme, __dirname })
}
const windowIconPathWrapper = () => windowIconPath({ settings, nativeTheme, __dirname })

function startProcessWin () {
  if (processWin) {
    planVersionCheckWrapper()
    return
  }
  processWin = createProcessWindow({ __dirname, planVersionCheck: planVersionCheckWrapper })
}

function createWelcomeWindow (isAppStart = true) {
  welcomeWin = createWelcomeWindowUtil({ __dirname, settings, displayManager, windowIconPath: windowIconPathWrapper, isAppStart })
  if (welcomeWin) {
    welcomeWin.once('closed', () => {
      welcomeWin = null
    })
  }
}

function createContributorSettingsWindow () {
  if (contributorPreferencesWin) {
    contributorPreferencesWin.show()
    return
  }
  contributorPreferencesWin = createContributorSettingsWindowUtil({ __dirname, displayManager, windowIconPath: windowIconPathWrapper })
  contributorPreferencesWin.once('closed', () => {
    contributorPreferencesWin = null
  })
}

function createSyncPreferencesWindow () {
  if (syncPreferencesWin) {
    syncPreferencesWin.show()
    return
  }
  syncPreferencesWin = createSyncPreferencesWindowUtil({ __dirname, displayManager, windowIconPath: windowIconPathWrapper })
  syncPreferencesWin.once('closed', () => {
    syncPreferencesWin = null
  })
}

// planVersionCheck and checkVersion are now imported from utils/appLifecycle.js
function planVersionCheckWrapper (seconds = 1) {
  planVersionCheck({ seconds, settings, processWin, app, updateChecker, setUpdateChecker: (val) => { updateChecker = val } })
}

function startMicrobreakNotification () {
  showNotification(i18next.t('main.microbreakIn', { seconds: settings.get('microbreakNotificationInterval') / 1000 }))
  log.info('Stretchly: showing Mini break notification')
  breakPlanner.nextBreakAfterNotification()
  updateTray()
}

function startBreakNotification () {
  showNotification(i18next.t('main.breakIn', { seconds: settings.get('breakNotificationInterval') / 1000 }))
  log.info('Stretchly: showing Long break notification')
  breakPlanner.nextBreakAfterNotification()
  updateTray()
}

// getBlurredBackgroundWindowOptions is now imported from utils/windowManager.js
function getBlurredBackgroundWindowOptions () {
  return getBlurredBackgroundWindowOptionsUtil(settings)
}

// Chrome overlay functions are now in utils/chromeOverlay.js

/**
 * Start Chrome monitoring
 */
function startChromeMonitoring (breakType) {
  if (chromeMonitor) {
    chromeMonitor.stop()
  }

  chromeMonitor = createChromeMonitor({
    breakType,
    getWins: () => breakType === 'mini' ? microbreakWins : breakWins,
    setWins: (wins) => {
      if (breakType === 'mini') {
        microbreakWins = wins
      } else {
        breakWins = wins
      }
    },
    createChromeOverlayWindows: (breakType, chromeWindows, isInitialStart) => {
      return createChromeOverlayWindows({
        breakType,
        chromeWindows,
        isInitialStart,
        microbreakWins,
        breakWins,
        settings,
        breakPlanner,
        windowIconPath,
        getBlurredBackgroundWindowOptions: () => getBlurredBackgroundWindowOptions(settings),
        calculateBackgroundColor: (color) => calculateBackgroundColor(color, settings),
        microbreakIdeas,
        breakIdeas,
        finishMicrobreak,
        finishBreak,
        postponeMicrobreak,
        postponeBreak,
        canPostpone,
        canSkip,
        updateTray
      })
    }
  })
  chromeMonitor.start()
}

/**
 * Stop Chrome monitoring
 */
function stopChromeMonitoring () {
  if (chromeMonitor) {
    chromeMonitor.stop()
    chromeMonitor = null
  }
}

/**
 * Create Chrome overlay windows for an active break (wrapper for utility function)
 * @param {string} breakType - 'mini' or 'long'
 * @param {Array} chromeWindows - Array of Chrome window bounds
 * @param {boolean} isInitialStart - If true, emit start event to begin timer. If false, break is already running.
 */
async function createChromeOverlayWindows (breakType, chromeWindows, isInitialStart = false) {
  return createChromeOverlayWindowsUtil({
    breakType,
    chromeWindows,
    isInitialStart,
    microbreakWins,
    breakWins,
    settings,
    breakPlanner,
    windowIconPath,
    getBlurredBackgroundWindowOptions: () => getBlurredBackgroundWindowOptions(settings),
    calculateBackgroundColor: (color) => calculateBackgroundColor(color, settings),
    microbreakIdeas,
    breakIdeas,
    finishMicrobreak,
    finishBreak,
    postponeMicrobreak,
    postponeBreak,
    canPostpone,
    canSkip,
    updateTray
  })
}

// isChromeActive is now imported from utils/chromeOverlay.js

async function startMicrobreak () {
  // don't start another break if break running
  if (microbreakWins) {
    log.warn('Stretchly: Mini break already running, not starting Mini break')
    return
  }

  // Check if Chrome is active
  const chromeActive = await isChromeActive()
  let chromeWindows = []

  if (chromeActive) {
    // Get Chrome window positions
    chromeWindows = await getChromeWindows()
    if (chromeWindows.length === 0) {
      log.info('Stretchly: Chrome is active but no windows detected, will show normal break')
    }
  } else {
    log.info('Stretchly: Chrome is not active, will show normal break')
  }

  const breakDuration = settings.get('microbreakDuration')
  const strictMode = settings.get('microbreakStrictMode')
  const postponesLimit = settings.get('microbreakPostponesLimit')
  const postponableDurationPercent = settings.get('microbreakPostponableDurationPercent')
  const postponable = settings.get('microbreakPostpone') &&
    breakPlanner.postponesNumber < postponesLimit && postponesLimit > 0
  const showBreaksAsRegularWindows = settings.get('showBreaksAsRegularWindows')

  const modalPath = 'file://' + join(__dirname, '/microbreak.html')
  microbreakWins = []

  const idea = nextIdea || (settings.get('ideas') ? microbreakIdeas.randomElement : [''])
  nextIdea = null

  if (!settings.get('silentNotifications')) {
    const sound = settings.get('miniBreakStartSound')
    if (sound !== 'silence') {
      processWin.webContents.send('play-sound', sound, settings.get('volume'))
    }
  }

  // Remove existing handler if it exists (in case Chrome monitoring recreates windows)
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
      postponable, postponableDurationPercent,
      calculateBackgroundColor(settings.get('miniBreakColor'))]
  })

  // Only show overlay if Chrome is active and has visible windows
  const showAsChromeOverlay = chromeActive && chromeWindows.length > 0

  // Create break windows - ONLY as Chrome overlay (never show normal break)
  if (showAsChromeOverlay) {
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
        backgroundColor: calculateBackgroundColor(settings.get('miniBreakColor')),
        skipTaskbar: true,
        focusable: false,
        alwaysOnTop: true,
        hasShadow: false,
        title: 'Stretchly',
        titleBarStyle: 'hidden',
        titleBarOverlay: true,
        webPreferences: {
          preload: join(__dirname, './microbreak-preload.mjs'),
          sandbox: false
        }
      }

      let microbreakWinLocal = new BrowserWindow(windowOptions)
      // seems to help with multiple-displays problems
      microbreakWinLocal.setSize(windowOptions.width, windowOptions.height)

      microbreakWinLocal.once('ready-to-show', () => {
        log.info('Stretchly: ready-to-show fired')
      })

      ipcMain.once('mini-break-loaded', () => {
        log.info('Stretchly: Mini break window loaded')
        if (showBreaksAsRegularWindows) {
          microbreakWinLocal.show()
        } else {
          microbreakWinLocal.showInactive()
        }

        log.info(`Stretchly: showing Chrome overlay window ${i + 1} of ${chromeWindows.length}`)
        if (process.platform === 'darwin') {
          microbreakWinLocal.setMinimizable(false)
          microbreakWinLocal.setClosable(false)
          microbreakWinLocal.setFullScreen(false)
          microbreakWinLocal.setKiosk(false)
        }
        if (i === 0) {
          breakPlanner.emit('microbreakStarted', true)
          log.info('Stretchly: starting Mini break over Chrome')
        }
        updateTray()
      })

      microbreakWinLocal.loadURL(modalPath)
      microbreakWinLocal.setVisibleOnAllWorkspaces(true)
      microbreakWinLocal.setAlwaysOnTop(true, 'pop-up-menu')
      if (microbreakWinLocal) {
        microbreakWinLocal.on('close', (e) => {
          if (breakPlanner.scheduler.timeLeft > 0 && settings.get('microbreakStrictMode')) {
            log.info('Stretchly: preventing closing break window as in strict mode')
            e.preventDefault()
          }
        })
        microbreakWinLocal.once('closed', () => {
          microbreakWinLocal = null
        })
      }
      microbreakWins.push(microbreakWinLocal)
    }
    // Start monitoring to hide overlay if Chrome closes or becomes inactive
    startChromeMonitoring('mini')
  } else {
    // Chrome is not active - don't show any windows, just start monitoring
    log.info('Stretchly: Chrome is not active, waiting for Chrome to become active before showing break')
    // Still emit the break started event so the timer runs
    breakPlanner.emit('microbreakStarted', true)
    // Start monitoring for Chrome activation
    startChromeMonitoring('mini')
  }

  if (process.platform === 'darwin') {
    if (app.dock.isVisible) {
      app.dock.hide()
    }
  }
}

async function startBreak () {
  if (breakWins) {
    log.warn('Stretchly: Long break already running, not starting Long break')
    return
  }

  // Check if Chrome is active
  const chromeActive = await isChromeActive()
  let chromeWindows = []

  if (chromeActive) {
    // Get Chrome window positions
    chromeWindows = await getChromeWindows()
    if (chromeWindows.length === 0) {
      log.info('Stretchly: Chrome is active but no windows detected, will show normal break')
    }
  } else {
    log.info('Stretchly: Chrome is not active, will show normal break')
  }

  const breakDuration = settings.get('breakDuration')
  const strictMode = settings.get('breakStrictMode')
  const postponesLimit = settings.get('breakPostponesLimit')
  const postponableDurationPercent = settings.get('breakPostponableDurationPercent')
  const postponable = settings.get('breakPostpone') &&
    breakPlanner.postponesNumber < postponesLimit && postponesLimit > 0
  const showBreaksAsRegularWindows = settings.get('showBreaksAsRegularWindows')

  const modalPath = 'file://' + join(__dirname, '/break.html')
  breakWins = []

  const defaultNextIdea = settings.get('ideas') ? breakIdeas.randomElement : ['', '']
  const idea = nextIdea ? (nextIdea.map((val, index) => val || defaultNextIdea[index])) : defaultNextIdea
  nextIdea = null

  if (!settings.get('silentNotifications')) {
    const sound = settings.get('longBreakStartSound')
    if (sound !== 'silence') {
      processWin.webContents.send('play-sound', sound, settings.get('volume'))
    }
  }

  // Remove existing handler if it exists (in case Chrome monitoring recreates windows)
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
      postponable, postponableDurationPercent,
      calculateBackgroundColor(settings.get('mainColor'))]
  })

  // Only show overlay if Chrome is active and has visible windows
  const showAsChromeOverlay = chromeActive && chromeWindows.length > 0

  // Create break windows - ONLY as Chrome overlay (never show normal break)
  if (showAsChromeOverlay) {
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
        backgroundColor: calculateBackgroundColor(settings.get('mainColor')),
        skipTaskbar: true,
        focusable: false,
        alwaysOnTop: true,
        hasShadow: false,
        title: 'Stretchly',
        titleBarStyle: 'hidden',
        titleBarOverlay: true,
        webPreferences: {
          preload: join(__dirname, './break-preload.mjs'),
          sandbox: false
        }
      }

      let breakWinLocal = new BrowserWindow(windowOptions)
      // seems to help with multiple-displays problems
      breakWinLocal.setSize(windowOptions.width, windowOptions.height)

      breakWinLocal.once('ready-to-show', () => {
        log.info('Stretchly: ready-to-show fired')
      })

      ipcMain.once('long-break-loaded', () => {
        log.info('Stretchly: Long break window loaded')
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
          breakPlanner.emit('breakStarted', true)
          log.info('Stretchly: starting Long break over Chrome')
        }
        updateTray()
      })

      breakWinLocal.loadURL(modalPath)
      breakWinLocal.setVisibleOnAllWorkspaces(true)
      breakWinLocal.setAlwaysOnTop(true, 'pop-up-menu')
      if (breakWinLocal) {
        breakWinLocal.on('close', (e) => {
          if (breakPlanner.scheduler.timeLeft > 0 && settings.get('breakStrictMode')) {
            log.info('Stretchly: preventing closing break window as in strict mode')
            e.preventDefault()
          }
        })
        breakWinLocal.once('closed', () => {
          breakWinLocal = null
        })
      }
      breakWins.push(breakWinLocal)
    }
    // Start monitoring to hide overlay if Chrome closes or becomes inactive
    startChromeMonitoring('long')
  } else {
    // Chrome is not active - don't show any windows, just start monitoring
    log.info('Stretchly: Chrome is not active, waiting for Chrome to become active before showing break')
    // Still emit the break started event so the timer runs
    breakPlanner.emit('breakStarted', true)
    // Start monitoring for Chrome activation
    startChromeMonitoring('long')
  }

  if (process.platform === 'darwin') {
    if (app.dock.isVisible) {
      app.dock.hide()
    }
  }
}

// breakComplete and enterManualAwaitPhase are now imported from utils/breakManager.js
// Create wrapper functions
function breakCompleteWrapper (shouldPlaySound, windows, breakType) {
  return breakComplete({ shouldPlaySound, windows, breakType, settings, processWin, closeWindows })
}

function enterManualAwaitPhaseWrapper (type, shouldPlaySound) {
  return enterManualAwaitPhase({ type, shouldPlaySound, microbreakWins, breakWins, settings, processWin })
}

const enterMiniBreakManualContinuation = (shouldPlaySound) => enterManualAwaitPhaseWrapper('mini', shouldPlaySound)
const enterLongBreakManualContinuation = (shouldPlaySound) => enterManualAwaitPhaseWrapper('long', shouldPlaySound)

function finishMicrobreak (shouldPlaySound = true, shouldPlanNext = true) {
  stopChromeMonitoring()
  microbreakWins = breakCompleteWrapper(shouldPlaySound, microbreakWins, 'mini')
  log.info(`Stretchly: finishing Mini break (shouldPlanNext: ${shouldPlanNext})`)
  if (shouldPlanNext) {
    breakPlanner.nextBreak()
  } else {
    breakPlanner.clear()
  }
  updateTray()
}

function finishBreak (shouldPlaySound = true, shouldPlanNext = true) {
  stopChromeMonitoring()
  breakWins = breakCompleteWrapper(shouldPlaySound, breakWins, 'long')
  log.info(`Stretchly: finishing Long break (shouldPlanNext: ${shouldPlanNext})`)
  if (shouldPlanNext) {
    breakPlanner.nextBreak()
  } else {
    breakPlanner.clear()
  }
  updateTray()
}

function postponeMicrobreak () {
  microbreakWins = breakCompleteWrapper(false, microbreakWins, 'mini')
  breakPlanner.postponeCurrentBreak()
  log.info('Stretchly: postponing Mini break')
  updateTray()
}

function postponeBreak () {
  breakWins = breakCompleteWrapper(false, breakWins, 'long')
  breakPlanner.postponeCurrentBreak()
  log.info('Stretchly: postponing Long break')
  updateTray()
}

function skipToMicrobreak (delay) {
  if (microbreakWins) {
    microbreakWins = breakCompleteWrapper(false, microbreakWins, 'mini')
  }
  if (breakWins) {
    breakWins = breakCompleteWrapper(false, breakWins, 'long')
  }
  if (delay) {
    breakPlanner.skipToMicrobreak(delay)
    log.info(`Stretchly: skipping to Mini break in ${delay}ms`)
  } else {
    breakPlanner.skipToMicrobreak()
    log.info('Stretchly: skipping to Mini break')
  }
  updateTray()
}

function skipToBreak (delay) {
  if (microbreakWins) {
    microbreakWins = breakCompleteWrapper(false, microbreakWins, 'mini')
  }
  if (breakWins) {
    breakWins = breakCompleteWrapper(false, breakWins, 'long')
  }
  if (delay) {
    breakPlanner.skipToBreak(delay)
    log.info(`Stretchly: skipping to Long break in ${delay}ms`)
  } else {
    breakPlanner.skipToBreak()
    log.info('Stretchly: skipping to Long break')
  }
  updateTray()
}

function resetBreaks () {
  if (microbreakWins) {
    microbreakWins = breakCompleteWrapper(false, microbreakWins, 'mini')
  }
  if (breakWins) {
    breakWins = breakCompleteWrapper(false, breakWins, 'long')
  }
  breakPlanner.reset()
  log.info('Stretchly: resetting breaks')
  updateTray()
}

// calculateBackgroundColor is now imported from utils/windowManager.js
function calculateBackgroundColor (color) {
  return calculateBackgroundColorUtil(color, settings)
}

function pauseBreaks (milliseconds) {
  if (microbreakWins) {
    finishMicrobreak(false)
  }
  if (breakWins) {
    finishBreak(false)
  }
  breakPlanner.pause(milliseconds)
  log.info(`Stretchly: pausing breaks for ${milliseconds}ms`)
  updateTray()
}

function resumeBreaks (notify = true) {
  if (breakPlanner.dndManager.isOnDnd) {
    log.info('Stretchly: not resuming breaks because in Do Not Disturb')
  } else {
    breakPlanner.resume()
    log.info('Stretchly: resuming breaks')
    if (notify) {
      showNotification(i18next.t('main.resumingBreaks'))
    }
  }
  updateTray()
}

function createPreferencesWindow () {
  if (preferencesWin) {
    preferencesWin.show()
    return
  }
  preferencesWin = createPreferencesWindowUtil({ __dirname, displayManager, windowIconPath: windowIconPathWrapper, screen })
  preferencesWin.once('closed', () => {
    preferencesWin = null
  })
}

function updateTray () {
  if (process.platform === 'darwin') {
    if (app.dock.isVisible) {
      app.dock.hide()
    }
  }

  if (!appIcon && !settings.get('showTrayIcon')) {
    return
  }

  if (settings.get('showTrayIcon')) {
    if (!appIcon) {
      appIcon = new Tray(trayIconPathWrapper())
      appIcon.on('double-click', () => {
        createPreferencesWindow()
      })
      appIcon.on('click', () => {
        appIcon.popUpContextMenu(Menu.buildFromTemplate(currentTrayMenuTemplate))
      })
    }
    if (!trayUpdateIntervalObj) {
      trayUpdateIntervalObj = setInterval(updateTray, 10000)
    }

    updateToolTipWrapper()

    const newTrayIconPath = trayIconPathWrapper()
    if (newTrayIconPath !== currentTrayIconPath) {
      appIcon.setImage(newTrayIconPath)
      currentTrayIconPath = newTrayIconPath
    }

    const newTrayMenuTemplate = getTrayMenuTemplateWrapper()
    if (JSON.stringify(newTrayMenuTemplate) !== JSON.stringify(currentTrayMenuTemplate)) {
      const trayMenu = Menu.buildFromTemplate(newTrayMenuTemplate)
      appIcon.setContextMenu(trayMenu)
      currentTrayMenuTemplate = newTrayMenuTemplate
    }
  }
}

// getTrayMenuTemplate and updateToolTip are now imported from utils/trayManager.js
function getTrayMenuTemplateWrapper () {
  return getTrayMenuTemplate({
    settings,
    breakPlanner,
    global,
    i18next,
    humanizeDuration,
    skipToMicrobreak,
    skipToBreak,
    resumeBreaks,
    pauseBreaks,
    resetBreaks,
    createPreferencesWindow,
    createContributorSettingsWindow,
    createSyncPreferencesWindow,
    app
  })
}

function updateToolTipWrapper () {
  updateToolTip({ appIcon, breakPlanner, settings, i18next, humanizeDuration })
}

function showNotification (text) {
  processWin.webContents.send('show-notification',
    text,
    settings.get('silentNotifications')
  )
}

ipcMain.on('postpone-mini-break', function (event) {
  postponeMicrobreak()
})

ipcMain.on('postpone-long-break', function (event) {
  postponeBreak()
})

ipcMain.on('finish-mini-break', function (event, shouldPlaySound, shouldPlanNext) {
  finishMicrobreak(shouldPlaySound, shouldPlanNext)
})

ipcMain.on('finish-long-break', function (event, shouldPlaySound, shouldPlanNext) {
  finishBreak(shouldPlaySound, shouldPlanNext)
})

ipcMain.on('save-setting', function (event, key, value) {
  if (key === 'naturalBreaks') {
    breakPlanner.naturalBreaks(value)
  }

  if (key === 'monitorDnd') {
    breakPlanner.doNotDisturb(value)
  }

  if (key === 'language') {
    i18next.changeLanguage(value)
  }

  if (key === 'themeSource') {
    nativeTheme.themeSource = value
  }

  if (key === 'longBreakAudio') {
    settings.set('miniBreakAudio', value)
  }

  if (key === 'mainColor') {
    settings.set('miniBreakColor', value)
  }

  if (key === 'showTrayIcon') {
    settings.set('showTrayIcon', value)
    if (value) {
      updateTray()
    } else {
      clearInterval(trayUpdateIntervalObj)
      trayUpdateIntervalObj = null
      appIcon.destroy()
      appIcon = null
    }
  }

  if (key === 'openAtLogin') {
    autostartManager.setAutostartEnabled(value)
  }

  settings.set(key, value)

  updateTray()
})

ipcMain.on('update-tray', function (event) {
  updateTray()
})

ipcMain.on('restore-defaults', (event) => {
  const dialogOpts = {
    type: 'question',
    title: i18next.t('main.restoreDefaults'),
    message: i18next.t('main.warning'),
    buttons: [i18next.t('main.continue'), i18next.t('main.cancel')]
  }
  dialog.showMessageBox(dialogOpts).then(async (returnValue) => {
    if (returnValue.response === 0) {
      log.info('Stretchly: restoring default settings')
      settings.store = Object.assign(defaultSettings, { isFirstRun: false, __internal__: settings.get('__internal__') })
      initialize(false)
      event.sender.reload()
    }
  })
})

ipcMain.on('play-sound', (event, sound) => {
  processWin.webContents.send('play-sound', sound, settings.get('volume'))
})

ipcMain.handle('show-debug', (event) => {
  const reference = breakPlanner.scheduler.reference
  const timeleft = formatTimeRemaining(
    breakPlanner.scheduler.timeLeft, settings.get('language'),
    i18next, humanizeDuration
  )
  const breaknumber = breakPlanner.breakNumber
  const postponesnumber = breakPlanner.postponesNumber
  const doNotDisturb = breakPlanner.dndManager.isOnDnd
  let settingsFile = settings.path
  let logsFile = log.transports.file.getFile().path
  let imagesFolder = join(app.getPath('userData'), 'images')
  if (insideWindowsStore()) {
    settingsFile = settingsFile.replace('Roaming', 'Local\\Packages\\33881JanHovancik.stretchly_24fg4m0zq65je\\LocalCache\\Roaming')
    logsFile = logsFile.replace('Roaming', 'Local\\Packages\\33881JanHovancik.stretchly_24fg4m0zq65je\\LocalCache\\Roaming')
    imagesFolder = imagesFolder.replace('Roaming', 'Local\\Packages\\33881JanHovancik.stretchly_24fg4m0zq65je\\LocalCache\\Roaming')
  }
  return [
    reference,
    timeleft,
    breaknumber,
    postponesnumber,
    settingsFile,
    logsFile,
    doNotDisturb,
    imagesFolder
  ]
})

ipcMain.on('open-preferences', function (event) {
  createPreferencesWindow()
})

ipcMain.on('set-contributor', function (event) {
  const dir = app.getPath('userData')
  const contributorStampFile = `${dir}/stamp`
  writeFile(contributorStampFile, DateTime.now().toString(), () => { })
  global.isContributor = true
  log.info('Stretchly: Logged in. Thanks for your contributions!')
  if (preferencesWin) {
    preferencesWin.webContents.send('enable-contributor-preferences')
  }
  updateTray()
})

ipcMain.on('open-contributor-preferences', function () {
  createContributorSettingsWindow()
})

ipcMain.on('open-contributor-auth', function (event, provider) {
  if (myStretchlyWin) {
    myStretchlyWin.show()
    return
  }
  const myStretchlyUrl = `https://my.stretchly.net/app/v1?provider=${provider}`
  myStretchlyWin = new BrowserWindow({
    autoHideMenuBar: true,
    show: false,
    width: 1000,
    height: 700,
    icon: windowIconPath(),
    x: displayManager.getDisplayX(),
    y: displayManager.getDisplayY(),
    backgroundColor: 'whitesmoke',
    webPreferences: {
      preload: join(__dirname, './electron-bridge.mjs'),
      sandbox: false
    }
  })
  myStretchlyWin.webContents.loadURL(myStretchlyUrl)

  myStretchlyWin.once('closed', () => {
    myStretchlyWin = null
  })

  myStretchlyWin.once('ready-to-show', () => {
    myStretchlyWin.center()
    myStretchlyWin.show()
  })
})

ipcMain.on('open-sync-preferences', () => {
  createSyncPreferencesWindow()
})

ipcMain.handle('current-settings', (event) => {
  return settings.store
})

ipcMain.handle('restore-remote-settings', (event, remoteSettings) => {
  log.info('Stretchly: restoring remote settings')
  settings.store = remoteSettings
  initialize(false)
})

ipcMain.handle('i18next-translate', (event, key, options) => {
  return i18next.t(key, options)
})

ipcMain.handle('i18next-dir', (event) => {
  return i18next.dir()
})

ipcMain.handle('settings-get', (event, key) => {
  return settings.get(key)
})

ipcMain.on('close-current-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) {
    win.close()
  }
})

ipcMain.handle('get-window-bounds', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win.getBounds()
})

ipcMain.on('set-window-size', (event, width, height) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  win.setSize(width, height)
})

ipcMain.handle('get-version', (event) => {
  return app.getVersion()
})

ipcMain.handle('resolve-local-image', (event, filename) => {
  const imagesPath = join(app.getPath('userData'), 'images')
  return resolveLocalImage(imagesPath, filename)
})
