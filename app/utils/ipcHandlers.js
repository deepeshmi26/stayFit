import { BrowserWindow, ipcMain, dialog, app } from 'electron'
import { writeFile } from 'node:fs'
import { join } from 'path'
import { DateTime } from 'luxon'
import log from 'electron-log/main.js'
import { formatTimeRemaining, insideWindowsStore } from './utils.js'
import { resolveLocalImage } from './imageResolver.js'
import { getSettings } from './settings.js'
/**
 * Register all IPC handlers
 */
export function registerIpcHandlers ({
  postponeMicrobreak,
  postponeBreak,
  finishMicrobreak,
  finishBreak,
  breakPlanner,
  i18next,
  nativeTheme,
  autostartManager,
  updateTray,
  createPreferencesWindow,
  createContributorSettingsWindow,
  createSyncPreferencesWindow,
  createMyStretchlyWindow,
  getMyStretchlyWin,
  setMyStretchlyWin,
  getPreferencesWin,
  initialize,
  defaultSettings,
  processWin,
  humanizeDuration,
  displayManager,
  windowIconPath,
  global
}) {
  const settings = getSettings()

  ipcMain.on('set-global-value', (event, name, value) => {
    global[name] = value
  })

  ipcMain.handle('get-global-value', (event, name) => {
    return global[name]
  })

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
        // Will be handled by caller
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
    const preferencesWin = getPreferencesWin()
    if (preferencesWin) {
      preferencesWin.webContents.send('enable-contributor-preferences')
    }
    updateTray()
  })

  ipcMain.on('open-contributor-preferences', function () {
    createContributorSettingsWindow()
  })

  ipcMain.on('open-contributor-auth', function (event, provider) {
    let myStretchlyWin = getMyStretchlyWin()
    if (myStretchlyWin) {
      myStretchlyWin.show()
      return
    }
    myStretchlyWin = createMyStretchlyWindow({ __dirname: join(app.getAppPath(), 'app'), displayManager, windowIconPath, provider })
    myStretchlyWin.once('closed', () => {
      setMyStretchlyWin(null)
    })
    setMyStretchlyWin(myStretchlyWin)
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
}
