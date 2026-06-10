const sql = require('mssql');
const {config} = require('./config');

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientDbError(err) {
  if (!err) return false;
  if (TRANSIENT_DB_CODES.has(err.code)) return true;
  const message = `${err.message ?? ''} ${err.stack ?? ''}`;
  return TRANSIENT_DB_MESSAGES.some(pattern => message.includes(pattern));
}

function resetPoolForTransientError(err) {
  if (!isTransientDbError(err)) return;
  poolPromise = null;
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
      return result;
    } catch (err) {
      lastError = err;
      resetPoolForTransientError(err);
      if (!isTransientDbError(err) || attempt >= attempts) {
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
    const request = pool.request();

    for (const [key, value] of Object.entries(inputs)) {
      if (Array.isArray(value)) {
        request.input(key, value[0], value[1]);
      } else {
        request.input(key, value);
      }
    }

    return await request.query(query);
  });
}

async function executeProcedure(name, inputs = {}) {
  return await withDbRetry(async () => {
    const pool = await getPool();
    const request = pool.request();

    for (const [key, value] of Object.entries(inputs)) {
      if (Array.isArray(value)) {
        request.input(key, value[0], value[1]);
      } else {
        request.input(key, value);
      }
    }

    return await request.execute(name);
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
  executeProcedure,
  closePool,
  isTransientDbError
};
