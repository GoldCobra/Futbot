const { executeQuery } = require('../db/sqlClient');
const RatedMatchDao = require('../db/daos/ratedMatchDao');
const CompetitiveWhrSyncDao = require('../db/daos/competitiveWhrSyncDao');
const competitiveRating = require('./competitiveRating');
const CONSTANTS = require('../utils/constants');

const ratedMatchDao = new RatedMatchDao();
const competitiveWhrSyncDao = new CompetitiveWhrSyncDao();

function normalizeGameType(gameType) {
    const normalized = String(gameType ?? '').trim().toUpperCase();
    if (!CONSTANTS.SQL_GAME_TYPE_TO_NUMBER[normalized]) {
        throw new Error(`Unsupported game type: ${gameType}`);
    }
    return normalized;
}

function getLegacyReportCommandForGame(gameType, isDoubles = false) {
    const normalized = normalizeGameType(gameType).toLowerCase();
    const prefix = normalized === 'msbl' ? '!msblreport' : `!${normalized}report`;
    return isDoubles ? `${prefix}2` : prefix;
}

function getLegacyRatingGameType(command = '') {
    if (command.startsWith('!msc')) return 1;
    if (command.startsWith('!sms')) return 2;
    if (command.startsWith('!msbl') || command.startsWith('!bl')) return 3;
    return 0;
}

function toReportWins(value, label) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return number;
}

function assertNonDraw(team1Score, team2Score) {
    if (team1Score === team2Score) {
        throw new Error('Draw reports are not supported for Competitive ELO.');
    }
}

function assertDistinctUsers(users) {
    const ids = users.map(user => user?.id).filter(Boolean);
    if (ids.length !== users.length || new Set(ids).size !== ids.length) {
        throw new Error('Every reported player must be a distinct Discord user.');
    }
}

function formatLegacyUser(user) {
    return `<@!${user.id}>${user.username ?? user.globalName ?? user.id}`;
}

function extractLegacyId(rows) {
    const row = rows?.[0] ?? {};
    return row.Id ?? row.ID ?? row.Match ?? row.LegacyMatchId ?? null;
}

function buildReportReply({ legacyMatchId, ratedMatchId }) {
    const legacyMatchIdLine = legacyMatchId ? `\nMatch Id: ${legacyMatchId}` : '';
    const ratedMatchIdLine = ratedMatchId ? `\nCompetitive Match Id: ${ratedMatchId}` : '';
    return `Thanks for playing!\n\nResult recorded. Competitive ELO updated. Legacy ELO unchanged.${legacyMatchIdLine}${ratedMatchIdLine}`;
}

async function getActiveCompetitiveSeasonOrThrow() {
    const season = await competitiveRating.getActiveSeason();
    if (!season) {
        throw new Error('No active Competitive season is available for report ELO updates.');
    }
    return season;
}

async function reportScoreSQLV2(gametype, p1, p2, p1Wins, p2Wins, channel, tournament, stage, serverid, delt1 = 0, delt2 = 0, setUri = '') {
    const result = await executeQuery(
        'exec reportScore @gametype, @p1, @p2, @score, null, @tournament, @stage, 0, @c, @serverid, @d1, @d2, @setUri',
        {
            gametype: CONSTANTS.SQL_GAME_TYPE_TO_NUMBER[normalizeGameType(gametype)],
            p1: formatLegacyUser(p1),
            p2: formatLegacyUser(p2),
            score: `${p1Wins}-${p2Wins}`,
            c: channel,
            serverid,
            d1: delt1,
            d2: delt2,
            tournament,
            stage,
            setUri
        }
    );
    return result.recordset;
}

async function reportScore2SQLV2(gametype, team1p1, team1p2, team2p1, team2p2, team1Wins, team2Wins, channel, serverid, delt1 = 0, delt2 = 0, delt5 = 0, delt6 = 0) {
    const command = getLegacyReportCommandForGame(gametype, true);
    const result = await executeQuery(
        'exec reportScore2 @gametype, @p1, @p2, @p5, @p6, @score, null, @c, @serverid, @d1, @d2, @d5, @d6',
        {
            gametype: getLegacyRatingGameType(command),
            p1: formatLegacyUser(team1p1),
            p2: formatLegacyUser(team1p2),
            p5: formatLegacyUser(team2p1),
            p6: formatLegacyUser(team2p2),
            score: `${team1Wins}-${team2Wins}`,
            c: channel,
            serverid,
            d1: delt1,
            d2: delt2,
            d5: delt5,
            d6: delt6
        }
    );
    return result.recordset;
}

