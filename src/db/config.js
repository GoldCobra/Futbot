require('dotenv').config({ quiet: true })

const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    // From .env, so a move of the database by the host is a configuration change, not a code change.
    server: process.env.DB_SERVER,
    port: Number(process.env.DB_PORT ?? 1433),
    database: 'MarioStrikers',
    // A fresh login to the external server takes ~2 s and sometimes over 15 s (measured 2026-10-07):
    // aborting at 15 s and starting over only makes it worse. Idle connections are kept for 10 minutes,
    // so the one-minute queue tick reuses a connection instead of logging in again every time.
    connectionTimeout: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 30000),
    requestTimeout: Number(process.env.DB_REQUEST_TIMEOUT_MS ?? 30000),
    pool: {
        max: Number(process.env.DB_POOL_MAX ?? 10),
        min: Number(process.env.DB_POOL_MIN ?? 0),
        idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? 600000)
    },
    options: {
        encrypt: true,
        trustServerCertificate: true,
        cryptoCredentialsDetails: {
              minVersion: 'TLSv1.2'
          }
    }
}

module.exports = {config}
