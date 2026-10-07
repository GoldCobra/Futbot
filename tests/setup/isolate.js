'use strict';

// Runs before every test file (jest setupFiles). Tests must never reach the
// production database or Discord, even when a local .env holds real
// credentials: dotenv leaves variables that already exist untouched, and any
// socket to a host other than loopback fails like an unreachable server.
const net = require('net');

for (const name of ['DB_USER', 'DB_PASS', 'BOT_TOKEN', 'FUTBOT_TOKEN', 'MODMAIL_TOKEN', 'START_GG_TOKEN']) {
    process.env[name] = '';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
const GUARD = Symbol.for('mario-strikers.tests.networkGuard');

function connectOptions(args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (first && typeof first === 'object') return first;
    return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
}

if (!net.Socket.prototype[GUARD]) {
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function guardedConnect(...args) {
        const options = connectOptions(args);
        const host = options.host ?? 'localhost';
        if (options.path || LOOPBACK_HOSTS.has(host)) {
            return connect.apply(this, args);
        }
        const error = new Error(`Tests must not open network connections (attempted ${host}:${options.port}); see tests/setup/isolate.js.`);
        error.code = 'ETESTNETWORK';
        process.nextTick(() => this.destroy(error));
        return this;
    };
    net.Socket.prototype[GUARD] = true;
}
