import { shell } from 'electron'
import { join } from 'path'
import AppIcon from './appIcon.js'
import StatusMessages from './statusMessages.js'
import { UntilMorning } from './untilMorning.js'
import { minutesRemaining } from './utils.js'

/**
 * Get tray icon path
 */
export function trayIconPath ({ breakPlanner, settings, nativeTheme, __dirname }) {
  const params = {
    paused:
      breakPlanner.isPaused ||
      breakPlanner.dndManager.isOnDnd ||
      breakPlanner.naturalBreaksManager.isSchedulerCleared ||
      breakPlanner.appExclusionsManager.isSchedulerCleared,
    monochrome: settings.get('useMonochromeTrayIcon'),
    inverted: settings.get('useMonochromeInvertedTrayIcon'),
    darkMode: nativeTheme.shouldUseDarkColors,
    platform: process.platform,
    trayIconStyle: settings.get('trayIconStyle'),
    timeToBreak: minutesRemaining(breakPlanner.timeToNextBreak),
    percentage: breakPlanner.progressPercentage,
    reference: breakPlanner.scheduler.reference
  }
  const trayIconFileName = new AppIcon(params).trayIconFileName
  const pathToTrayIcon = join(__dirname, '/images/app-icons/', trayIconFileName)
  return pathToTrayIcon
}

/**
 * Get window icon path
 */
export function windowIconPath ({ settings, nativeTheme, __dirname }) {
  const unusedParams = null
  const params = {
    paused: false,
    monochrome: settings.get('useMonochromeTrayIcon'),
    inverted: settings.get('useMonochromeInvertedTrayIcon'),
    darkMode: nativeTheme.shouldUseDarkColors,
    platform: unusedParams,
    timeToBreakInTrayString: unusedParams,
    reference: unusedParams
  }
  const windowIconFileName = new AppIcon(params).windowIconFileName
  return join(__dirname, '/images/app-icons', windowIconFileName)
}

/**
 * Update tooltip
 */
export function updateToolTip ({ appIcon, breakPlanner, settings, i18next, humanizeDuration }) {
  let trayMessage = i18next.t('main.toolTipHeader')
  const message = new StatusMessages({
    breakPlanner,
    settings,
    i18next,
    humanizeDuration
  }).trayMessage
  if (message !== '') {
    trayMessage += '\n\n' + message
  }
  if (appIcon) {
    appIcon.setToolTip(trayMessage)
  }
}

/**
 * Get tray menu template
 */
