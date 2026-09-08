# Authentication module integration contract

Status: module slice only. The running Agent Chatroom application is **not authenticated** until a later integration assignment wires these exports into configuration, HTTP routes, SSE and the browser.

This slice has no dependency on `RunStore`, persistence, model providers, browser code or third-party packages.

## Exports

### `server/auth-config.ts`

`parseAuthConfig(input)` is pure and reads only the object passed by its caller. It does not read `process.env`, `.env` or credential storage.

Inputs:

| Setting | Default | Contract |
| --- | --- | --- |
| `AUTH_MODE` | `local` | `local` or `session` |
| `HOST` | `127.0.0.1` | `local` accepts only `127.0.0.1`, `::1` or `localhost` |
| `AGENT_CHAT_OPERATOR_TOKEN` | none | Required in `session`; unpadded base64url encoding of at least 32 bytes, at most 128 characters |
| `PUBLIC_ORIGIN` | none | Required in `session`; exact HTTP(S) origin with no credentials, path, query or fragment |
| `AUTH_SESSION_TTL_SECONDS` | `28800` | Absolute lifetime, 300 through 86400 seconds |

Non-loopback HTTP origins are rejected. HTTP session mode exists only for an explicitly configured loopback test/development fixture. HTTPS uses the `__Host-agent_chat_session` cookie name; loopback HTTP uses `agent_chat_session`.

Encoding and length checks do not prove entropy. The operator token must be created from a cryptographically random source and placed in runtime secret storage. A suitable generation primitive is Node `crypto.randomBytes(32).toString('base64url')`; do not commit, log or put the result in a URL.

### `server/auth.ts`

`createAuthService(config, options?)` returns:

```ts
interface AuthService {
  readonly mode: 'local' | 'session'
  authenticate(credentials?: AuthRequestCredentials): AuthenticationResult
  status(credentials?: AuthRequestCredentials): AuthStatusPayload
  issueSession(authorization: AuthHeaderValue): SessionIssueResult
  clearSessionCookie(): string | null
  revoke(principal: AuthPrincipal): boolean
  onInvalidated(principal: AuthPrincipal, listener: () => void): () => void
  activeSessionCount(): number
  dispose(): void
}
```

Credential policy in session mode is fail closed:

1. A malformed Authorization or Cookie header fails.
2. A target session cookie plus a bearer credential is ambiguous and fails; neither silently wins.
3. A single valid target cookie resolves to a process-local session.
4. Otherwise a single valid `Authorization: Bearer ...` is compared with the operator-token digest.
5. Missing, invalid, expired and revoked credentials all return the same `{ ok: false }` result.

The service hashes the configured operator token at construction and keeps only SHA-256 session-ID digests in a bounded process-local map. Session IDs come from 32 bytes of Node cryptographic randomness. Comparisons operate on fixed-length digests with `timingSafeEqual`.

Defaults are 16 active sessions and a fixed-memory global login bucket of five attempts, replenishing one attempt every 12 seconds. The throttle does not use `X-Forwarded-For` or allocate attacker-selected keys. `AuthServiceOptions` exposes deterministic clock, randomness and timer seams plus smaller bounds for tests; production callers should use the defaults.

Sessions have an absolute, non-sliding expiry. `revoke`, expiry and `dispose` clear the timer and synchronously notify every registered session listener once. Authenticated bearer and local principals may also register lifecycle listeners; they have no individual expiry or revocation, so those listeners fire only when the service is disposed. Listener errors are isolated, unsubscribe and repeated disposal are idempotent, and registration after disposal is invalidated immediately. A new service instance has an empty map, so process restart invalidates every old session.

HTTPS Set-Cookie output is:

```text
__Host-agent_chat_session=<opaque>; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=<ttl>
```

There is no `Domain` attribute. `clearSessionCookie()` returns the matching cookie with an empty value and `Max-Age=0`.

The `status()` payload contains only mode, authenticated state and an optional ISO expiry. It never contains an operator token, cookie, session ID or internal digest.

### `server/request-security.ts`

`evaluateRequestSecurity(config, policy, input)` is a pure policy function for these explicit route categories:

- `auth-status`
- `login`
- `logout`
- `protected-read`
- `protected-mutation`

It accepts only direct `Host`, `Origin`, `Sec-Fetch-Site`, the authenticated credential kind and whether Node itself terminated TLS. It intentionally has no `X-Forwarded-*` input.

