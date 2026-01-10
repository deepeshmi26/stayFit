import { join } from 'path'
import i18next from 'i18next'
import Backend from 'i18next-fs-backend'
import log from 'electron-log/main.js'
import IdeasLoader from './ideasLoader.js'

/**
 * Start i18next
 */
export function startI18next ({ settings, __dirname }) {
  i18next
    .use(Backend)
    .init({
      lng: settings.get('language'),
      fallbackLng: 'en',
      debug: !process.env.NODE_ENV || process.env.NODE_ENV === 'development',
      backend: {
        loadPath: join(__dirname, '/locales/{{lng}}.json'),
        jsonIndent: 2
      }
    }, function (err, t) {
      if (err) {
        log.error(err.stack)
      }
    })
}

/**
 * Load break ideas
 */
export function loadIdeas ({ settings, i18next }) {
  let longBreakIdeasData
  let miniBreakIdeasData
  if (settings.get('useIdeasFromSettings')) {
    longBreakIdeasData = settings.get('breakIdeas')
    miniBreakIdeasData = settings.get('microbreakIdeas')
    log.info('Stretchly: loading custom break ideas from preferences file')
  } else {
    const t = i18next.getFixedT('en')
    miniBreakIdeasData = Object.keys(t('miniBreakIdeas',
      { returnObjects: true }))
      .map((item) => {
        return { data: i18next.t(`miniBreakIdeas.${item}.text`), enabled: true }
      })

    longBreakIdeasData = Object.keys(t('longBreakIdeas',
      { returnObjects: true }))
      .map((item) => {
        return { data: [i18next.t(`longBreakIdeas.${item}.title`), i18next.t(`longBreakIdeas.${item}.text`)], enabled: true }
      })
    log.info('Stretchly: loading default break ideas')
  }

  return {
    breakIdeas: new IdeasLoader(longBreakIdeasData).ideas(),
    microbreakIdeas: new IdeasLoader(miniBreakIdeasData).ideas()
  }
}

/**
 * Plan version check
 */
export function planVersionCheck ({ seconds, settings, processWin, app, updateChecker, setUpdateChecker }) {
  if (settings.get('disableAppUpdateFeatures')) return
  if (updateChecker) {
    clearInterval(updateChecker)
    setUpdateChecker(null)
  }
  const checker = setTimeout(() => {
    checkVersion({ settings, processWin, app })
  }, seconds * 1000)
  setUpdateChecker(checker)
}

/**
 * Check version
 */
export function checkVersion ({ settings, processWin, app }) {
  if (settings.get('disableAppUpdateFeatures')) return
  if (settings.get('checkNewVersion')) {
    processWin.webContents.send('check-version',
      `v${app.getVersion()}`,
      settings.get('notifyNewVersion'),
      settings.get('silentNotifications')
    )
    planVersionCheck({ seconds: 3600 * 48, settings, processWin, app, updateChecker: null, setUpdateChecker: () => {} })
  }
}
