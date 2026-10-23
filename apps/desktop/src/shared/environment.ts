/** Installed identities. The host's half (data folder, port, service names) mirrors serve/host/src/environment.rs. */
export function environmentProfile(environment: 'main' | 'dev') {
  const dev = environment === 'dev'
  return {
    environment,
    name: dev ? 'Kith Dev' : 'Kith',
    appId: dev ? 'com.yingkailiao.kith.dev' : 'com.yingkailiao.kith',
    scheme: dev ? 'kith-dev' : 'kith',
    dataFolder: dev ? '.kith/serve' : '.kith/serve-main',
    port: dev ? 19224 : 19225,
    hostLabel: dev ? 'dev.kith.serve' : 'dev.kith.serve.main',
    systemdUnit: dev ? 'kith-serve.service' : 'kith-serve-main.service',
    windowsService: dev ? 'KithServe' : 'KithServeMain',
    supervisor: dev ? 'kith-servew.exe' : 'kith-servew-main.exe',
    screenLabel: dev ? 'com.yingkailiao.kith.dev.screen' : 'com.yingkailiao.kith.screen',
    screenName: dev ? 'KithDevScreen' : 'KithScreen',
    releaseUpdates: !dev,
  }
}

/** Refuse to manage a different environment's daemon, including pre-isolation dev hosts. */
export function hostEnvironmentError(expected: 'main' | 'dev', actual?: string): string | null {
  if (actual === expected || (expected === 'main' && actual === undefined)) return null
  return `This ${expected === 'dev' ? 'Kith Dev' : 'Kith'} app found a host from ${actual ?? 'an unidentified environment'}. Start the matching host on its own port.`
}
