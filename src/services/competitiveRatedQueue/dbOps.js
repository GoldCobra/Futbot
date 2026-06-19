const { recordCompetitiveResult } = require('../competitiveRating');
const { COMP_RANK_EMOJIS } = require('../../utils/competitiveConstants');
const RatedMatchDao = require('../../db/daos/ratedMatchDao');
const ratedMatchDao = new RatedMatchDao();
const {
    ARROW_EMOJI,
    BL_CHECK_EMOJI,
    BL_TIME_EMOJI,
    CONSTANTS
} = require('./constants');
const { buildThreadTextPayload } = require('./formatting');
const { createId, getMatchLogDetails, scheduleRuntimeStatePersist } = require('./core');
const { logRatedError, logRatedInfo, logRatedWarn } = require('./runtimeLogger');
const { state } = require('./state');
const { editOrSendRequiredThreadMessage } = require('./threadMessages');

function getCompetitiveDbOpKey(type, payload) {
    if (type === 'record_game') {
        return `${type}:${payload.ratedMatchId}:${payload.gameNumber}`;
    }
    if (type === 'complete_competitive') {
        return `${type}:${payload.ratedMatchId}`;
    }
    return `${type}:${payload.matchCode ?? payload.ratedMatchId ?? createId()}`;
}

function enqueueCompetitiveDbOp(type, payload, match, client, reason) {
    const key = getCompetitiveDbOpKey(type, payload);
    const existing = state.pendingCompetitiveDbOpsByKey.get(key);
    const op = existing ?? {
        key,
        type,
        payload,
        matchId: match?.id ?? payload.matchCode ?? null,
        threadId: match?.threadId ?? payload.threadId ?? null,
        createdAt: Date.now(),
        attempts: 0,
        lastError: null,
        nextRetryAt: Date.now()
    };
    op.payload = payload;
    op.reason = reason;
    op.updatedAt = Date.now();
    state.pendingCompetitiveDbOpsByKey.set(key, op);
    if (match) {
        match.competitiveDbPending = true;
    }
    logRatedWarn(client, match ?? { all: true }, 'competitive_db.op_queued', getMatchLogDetails(match, {
        key,
        type,
        reason
    }));
    scheduleRuntimeStatePersist('competitive_db_op_queued');
    return op;
}

function hasPendingCompetitiveDbOpsForMatch(match) {
    if (!match?.ratedMatchId) return false;
    return [...state.pendingCompetitiveDbOpsByKey.values()]
        .some(op => Number(op.payload?.ratedMatchId) === Number(match.ratedMatchId));
}

function hasPendingRecordGameOpsForRatedMatch(ratedMatchId) {
    return [...state.pendingCompetitiveDbOpsByKey.values()]
        .some(op => op.type === 'record_game' && Number(op.payload?.ratedMatchId) === Number(ratedMatchId));
}

function buildRecordGameDbPayload(match, confirmedByDiscordId = null) {
    return {
        ratedMatchId: match.ratedMatchId,
        matchCode: match.id,
        threadId: match.threadId,
        gameNumber: match.pendingResult.gameNumber,
        winnerTeamNumber: match.pendingResult.winnerTeamIndex,
        homeTeamNumber: match.pendingResult.homeTeamNumber ?? match.homeTeamIndex,
        stadiumCode: match.pendingResult.stadiumCode ?? null,
        captainCode: match.pendingResult.captainCode ?? null,
        reportedByParticipantId: match.participantIdByDiscordId?.get(String(match.pendingResult.reporterDiscordId)),
        confirmedByParticipantId: match.participantIdByDiscordId?.get(String(confirmedByDiscordId)),
        reportedByDiscordId: match.pendingResult.reporterDiscordId ?? null,
        confirmedByDiscordId
    };
}

function buildCompleteCompetitiveDbPayload(match, winnerTeamNumber) {
    return {
        ratedMatchId: match.ratedMatchId,
        matchCode: match.id,
        threadId: match.threadId,
        seasonId: match.seasonId,
        gameType: CONSTANTS.SQL_GAME_TYPE_TO_NUMBER[match.gameType],
        mode: match.mode,
        winnerTeamNumber,
        team1Score: match.score.team1,
        team2Score: match.score.team2,
        homeTeamNumber: match.homeTeamIndex,
        awayTeamNumber: match.awayTeamIndex,
        guildId: CONSTANTS.GUILD_ID
    };
}

