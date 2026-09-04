/**
 * The 24-case passkey e2e suite the simulated `pnpm e2e` runs. Case outcomes
 * are derived from the working tree in workspace.ts; this file only fixes the
 * names, order and browser projects so output is stable run to run.
 */

export type E2eBrowser = 'chromium' | 'webkit' | 'windows-hello'

export interface E2eCase {
  /** `register.*` or `login.*`, as the design shows them. */
  name: string
  group: 'register' | 'login'
  browser: E2eBrowser
}

const c = (name: string, group: E2eCase['group'], browser: E2eBrowser = 'chromium'): E2eCase => ({ name, group, browser })

export const E2E_SUITE_FILE = 'e2e/passkey.spec.ts'

export const E2E_CASES: readonly E2eCase[] = [
  c('register.chrome', 'register'),
  c('register.safari', 'register', 'webkit'),
  c('register.windowsHello', 'register', 'windows-hello'),
  c('register.reregister', 'register'),
  c('register.residentKey', 'register'),
  c('register.attestationNone', 'register', 'webkit'),
  c('register.originMismatch', 'register'),
  c('register.duplicateCredId', 'register', 'windows-hello'),
  c('register.userVerification', 'register'),
  c('register.flagOff', 'register'),
  c('register.challengeExpired', 'register', 'webkit'),
  c('register.rateLimit', 'register'),
  c('login.chrome', 'login'),
  c('login.safari', 'login', 'webkit'),
  c('login.windowsHello', 'login', 'windows-hello'),
  c('login.signCountIncrement', 'login'),
  c('login.unknownCred', 'login'),
  c('login.badSignature', 'login', 'webkit'),
  c('login.challengeExpired', 'login'),
  c('login.flagOff', 'login'),
  c('login.sessionIssued', 'login'),
  c('login.discoverable', 'login', 'windows-hello'),
  c('login.replayRejected', 'login'),
  c('login.userVerification', 'login', 'webkit'),
]