async function createCompletedManualRatedMatch({
    season,
    legacyMatchId = null,
    legacyMultiMatchId = null,
    gameType,
    mode,
    team1Score,
    team2Score,
    participants,
    guildId,
    panelChannelId,
    client
}) {
    const normalizedGameType = normalizeGameType(gameType);
    const gameId = CONSTANTS.SQL_GAME_TYPE_TO_NUMBER[normalizedGameType];
    const matchCode = legacyMatchId
        ? `manual-report:match:${legacyMatchId}`
        : `manual-report:multi:${legacyMultiMatchId}`;
    const winnerTeamNumber = team1Score > team2Score ? 1 : 2;

    const ratedMatchId = await ratedMatchDao.createMatch({
        matchCode,
        gameId,
        mode,
        firstTo: Math.max(team1Score, team2Score),
        seasonId: season.Id,
        homeTeamNumber: 1,
        awayTeamNumber: 2,
        participants,
        guildId,
        panelChannelId,
        threadId: null,
        threadUrl: null
    });

    const competitiveResult = await competitiveRating.recordCompetitiveResult({
        ratedMatchId,
        matchCode,
        seasonId: season.Id,
        gameType: gameId,
        mode,
        winnerTeamNumber,
        team1Score,
        team2Score,
        homeTeamNumber: 1,
        awayTeamNumber: 2,
        client,
        guildId,
        skipWhrSync: true
    });
    if (!competitiveResult) {
        throw new Error(`Competitive rating update failed for ${matchCode}.`);
    }

    await competitiveWhrSyncDao.linkExistingLegacyMirror({
        ratedMatchId,
        legacyMatchId,
        legacyMultiMatchId
    });

    return {
        ratedMatchId,
        competitiveResult
    };
}

async function recordManualReport1v1({
    interaction,
    p1,
    p2,
    p1Wins,
    p2Wins,
    gametype,
    guildid,
    tournament = '',
    stage = '',
    setUri = ''
}) {
    const gameType = normalizeGameType(gametype);
    const team1Score = toReportWins(p1Wins, 'p1wins');
    const team2Score = toReportWins(p2Wins, 'p2wins');
    assertNonDraw(team1Score, team2Score);
    assertDistinctUsers([p1, p2]);

    const season = await getActiveCompetitiveSeasonOrThrow();
    const legacyRows = await reportScoreSQLV2(
        gameType,
        p1,
        p2,
        team1Score,
        team2Score,
        interaction.channel?.name ?? 'slash-report',
        tournament ?? '',
        stage ?? '',
        guildid,
        0,
        0,
        setUri ?? ''
    );
    const legacyMatchId = extractLegacyId(legacyRows);
    if (!legacyMatchId) {
        throw new Error('Legacy 1v1 report did not return a match id.');
    }

    const competitive = await createCompletedManualRatedMatch({
        season,
        legacyMatchId,
        gameType,
        mode: '1v1',
        team1Score,
        team2Score,
        participants: [
            { discordId: p1.id, teamNumber: 1, isRepresentative: true },
            { discordId: p2.id, teamNumber: 2, isRepresentative: true }
        ],
        guildId: guildid,
        panelChannelId: interaction.channelId ?? interaction.channel?.id ?? null,
        client: interaction.client
    });

    return {
        legacyMatchId,
        ...competitive
    };
}

async function recordManualReport2v2({
    interaction,
    team1p1,
    team1p2,
    team2p1,
    team2p2,
    team1Wins,
    team2Wins,
    gametype,
    guildid
}) {
    const gameType = normalizeGameType(gametype);
    const team1Score = toReportWins(team1Wins, 'team1wins');
    const team2Score = toReportWins(team2Wins, 'team2wins');
    assertNonDraw(team1Score, team2Score);
    assertDistinctUsers([team1p1, team1p2, team2p1, team2p2]);

    const season = await getActiveCompetitiveSeasonOrThrow();
    const legacyRows = await reportScore2SQLV2(
        gameType,
        team1p1,
        team1p2,
        team2p1,
        team2p2,
        team1Score,
        team2Score,
        interaction.channel?.name ?? 'slash-report',
        guildid,
        0,
        0,
        0,
        0
    );
    const legacyMultiMatchId = extractLegacyId(legacyRows);
    if (!legacyMultiMatchId) {
        throw new Error('Legacy 2v2 report did not return a match id.');
    }

    const competitive = await createCompletedManualRatedMatch({
        season,
        legacyMultiMatchId,
        gameType,
        mode: '2v2',
        team1Score,
        team2Score,
        participants: [
            { discordId: team1p1.id, teamNumber: 1, isRepresentative: true },
            { discordId: team1p2.id, teamNumber: 1, isRepresentative: false },
            { discordId: team2p1.id, teamNumber: 2, isRepresentative: true },
            { discordId: team2p2.id, teamNumber: 2, isRepresentative: false }
        ],
        guildId: guildid,
        panelChannelId: interaction.channelId ?? interaction.channel?.id ?? null,
        client: interaction.client
    });

    return {
        legacyMatchId: legacyMultiMatchId,
        legacyMultiMatchId,
        ...competitive
    };
}

module.exports = {
    buildReportReply,
    recordManualReport1v1,
    recordManualReport2v2,
    _private: {
        reportScoreSQLV2,
        reportScore2SQLV2,
        normalizeGameType
    }
};
