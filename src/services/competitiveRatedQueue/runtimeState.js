const fs = require('node:fs/promises');
const path = require('node:path');

const RUNTIME_STATE_VERSION = 1;
const RUNTIME_STATE_FILE = 'competitive-rated-runtime.json';

function isRuntimeStateEnabled() {
    return process.env.NODE_ENV !== 'test' || process.env.FUTBOT_RUNTIME_STATE_TEST === '1';
}

function getRuntimeDir() {
    return process.env.FUTBOT_RUNTIME_DIR || path.join(process.cwd(), 'runtime');
}

function getRuntimeStatePath() {
    return path.join(getRuntimeDir(), RUNTIME_STATE_FILE);
}

function serializeMap(map) {
    return map instanceof Map ? [...map.entries()] : [];
}

function serializeMatch(match) {
    return {
        ...match,
        timeoutTimer: null,
        homeSelectionTimer: null,
        awaySelectionTimer: null,
        notificationInteractions: [],
        privateDeliveryInteractionsByUserId: [],
        privatePromptHandles: {},
        participantIdByDiscordId: serializeMap(match.participantIdByDiscordId),
        recoveredRuntimeTimeoutPhase: match.timeoutPhase ?? null,
        recoveredRuntimeTimeoutDeadlineAt: match.timeoutDeadlineAt ?? null
    };
}

function hydrateMatch(raw) {
    if (!raw?.id || !raw?.threadId || !Array.isArray(raw?.teams) ||
        !raw.teams.every(t => Array.isArray(t?.memberIds))) {
        return null;
    }

    return {
        ...raw,
        timeoutPhase: null,
        timeoutDeadlineAt: null,
        timeoutTimer: null,
        homeSelectionTimer: null,
        awaySelectionTimer: null,
        homeSelectionDeadlineAt: null,
        awaySelectionDeadlineAt: null,
        notificationInteractions: new Map(),
        privateDeliveryInteractionsByUserId: new Map(),
        privatePromptHandles: {},
        participantIdByDiscordId: new Map(raw.participantIdByDiscordId ?? []),
        startClickedUserIds: Array.isArray(raw.startClickedUserIds) ? raw.startClickedUserIds : [],
        gameBlocks: Array.isArray(raw.gameBlocks) ? raw.gameBlocks : [],
        score: raw.score ?? { team1: 0, team2: 0 }
    };
}

async function saveCompetitiveRatedRuntimeState({ activeMatches = [], pendingCompetitiveDbOps = [] } = {}) {
    if (!isRuntimeStateEnabled()) {
        return false;
    }

    const runtimeDir = getRuntimeDir();
    await fs.mkdir(runtimeDir, { recursive: true });
    const statePath = getRuntimeStatePath();
    const tempPath = `${statePath}.tmp`;
    const payload = {
        version: RUNTIME_STATE_VERSION,
        savedAt: new Date().toISOString(),
        activeMatches: activeMatches.map(serializeMatch),
        pendingCompetitiveDbOps
    };
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, statePath);
    return true;
}

async function loadCompetitiveRatedRuntimeState() {
    if (!isRuntimeStateEnabled()) {
        return {
            activeMatches: [],
            pendingCompetitiveDbOps: []
        };
    }

    const statePath = getRuntimeStatePath();
    let rawText;
    try {
        rawText = await fs.readFile(statePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {
                activeMatches: [],
                pendingCompetitiveDbOps: []
            };
        }
        throw error;
    }

    let payload;
    try {
        payload = JSON.parse(rawText);
    } catch {
        console.error('[RatedQueue] Runtime state file is malformed — starting fresh.');
        return { activeMatches: [], pendingCompetitiveDbOps: [] };
    }
    if (payload?.version !== RUNTIME_STATE_VERSION) {
        console.error(`[RatedQueue] Runtime state version mismatch (found ${payload?.version}, expected ${RUNTIME_STATE_VERSION}) — starting fresh.`);
        return { activeMatches: [], pendingCompetitiveDbOps: [] };
    }

    return {
        activeMatches: (payload.activeMatches ?? []).map(hydrateMatch).filter(Boolean),
        pendingCompetitiveDbOps: (payload.pendingCompetitiveDbOps ?? []).filter(op => op?.key)
    };
}

module.exports = {
    getRuntimeStatePath,
    isRuntimeStateEnabled,
    loadCompetitiveRatedRuntimeState,
    saveCompetitiveRatedRuntimeState
};
