const CompetitiveRatingDao = require('../db/daos/competitiveRatingDao');
const CompetitiveWhrSyncDao = require('../db/daos/competitiveWhrSyncDao');
const CONSTANTS = require('../utils/constants');
const { getKFactor, ELO_DIVISOR } = require('../utils/competitiveConstants');

const dao = new CompetitiveRatingDao();
const whrSyncDao = new CompetitiveWhrSyncDao();
const RANK_THRESHOLD_CACHE_MS = 5 * 60_000;
const LEGACY_RANK_ROLE_IDS = new Set((CONSTANTS.LEGACY_RANK_ROLE_IDS ?? []).map(String));
let rankThresholdCache = {
    expiresAt: 0,
    rows: null
};

function calculateCompetitiveEloDelta(myElo, opponentElo, score, isPlacement) {
    const expected = 1 / (1 + Math.pow(10, (opponentElo - myElo) / ELO_DIVISOR));
    return getKFactor(myElo, isPlacement) * (score - expected);
}

async function getCachedRankThresholds({ force = false } = {}) {
    const now = Date.now();
    if (!force && rankThresholdCache.rows && rankThresholdCache.expiresAt > now) {
        return rankThresholdCache.rows;
    }

    const rows = await dao.getAllRankThresholds();
    rankThresholdCache = {
        rows,
        expiresAt: now + RANK_THRESHOLD_CACHE_MS
    };
    return rows;
}

async function getDefaultCompetitiveRating() {
    const thresholds = await getCachedRankThresholds();
    const defaultThreshold = thresholds.find(row => Number(row.RankNumber) === 0);
    const defaultRating = Number(defaultThreshold?.MinElo);
    if (!Number.isFinite(defaultRating)) {
        throw new Error('CompetitiveRankThreshold rank 0 is missing; cannot determine default competitive rating');
    }
    return defaultRating;
}

function clearRankThresholdCache() {
    rankThresholdCache = {
        expiresAt: 0,
        rows: null
    };
}

async function assignCompRankRoles(client, guildId, discordId, highestRank) {
    if (!client || !guildId || !discordId) return;

    try {
        const thresholds = await getCachedRankThresholds();
        const compRoleIds = thresholds
            .map(row => row.DiscordRoleId)
            .filter(roleId => roleId && !LEGACY_RANK_ROLE_IDS.has(String(roleId)));
        const targetRoleId = thresholds.find(row => Number(row.RankNumber) === Number(highestRank))?.DiscordRoleId ?? null;
        const roleId = targetRoleId && !LEGACY_RANK_ROLE_IDS.has(String(targetRoleId))
            ? targetRoleId
            : null;
        if (!compRoleIds.length) return;

        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return;
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) return;

        const toRemove = member.roles.cache.filter(role => compRoleIds.includes(role.id));
        await Promise.all([...toRemove.values()].map(role => member.roles.remove(role).catch(() => {})));

        if (roleId) {
            await member.roles.add(roleId).catch(() => {});
        }
    } catch {
        // Rank roles are best-effort; rating writes must not depend on Discord role APIs.
    }
}

async function updateOneVOneRankRoles(changes, seasonId, client, guildId) {
    if (!client || !guildId) return;
    const uniquePlayers = new Map();
    for (const change of changes) {
        uniquePlayers.set(change.playerId, change.discordId);
    }

    await Promise.all([...uniquePlayers.entries()].map(async ([playerId, discordId]) => {
        const highestRank = await dao.getBestCompletedOneVOneRank(playerId, seasonId);
        await assignCompRankRoles(client, guildId, discordId, highestRank);
    }));
}

function scheduleOneVOneRankRoleUpdate(changes, seasonId, client, guildId) {
    setTimeout(() => {
        updateOneVOneRankRoles(changes, seasonId, client, guildId)
            .catch(error => console.warn(`[CompetitiveRating] Rank role update failed: ${error.message}`));
    }, 0).unref?.();
}

function scheduleCompetitiveWhrSync(ratedMatchId) {
    if (!ratedMatchId) return;
    setTimeout(() => {
        whrSyncDao.syncCompletedMatch({ ratedMatchId })
            .catch(error => console.warn(`[CompetitiveRating] WHR/TST sync failed: ${error.message}`));
    }, 0).unref?.();
}

async function recoverPendingCompetitiveWhrSync() {
    const results = await whrSyncDao.syncPendingCompletedMatches();
    const failed = results.filter(result => result.syncStatus === 'failed');
    if (failed.length) {
        console.warn(`[CompetitiveRating] WHR/TST sync recovery failed for ${failed.length} match(es)`);
    }
    return results;
}

