import {
  Menu,
  Tray,
  app,
  dialog, globalShortcut,
  nativeTheme,
  screen, shell
} from 'electron'
import log from 'electron-log/main.js'
import humanizeDuration from 'humanize-duration'
import i18next from 'i18next'
import { DateTime } from 'luxon'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFile } from 'node:fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import BreakControl from './breakControl.js'
import BreaksPlanner from './breaksPlanner.js'
import { planVersionCheck, startI18next } from './utils/appLifecycle.js'
import AutostartManager from './utils/autostartManager.js'
import { registerBreakShortcuts } from './utils/breakShortcuts.js'
import Command from './utils/commands.js'
import defaultSettings from './utils/defaultSettings.js'
import DisplayManager from './utils/displayManager.js'
import { registerIpcHandlers } from './utils/ipcHandlers.js'
import ProcessMonitor from './utils/processMonitor.js'
import { getSettings, initializeSettings } from './utils/settings.js'
import { getTrayMenuTemplate, trayIconPath, updateToolTip, windowIconPath } from './utils/trayManager.js'
import {
  insideFlatpak, insideWindowsPortable
} from './utils/utils.js'
import { createContributorSettingsWindow as createContributorSettingsWindowUtil, createMyStretchlyWindow as createMyStretchlyWindowUtil, createPreferencesWindow as createPreferencesWindowUtil, createProcessWindow, createSyncPreferencesWindow as createSyncPreferencesWindowUtil, createWelcomeWindow as createWelcomeWindowUtil } from './utils/windowManager.js'
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

let breakPlanner
let appIcon = null
let autostartManager = null
let displayManager = null
let processWin = null
// const chromeMonitor = null
let preferencesWin = null
let welcomeWin = null
let contributorPreferencesWin = null
let syncPreferencesWin = null
let settings
let myStretchlyWin = null
let updateChecker
let currentTrayIconPath = null
let currentTrayMenuTemplate = null
let processMonitor = null
let trayUpdateIntervalObj = null
let breakControl = null

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
        breakControl.resetBreaks()
        break

      case 'mini': {
        log.info('Stretchly: skip to Mini break (requested by second instance)')
        const delay = cmd.waitToMs()
        if (delay === -1) {
          log.error('Stretchly: error parsing wait interval to ms because of invalid value')
          return
        }
        if (cmd.options.title) breakControl.nextIdea = [cmd.options.title]
        if (!cmd.options.noskip || delay) breakControl.skipToMicrobreak(delay)
        break
      }

      case 'long': {
        log.info('Stretchly: skip to Long break (requested by second instance)')
        const delay = cmd.waitToMs()
        if (delay === -1) {
          log.error('Stretchly: error parsing wait interval to ms because of invalid value')
          return
        }
        breakControl.nextIdea = [cmd.options.title ? cmd.options.title : null, cmd.options.text ? cmd.options.text : null]
        if (!cmd.options.noskip || delay) breakControl.skipToBreak(delay)
        break
      }

      case 'resume':
        log.info('Stretchly: resume Breaks (requested by second instance)')
        if (breakPlanner.isPaused) breakControl.resumeBreaks(false)
        break

      case 'toggle':
        log.info('Stretchly: toggle Breaks (requested by second instance)')
        if (breakPlanner.isPaused) breakControl.resumeBreaks(false)
        else breakControl.pauseBreaks(1)
        break

      case 'pause': {
        log.info('Stretchly: pause Breaks (requested by second instance)')
        const duration = cmd.durationToMs(settings)
        // -1 indicates an invalid value
        if (duration === -1) {
          log.error('Stretchly: error when parsing duration to ms because of invalid value')
          return
        }
        breakControl.pauseBreaks(duration)
        break
      }

      case 'preferences':
        log.info('Stretchly: open Preferences window (requested by second instance)')
        createPreferencesWindow()
        break
    }
  })
}

