const sql = require('mssql');
const {config} = require('./config');

let poolPromise = null;

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
  const pool = await getPool();
  const request = pool.request();

  for (const [key, value] of Object.entries(inputs)) {
    if (Array.isArray(value)) {
      request.input(key, value[0], value[1]);
    } else {
      request.input(key, value);
    }
  }

  try {
    return await request.query(query);
  } catch (err) {
    if (err.code === 'ENOTOPEN' || err.code === 'ESOCKET' || err.code === 'ECONNRESET') {
      poolPromise = null;
    }
    throw err;
  }
}

async function executeProcedure(name, inputs = {}) {
  const pool = await getPool();
  const request = pool.request();

  for (const [key, value] of Object.entries(inputs)) {
    if (Array.isArray(value)) {
      request.input(key, value[0], value[1]);
    } else {
      request.input(key, value);
    }
  }

  try {
    return await request.execute(name);
  } catch (err) {
    if (err.code === 'ENOTOPEN' || err.code === 'ESOCKET' || err.code === 'ECONNRESET') {
      poolPromise = null;
    }
    throw err;
  }
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
  closePool
};
