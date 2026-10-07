const sql = require('mssql');
const {config} = require('./config');
const { runRequest } = require('./requests');
const { recordQueryFailure, recordQuerySuccess } = require('./connectionHealth');

let poolPromise = null;
let circuitOpenUntil = 0;

const TRANSIENT_DB_CODES = new Set([
  'ETIMEOUT',
  'ESOCKET',
  'ECONNRESET',
  'ECONNCLOSED',
  'ENOTOPEN',
  'ELOGIN',
  'EAI_AGAIN'
]);
const TRANSIENT_DB_MESSAGES = [
  'Failed to connect',
  'Could not connect',
  'Connection lost',
  'ConnectionError',
  'Timeout',
  'timeout',
  'socket hang up'
];
// SQL Server rolls the whole batch back for a deadlock victim, so running it again is safe.
const TRANSIENT_DB_ERROR_NUMBERS = new Set([
  1205 // deadlock victim
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientDbError(err) {
  if (!err) return false;
  if (TRANSIENT_DB_CODES.has(err.code)) return true;
  if (TRANSIENT_DB_ERROR_NUMBERS.has(Number(err.number))) return true;
  const message = `${err.message ?? ''} ${err.stack ?? ''}`;
  return TRANSIENT_DB_MESSAGES.some(pattern => message.includes(pattern));
}

// After a transient error new requests wait briefly (circuit breaker) instead of hammering an
// unreachable server. The pool itself stays: it drops broken connections and opens new ones.
function openCircuitForTransientError(err) {
  if (!isTransientDbError(err)) return;
  circuitOpenUntil = Date.now() + Number(process.env.DB_CIRCUIT_OPEN_MS ?? 10000);
}

async function waitForCircuit() {
  const waitMs = circuitOpenUntil - Date.now();
  if (waitMs > 0) {
    await sleep(Math.min(waitMs, Number(process.env.DB_CIRCUIT_MAX_WAIT_MS ?? 2000)));
  }
}

async function withDbRetry(operation) {
  const attempts = Math.max(1, Number(process.env.DB_TRANSIENT_RETRY_ATTEMPTS ?? 3));
  const baseDelayMs = Math.max(0, Number(process.env.DB_TRANSIENT_RETRY_BASE_MS ?? 250));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await waitForCircuit();
      const result = await operation();
      circuitOpenUntil = 0;
      recordQuerySuccess();
      return result;
    } catch (err) {
      lastError = err;
      openCircuitForTransientError(err);
      if (!isTransientDbError(err) || attempt >= attempts) {
        recordQueryFailure(err);
        throw err;
      }
      await sleep(baseDelayMs * attempt);
    }
  }

  throw lastError;
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(config).catch((err) => {
      poolPromise = null;
      throw err;
    });
  }

  return poolPromise;
}

async function executeQuery(query, inputs = {}) {
  return await withDbRetry(async () => {
    const pool = await getPool();
    return await runRequest(pool, query, inputs);
  });
}

async function closePool() {
  if (!poolPromise) return;
  const pool = await poolPromise;
  poolPromise = null;
  await pool.close();
}

module.exports = {
  sql,
  getPool,
  executeQuery,
  closePool,
  isTransientDbError
};