async function recordCompetitiveResult({
    ratedMatchId,
    matchCode,
    seasonId,
    gameType,
    mode,
    winnerTeamNumber,
    team1Score,
    team2Score,
    homeTeamNumber,
    awayTeamNumber,
    client,
    guildId,
    skipWhrSync = false,
    completedAtUtc = null
}) {
    const season = seasonId
        ? await dao.getSeasonById(seasonId)
        : await dao.getActiveSeason();
    if (!season) return null;

    const changes = await dao.recordMatchCompletion({
        ratedMatchId,
        matchCode,
        seasonId: season.Id,
        gameType,
        mode,
        winnerTeamNumber,
        team1Score,
        team2Score,
        homeTeamNumber,
        awayTeamNumber,
        completedAtUtc
    }, calculateCompetitiveEloDelta);

    if (mode === '1v1') {
        scheduleOneVOneRankRoleUpdate(changes, season.Id, client, guildId);
    }
    if (!skipWhrSync) {
        scheduleCompetitiveWhrSync(ratedMatchId);
    }

    return {
        seasonName: season.DisplayName,
        seasonId: season.Id,
        changes
    };
}

async function rebuildRatingPartition({ seasonId, gameId, mode }) {
    return dao.rebuildRatingPartition({ seasonId, gameId, mode }, calculateCompetitiveEloDelta);
}

async function rollbackCompetitiveMatch({
    gameId,
    mode,
    matchNumber,
    reason,
    rolledBackByDiscordId,
    client,
    guildId
}) {
    const rollback = await dao.rollbackMatchByNumber({
        gameId,
        mode,
        matchNumber,
        reason,
        rolledBackByDiscordId
    }, calculateCompetitiveEloDelta);
    if (!rollback) return null;

    try {
        rollback.whrSync = await whrSyncDao.markRolledBack({ ratedMatchId: rollback.matchId });
    } catch (error) {
        rollback.whrSync = {
            syncStatus: 'failed',
            lastError: error.message
        };
        console.warn(`[CompetitiveRating] Rollback WHR/TST sync failed: ${error.message}`);
    }

    if (rollback.mode === '1v1') {
        setTimeout(() => {
            Promise.all((rollback.currentRatings ?? []).map(async rating => {
                const highestRank = await dao.getBestCompletedOneVOneRank(rating.playerId, rollback.seasonId);
                await assignCompRankRoles(client, guildId, rating.discordId, highestRank);
            })).catch(error => console.warn(`[CompetitiveRating] Rollback rank role update failed: ${error.message}`));
        }, 0).unref?.();
    }

    return rollback;
}

async function getLeaderboard(gameType, mode = '1v1') {
    const season = await dao.getActiveSeason();
    if (!season) return [];
    return dao.getLeaderboard(gameType, season.Id, mode);
}

async function getPlayerRating(discordId, gameType, mode = '1v1') {
    const season = await dao.getActiveSeason();
    if (!season) return null;
    return dao.getPlayerRating(discordId, gameType, season.Id, mode);
}

async function getPlayerRatingForSeason(discordId, gameType, seasonId, mode = '1v1') {
    if (!seasonId) return null;
    return dao.getPlayerRating(discordId, gameType, seasonId, mode);
}

async function getSeasonHistory(discordId, gameType) {
    return dao.getSeasonHistory(discordId, gameType);
}

async function getAllRankThresholds() {
    return getCachedRankThresholds();
}

async function getActiveSeason() {
    return dao.getActiveSeason();
}

async function getSeasonQueueAvailability() {
    return dao.getSeasonQueueAvailability();
}

async function beginDueSeasonEnding() {
    return dao.beginDueSeasonEnding();
}

async function finalizeDueEndingSeason() {
    return dao.finalizeDueEndingSeason();
}

async function activateDueSeason() {
    return dao.activateDueSeason();
}

function indexRatingsByMode(rows) {
    return rows.reduce((acc, row) => {
        acc[row.Mode] = row;
        return acc;
    }, {});
}

async function getAllPlayerRatings(discordId) {
    const season = await dao.getActiveSeason();
    if (!season) return null;
    const [mscRows, smsRows, msblRows] = await Promise.all([
        dao.getPlayerRatingsByGame(discordId, 1, season.Id),
        dao.getPlayerRatingsByGame(discordId, 2, season.Id),
        dao.getPlayerRatingsByGame(discordId, 3, season.Id)
    ]);
    return {
        season,
        msc: indexRatingsByMode(mscRows),
        sms: indexRatingsByMode(smsRows),
        msbl: indexRatingsByMode(msblRows)
    };
}

module.exports = {
    recordCompetitiveResult,
    rollbackCompetitiveMatch,
    assignCompRankRoles,
    getLeaderboard,
    getPlayerRating,
    getPlayerRatingForSeason,
    getActiveSeason,
    getSeasonQueueAvailability,
    beginDueSeasonEnding,
    finalizeDueEndingSeason,
    activateDueSeason,
    getAllPlayerRatings,
    getSeasonHistory,
    getAllRankThresholds,
    getDefaultCompetitiveRating,
    clearRankThresholdCache,
    calculateCompetitiveEloDelta,
    rebuildRatingPartition,
    scheduleCompetitiveWhrSync,
    recoverPendingCompetitiveWhrSync
};