Rules:

- Local mode accepts only loopback request hosts. A non-loopback Host remains denied even if forwarding headers claim loopback.
- Session mode requires Host to match `PUBLIC_ORIGIN.host` exactly, including a non-default port.
- A supplied Origin must equal the expected serialized origin exactly, including scheme and port. `null`, credentials, paths and duplicate header arrays fail.
- `Sec-Fetch-Site: cross-site` and malformed Fetch Metadata fail.
- Cookie-authenticated mutations require exact Origin. Valid bearer CLI mutations and intended local loopback curl may omit browser headers.
- Login allows a headerless non-browser request to reach bearer validation, but rejects any supplied mismatched/cross-site Origin.
- Logout has its own session/bearer and Origin policy. A session-mode logout with no authenticated principal is allowed only with exact Host and Origin plus valid non-cross-site Fetch Metadata, enabling safe cookie clearing after expiry or a repeated logout without creating an anonymous headerless exception.
- The module grants no CORS response headers.

Callers should map every request-policy failure to one generic 403 without echoing the received Host or Origin.

## Required HTTP integration order

The later integration worker should make the following changes in existing shared files; they are intentionally not part of this module PR.

1. `server/config.ts`: call `parseAuthConfig(env)` with the already selected `HOST` value and add the result to `ServerConfig` without logging/serializing `operatorToken`.
2. `server/index.ts`: create one `AuthService`, pass it to `createServer`, include only mode/public origin in the startup banner and call `dispose()` during shutdown.
3. `server/http.ts`: add auth route metadata and route constants. Validate request policy before handler side effects/body reads. Protect every current state/SSE/command route in session mode.
4. Login: evaluate the `login` request policy, then pass only the Authorization header to `issueSession`. Map `denied` to generic 401 plus `WWW-Authenticate: Bearer realm="Agent Chatroom"`, `rate_limited` to 429/`Retry-After`, and capacity/unavailable to a generic 503. Set the returned cookie only on success.
5. Protected routes: call `authenticate`, pass the resulting principal kind into the appropriate request policy, then invoke the existing handler. A missing/invalid auth result is generic 401. Existing validation/budget/rate behavior applies only after auth.
6. Logout: authenticate if possible, apply `logout` policy even when authentication returns no principal, revoke a session principal when present, clear the cookie and return an idempotent success. The null-principal path succeeds only with the strict same-origin browser policy above. A direct bearer has no individual session to revoke; rotating the secret and restarting is the revoke-all operation.
7. SSE: authenticate and apply `protected-read` before sending status 200 or a snapshot. Register `onInvalidated(principal, close)` and unsubscribe it during ordinary stream cleanup. Session expiry/logout and service disposal close session streams; disposal also closes registered bearer and local streams. Every reconnect authenticates again.
8. Request logging: log only the parsed pathname. Never log raw query strings, Authorization or Cookie.
9. `shared/protocol.ts`: add only the auth route constants/error shape required by the wire; detailed browser-safe auth payload types already live in `shared/auth.ts`.
10. Browser: add an auth-status/login/logout client and gate before mounting `useRun`. Keep the operator token only in component memory. On SSE failure, probe auth status; a lost session clears the snapshot and stops reconnect churn.

Actual 401 wire behavior, full route coverage, EventSource behavior, browser storage inspection and application-level authentication remain integration acceptance checks. This module slice must not be used as evidence that the current server is protected.

## Trust limits

- Local bind and Host checks reduce accidental direct exposure. They cannot prove that an external proxy has not rewritten a remote Host to a loopback value. Local mode is not proxy-proof authentication.
- Remote mode requires an HTTPS public origin, but this Node module does not terminate TLS, configure a proxy or validate hosting.
- Forwarding headers are untrusted unless a future, explicit proxy trust model is implemented.
- Direct bearer access remains valid until the operator token is rotated and the process restarted; it is not individually revocable.
- Sessions are intentionally ephemeral and single-operator. There is no persistence, user database, RBAC, MFA, account recovery or SaaS identity integration.
- This does not protect against a compromised host, malicious same-origin JavaScript or browser extensions with host permission.

## Offline verification

```sh
node --import tsx --test tests/auth.test.ts tests/request-security.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

All tests use synthetic credentials, injected time/randomness/timers and local data only. Do not run real-provider smoke or acceptance commands as part of auth module verification.