async function postCompetitiveDbPendingNotice(match, client, thread = null) {
    thread ??= await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) return null;

    const payload = buildThreadTextPayload(
        `${BL_TIME_EMOJI} **Competitive DB sync pending.** The match can continue; Competitive ELO will be synced automatically when the database is reachable again.`,
        'line',
        { components: [] }
    );
    try {
        const message = await editOrSendRequiredThreadMessage(
            thread,
            match.competitiveDbPendingNoticeMessageId,
            payload
        );
        match.competitiveDbPendingNoticeMessageId = message.id;
        return message;
    } catch (error) {
        logRatedError(client, match, 'competitive_db.pending_notice_failed', error, getMatchLogDetails(match));
        return null;
    }
}

function getDisplayedDelta(delta) {
    const rounded = Math.round(delta);
    if (!Number.isFinite(rounded)) {
        return '+0';
    }

    return rounded >= 0 ? `+${rounded}` : `${rounded}`;
}

function renderCompetitiveRatingLine(change) {
    const rank = change.rankAfter ?? 0;
    const rankEmoji = COMP_RANK_EMOJIS[rank] ?? COMP_RANK_EMOJIS[0];
    const eloAfter = Math.round(change.eloAfter);
    return `<@${change.discordId}> ${getDisplayedDelta(change.eloDelta)} ${ARROW_EMOJI} ${rankEmoji} **${eloAfter}**`;
}

function renderCompetitiveRatingSummaryMessage(competitiveResult = null) {
    if (!Array.isArray(competitiveResult?.changes) || competitiveResult.changes.length === 0) {
        return null;
    }

    return competitiveResult.changes
        .slice()
        .sort((left, right) => {
            if (left.outcome !== right.outcome) return left.outcome === 'win' ? -1 : 1;
            return left.teamNumber - right.teamNumber;
        })
        .map(renderCompetitiveRatingLine)
        .join('\n');
}

async function runPendingCompetitiveDbOps(client) {
    const now = Date.now();
    const ops = [...state.pendingCompetitiveDbOpsByKey.values()]
        .filter(op => !op.nextRetryAt || op.nextRetryAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt);

    for (const op of ops) {
        try {
            if (op.type === 'record_game') {
                await ratedMatchDao.recordGame(op.payload);
            } else if (op.type === 'complete_competitive') {
                if (hasPendingRecordGameOpsForRatedMatch(op.payload.ratedMatchId)) {
                    continue;
                }
                const result = await recordCompetitiveResult({
                    ...op.payload,
                    client,
                    guildId: op.payload.guildId ?? CONSTANTS.GUILD_ID
                });
                const thread = await client.channels.fetch(op.threadId).catch(() => null);
                if (thread?.send && Array.isArray(result?.changes) && result.changes.length > 0) {
                    await thread.send(buildThreadTextPayload(
                        `${BL_CHECK_EMOJI} **Competitive DB sync completed.**\n${renderCompetitiveRatingSummaryMessage(result)}`,
                        'line',
                        { components: [] }
                    )).catch(error => {
                        logRatedWarn(client, { id: op.matchId, threadId: op.threadId }, 'competitive_db.sync_notice_failed', {
                            match: op.matchId,
                            thread: op.threadId,
                            error: error.message
                        });
                    });
                }
            }
            state.pendingCompetitiveDbOpsByKey.delete(op.key);
            scheduleRuntimeStatePersist('competitive_db_op_completed');
            logRatedInfo(client, { id: op.matchId, threadId: op.threadId }, 'competitive_db.op_completed', {
                match: op.matchId,
                thread: op.threadId,
                key: op.key,
                type: op.type
            });
        } catch (error) {
            op.attempts += 1;
            op.lastError = error.message;
            op.nextRetryAt = Date.now() + Math.min(60000, 5000 * Math.max(op.attempts, 1));
            scheduleRuntimeStatePersist('competitive_db_op_retry_scheduled');
            logRatedWarn(client, { id: op.matchId, threadId: op.threadId }, 'competitive_db.op_retry_scheduled', {
                match: op.matchId,
                thread: op.threadId,
                key: op.key,
                type: op.type,
                attempts: op.attempts,
                nextRetryAt: op.nextRetryAt,
                error: error.message
            });
        }
    }
}

module.exports = {
    buildCompleteCompetitiveDbPayload,
    buildRecordGameDbPayload,
    enqueueCompetitiveDbOp,
    hasPendingCompetitiveDbOpsForMatch,
    postCompetitiveDbPendingNotice,
    renderCompetitiveRatingSummaryMessage,
    runPendingCompetitiveDbOps
};