app.on('ready', () => {
  initialize()
})
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
  initializeSettings()
  startProcessWin()
  settings = getSettings()
  displayManager = new DisplayManager(settings)

  // Initialize i18next before creating BreakControl since it uses i18next.t()
  await startI18next({ settings, __dirname })

  breakPlanner = new BreaksPlanner()
  breakControl = new BreakControl(processWin, updateTray)

  autostartManager = new AutostartManager({
    app,
    settings
  })

  if (insideFlatpak()) {
    autostartManager.flatpakPortalManager.initialize().catch(err => {
      log.error('Stretchly: Failed to initialize portal manager during startup:', err)
    })
  }

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
    functions: { pauseBreaks: breakControl.pauseBreaks, resumeBreaks: breakControl.resumeBreaks, skipToBreak: breakControl.skipToBreak, skipToMicrobreak: breakControl.skipToMicrobreak, resetBreaks: breakControl.resetBreaks }
  })

  // Register IPC handlers

  registerIpcHandlers({
    postponeMicrobreak: breakControl.postponeMicrobreak,
    postponeBreak: breakControl.postponeBreak,
    finishMicrobreak: breakControl.finishMicrobreak,
    finishBreak: breakControl.finishBreak,
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

/**
 * Start Chrome monitoring
 */
// function startChromeMonitoring (breakType) {
// if (chromeMonitor) {
//     chromeMonitor.stop()
// }

// chromeMonitor = createChromeMonitor({
//     breakType,
//     getWins: () => breakType === 'mini' ? microbreakWins : breakWins,
//     setWins: (wins) => {
//         if (breakType === 'mini') {
//             microbreakWins = wins
//         } else {
//             breakWins = wins
//         }
//     },
//     createChromeOverlayWindows: (breakType, chromeWindows, isInitialStart) => {
//         return createChromeOverlayWindows({
//             breakType,
//             chromeWindows,
//             isInitialStart,
//             microbreakWins,
//             breakWins,
//             settings,
//             breakPlanner,
//             windowIconPath,
//             getBlurredBackgroundWindowOptions: () => getBlurredBackgroundWindowOptions(settings),
//             calculateBackgroundColor: (color) => calculateBackgroundColor(color, settings),
//             microbreakIdeas,
//             breakIdeas,
//             finishMicrobreak,
//             finishBreak,
//             postponeMicrobreak,
//             postponeBreak,
//             canPostpone,
//             canSkip,
//             updateTray
//         })
//     }
// })
// chromeMonitor.start()
// }

/**
 * Stop Chrome monitoring
 */
// function stopChromeMonitoring () {
// if (chromeMonitor) {
//     chromeMonitor.stop()
//     chromeMonitor = null
// }
// }

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

    updateToolTip({ appIcon, breakPlanner, settings, i18next, humanizeDuration })

    const newTrayIconPath = trayIconPathWrapper()
    if (newTrayIconPath !== currentTrayIconPath) {
      appIcon.setImage(newTrayIconPath)
      currentTrayIconPath = newTrayIconPath
    }

    const newTrayMenuTemplate = getTrayMenuTemplate({
      settings,
      breakPlanner,
      global,
      i18next,
      humanizeDuration,
      skipToMicrobreak: breakControl.skipToMicrobreak,
      skipToBreak: breakControl.skipToBreak,
      resumeBreaks: breakControl.resumeBreaks,
      pauseBreaks: breakControl.pauseBreaks,
      resetBreaks: breakControl.resetBreaks,
      createPreferencesWindow,
      createContributorSettingsWindow,
      createSyncPreferencesWindow,
      app
    })
    if (JSON.stringify(newTrayMenuTemplate) !== JSON.stringify(currentTrayMenuTemplate)) {
      const trayMenu = Menu.buildFromTemplate(newTrayMenuTemplate)
      appIcon.setContextMenu(trayMenu)
      currentTrayMenuTemplate = newTrayMenuTemplate
    }
  }
}