export function getTrayMenuTemplate ({
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
}) {
  const trayMenu = []

  if (!settings.get('disableAppUpdateFeatures') && global.isNewVersion) {
    trayMenu.push({
      label: i18next.t('main.downloadLatestVersion'),
      click: function () {
        shell.openExternal('https://hovancik.net/stretchly/downloads')
      }
    }, {
      type: 'separator'
    })
  }

  const statusMessage = new StatusMessages({
    breakPlanner,
    settings,
    i18next,
    humanizeDuration
  }).trayMessage

  if (statusMessage !== '') {
    const messages = statusMessage.split('\n')
    for (const index in messages) {
      trayMenu.push({
        label: messages[index],
        enabled: false
      })
    }

    trayMenu.push({
      type: 'separator'
    })
  }

  if ((breakPlanner.scheduler.reference === 'finishMicrobreak' && settings.get('microbreakStrictMode') &&
    !settings.get('showTrayMenuInStrictMode')) ||
    (breakPlanner.scheduler.reference === 'finishBreak' && settings.get('breakStrictMode') &&
      !settings.get('showTrayMenuInStrictMode'))
  ) {
    // empty menu, we are in strict mode
    return trayMenu
  }

  if (!(breakPlanner.isPaused || breakPlanner.dndManager.isOnDnd || breakPlanner.appExclusionsManager.isSchedulerCleared)) {
    let submenu = []
    if (settings.get('microbreak')) {
      submenu = submenu.concat([{
        label: i18next.t('main.toMicrobreak'),
        click: () => skipToMicrobreak()
      }])
    }
    if (settings.get('break')) {
      submenu = submenu.concat([{
        label: i18next.t('main.toBreak'),
        click: () => skipToBreak()
      }])
    }
    if (settings.get('break') || settings.get('microbreak')) {
      trayMenu.push({
        label: i18next.t('main.skipToTheNext'),
        submenu
      })
    }
  }

  if (breakPlanner.isPaused) {
    trayMenu.push({
      label: i18next.t('main.resume'),
      click: function () {
        resumeBreaks(false)
      }
    })
  } else if (!(breakPlanner.dndManager.isOnDnd || breakPlanner.appExclusionsManager.isSchedulerCleared)) {
    trayMenu.push({
      label: i18next.t('main.pause'),
      submenu: [
        {
          label: i18next.t('utils.minutes', { count: 30 }),
          accelerator: settings.get('pauseBreaksFor30MinutesShortcut') || null,
          click: function () {
            pauseBreaks(1800 * 1000)
          }
        }, {
          label: i18next.t('main.forHour'),
          accelerator: settings.get('pauseBreaksFor1HourShortcut') || null,
          click: function () {
            pauseBreaks(3600 * 1000)
          }
        }, {
          label: i18next.t('main.for2Hours'),
          accelerator: settings.get('pauseBreaksFor2HoursShortcut') || null,
          click: function () {
            pauseBreaks(3600 * 2 * 1000)
          }
        }, {
          label: i18next.t('main.for5Hours'),
          accelerator: settings.get('pauseBreaksFor5HoursShortcut') || null,
          click: function () {
            pauseBreaks(3600 * 5 * 1000)
          }
        }, {
          label: i18next.t('main.untilMorning'),
          accelerator: settings.get('pauseBreaksUntilMorningShortcut') || null,
          click: function () {
            const untilMorning = new UntilMorning(settings).msToSunrise()
            pauseBreaks(untilMorning)
          }
        }, {
          type: 'separator'
        }, {
          label: i18next.t('main.indefinitely'),
          click: function () {
            pauseBreaks(1)
          }
        }
      ]
    }, {
      label: i18next.t('main.resetBreaks'),
      click: resetBreaks
    })
  }

  trayMenu.push({
    type: 'separator'
  }, {
    label: i18next.t('main.preferences'),
    click: function () {
      createPreferencesWindow()
    }
  })

  if (global.isContributor) {
    trayMenu.push({
      label: i18next.t('main.contributorPreferences'),
      click: function () {
        createContributorSettingsWindow()
      }
    }, {
      label: i18next.t('main.syncPreferences'),
      click: function () {
        createSyncPreferencesWindow()
      }
    })
  }

  trayMenu.push({
    type: 'separator'
  }, {
    label: i18next.t('main.quitStretchly'),
    role: 'quit',
    click: function () {
      app.quit()
    }
  })

  return trayMenu
}

/**
 * Update tray icon and menu
 * Note: This function needs access to module-level state, so it's kept as a factory
 * that returns a function bound to the state
 */
export function createUpdateTrayFunction ({
  app,
  settings,
  getAppIcon,
  setAppIcon,
  getCurrentTrayIconPath,
  setCurrentTrayIconPath,
  getCurrentTrayMenuTemplate,
  setCurrentTrayMenuTemplate,
  getTrayUpdateIntervalObj,
  setTrayUpdateIntervalObj,
  trayIconPath,
  getTrayMenuTemplate,
  updateToolTip,
  createPreferencesWindow,
  Menu,
  Tray
}) {
  return function updateTray () {
    if (process.platform === 'darwin') {
      if (app.dock.isVisible) {
        app.dock.hide()
      }
    }

    const appIcon = getAppIcon()
    if (!appIcon && !settings.get('showTrayIcon')) {
      return
    }

    if (settings.get('showTrayIcon')) {
      if (!appIcon) {
        const newAppIcon = new Tray(trayIconPath())
        newAppIcon.on('double-click', () => {
          createPreferencesWindow()
        })
        newAppIcon.on('click', () => {
          newAppIcon.popUpContextMenu(Menu.buildFromTemplate(getCurrentTrayMenuTemplate() || []))
        })
        setAppIcon(newAppIcon)
      }
      const trayUpdateIntervalObj = getTrayUpdateIntervalObj()
      if (!trayUpdateIntervalObj) {
        const interval = setInterval(updateTray, 10000)
        setTrayUpdateIntervalObj(interval)
      }

      updateToolTip()

      const newTrayIconPath = trayIconPath()
      const currentTrayIconPath = getCurrentTrayIconPath()
      if (newTrayIconPath !== currentTrayIconPath) {
        appIcon.setImage(newTrayIconPath)
        setCurrentTrayIconPath(newTrayIconPath)
      }

      const newTrayMenuTemplate = getTrayMenuTemplate()
      const currentTrayMenuTemplate = getCurrentTrayMenuTemplate()
      if (JSON.stringify(newTrayMenuTemplate) !== JSON.stringify(currentTrayMenuTemplate)) {
        const trayMenu = Menu.buildFromTemplate(newTrayMenuTemplate)
        appIcon.setContextMenu(trayMenu)
        setCurrentTrayMenuTemplate(newTrayMenuTemplate)
      }
    }
  }
}
