require('dotenv').config();

const { executeQuery, sql, closePool } = require('../src/db/sqlClient');
const RatedMatchDao = require('../src/db/daos/ratedMatchDao');
const CompetitiveWhrSyncDao = require('../src/db/daos/competitiveWhrSyncDao');
const competitiveRating = require('../src/services/competitiveRating');
const CONSTANTS = require('../src/utils/constants');
const { competitiveTable } = require('../src/utils/competitiveConstants');

const T = {
    season: competitiveTable('CompetitiveSeason'),
    rating: competitiveTable('CompetitivePlayerRating'),
    threshold: competitiveTable('CompetitiveRankThreshold'),
    whrSync: competitiveTable('CompetitiveWhrSync'),
    ratedMatch: competitiveTable('RatedMatch')
};

const ratedMatchDao = new RatedMatchDao();
const whrSyncDao = new CompetitiveWhrSyncDao();

function getArg(name) {
    const prefix = `${name}=`;
    const found = process.argv.slice(2).find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
}

function hasArg(name) {
    return process.argv.includes(name);
}

function toDate(value, label) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
    return date;
}

function toInt(value, label) {
    const number = Number(value);
    if (!Number.isInteger(number)) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
    return number;
}

function gameCode(gameId) {
    return CONSTANTS.SQL_GAME_TYPE_TO_STRING[Number(gameId)] ?? `Game ${gameId}`;
}

function buildManualMatchCode({ legacyMatchId = null, legacyMultiMatchId = null }) {
    if (legacyMatchId) return `manual:1:${legacyMatchId}`;
    if (legacyMultiMatchId) return `manual:2:${legacyMultiMatchId}`;
    throw new Error('Missing legacy match id for manual match code.');
}

function assertCandidate(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function normalizeSingle(row) {
    const team1Score = Number(row.P1Wins);
    const team2Score = Number(row.P1Losses);
    const matchDate = toDate(row.MatchDate, `legacy match ${row.LegacyMatchId} MatchDate`);
    assertCandidate(Number.isInteger(team1Score) && Number.isInteger(team2Score), `Legacy Match ${row.LegacyMatchId} has invalid score.`);
    assertCandidate(team1Score !== team2Score, `Legacy Match ${row.LegacyMatchId} is a draw and cannot be imported.`);
    assertCandidate(row.Player1DiscordId && row.Player2DiscordId, `Legacy Match ${row.LegacyMatchId} has a player without DiscordID.`);
    assertCandidate(String(row.Player1DiscordId) !== String(row.Player2DiscordId), `Legacy Match ${row.LegacyMatchId} has duplicate Discord players.`);

    return {
        kind: '1v1',
        legacyMatchId: Number(row.LegacyMatchId),
        legacyMultiMatchId: null,
        gameId: Number(row.GameType),
        mode: '1v1',
        matchDate,
        team1Score,
        team2Score,
        guildId: row.ServerID ? String(row.ServerID) : null,
        channel: row.Channel ?? null,
        participants: [
            {
                playerId: Number(row.Player1),
                discordId: String(row.Player1DiscordId),
                name: row.Player1Name,
                teamNumber: 1,
                isRepresentative: true
            },
            {
                playerId: Number(row.Player2),
                discordId: String(row.Player2DiscordId),
                name: row.Player2Name,
                teamNumber: 2,
                isRepresentative: true
            }
        ]
    };
}

function normalizeDouble(row) {
    const team1Score = Number(row.Team1Wins);
    const team2Score = Number(row.Team1Losses);
    const matchDate = toDate(row.MatchDate, `legacy multimatch ${row.LegacyMultiMatchId} MatchDate`);
    const players = [
        { playerId: row.Player1, discordId: row.Player1DiscordId, name: row.Player1Name, teamNumber: 1, isRepresentative: true },
        { playerId: row.Player2, discordId: row.Player2DiscordId, name: row.Player2Name, teamNumber: 1, isRepresentative: false },
        { playerId: row.Player3, discordId: row.Player3DiscordId, name: row.Player3Name, teamNumber: 2, isRepresentative: true },
        { playerId: row.Player4, discordId: row.Player4DiscordId, name: row.Player4Name, teamNumber: 2, isRepresentative: false }
    ];
    assertCandidate(Number.isInteger(team1Score) && Number.isInteger(team2Score), `Legacy MultiMatch ${row.LegacyMultiMatchId} has invalid score.`);
    assertCandidate(team1Score !== team2Score, `Legacy MultiMatch ${row.LegacyMultiMatchId} is a draw and cannot be imported.`);
    assertCandidate(players.every(player => player.playerId && player.discordId), `Legacy MultiMatch ${row.LegacyMultiMatchId} has a player without DiscordID.`);
    assertCandidate(new Set(players.map(player => String(player.discordId))).size === players.length, `Legacy MultiMatch ${row.LegacyMultiMatchId} has duplicate Discord players.`);

    return {
        kind: '2v2',
        legacyMatchId: null,
        legacyMultiMatchId: Number(row.LegacyMultiMatchId),
        gameId: Number(row.GameType),
        mode: '2v2',
        matchDate,
        team1Score,
        team2Score,
        guildId: row.ServerID ? String(row.ServerID) : null,
        channel: row.Channel ?? null,
        participants: players.map(player => ({
            playerId: Number(player.playerId),
            discordId: String(player.discordId),
            name: player.name,
            teamNumber: player.teamNumber,
            isRepresentative: player.isRepresentative
        }))
    };
}

async function getTargetSeason({ seasonId = null }) {
    const input = seasonId ? { seasonId } : {};
    const where = seasonId
        ? 'WHERE Id = @seasonId'
        : 'WHERE IsActive = 1';
    const result = await executeQuery(
        `SELECT TOP 1 Id, DisplayName, StartDateUtc, EndDateUtc, IsActive, LifecycleStatus
         FROM ${T.season}
         ${where}
         ORDER BY Id DESC`,
        input
    );
    const season = result.recordset[0];
    if (!season) {
        throw new Error(seasonId ? `CompetitiveSeason ${seasonId} not found.` : 'No active CompetitiveSeason found.');
    }
    return season;
}

async function getSingleCandidates({ since, season }) {
    const result = await executeQuery(
        `SELECT m.[Match] AS LegacyMatchId,
                m.GameType,
                m.Player1,
                p1.Name AS Player1Name,
                p1.DiscordID AS Player1DiscordId,
                m.Player2,
                p2.Name AS Player2Name,
                p2.DiscordID AS Player2DiscordId,
                m.Score,
                m.P1Wins,
                m.P1Losses,
                m.MatchDate,
                m.Tournament,
                m.Stage,
                m.Channel,
                m.ServerID,
                m.SetUri,
                m.Notes
         FROM dbo.[Match] m
         LEFT JOIN dbo.Player p1 ON p1.ID = m.Player1
         LEFT JOIN dbo.Player p2 ON p2.ID = m.Player2
         LEFT JOIN ${T.whrSync} sync ON sync.LegacyMatchId = m.[Match]
         LEFT JOIN ${T.ratedMatch} existing ON existing.MatchCode = CONCAT('manual:1:', CONVERT(VARCHAR(20), m.[Match]))
         WHERE m.MatchDate >= @since
           AND m.MatchDate >= @seasonStart
           AND m.MatchDate < @seasonEnd
           AND m.GameType IN (1, 2, 3)
           AND ISNULL(m.FutureMatch, 0) = 0
           AND sync.RatedMatchId IS NULL
           AND existing.Id IS NULL
           AND (m.Notes IS NULL OR m.Notes NOT LIKE 'CompetitiveRatedMatch:%')
         ORDER BY m.MatchDate ASC, m.[Match] ASC`,
        {
            since: [sql.DateTime2, since],
            seasonStart: [sql.DateTime2, toDate(season.StartDateUtc, 'season start')],
            seasonEnd: [sql.DateTime2, toDate(season.EndDateUtc, 'season end')]
        }
    );
    return result.recordset.map(normalizeSingle);
}

async function getDoubleCandidates({ since, season }) {
    const result = await executeQuery(
        `SELECT mm.ID AS LegacyMultiMatchId,
                mm.GameType,
                mm.Player1,
                p1.Name AS Player1Name,
                p1.DiscordID AS Player1DiscordId,
                mm.Player2,
                p2.Name AS Player2Name,
                p2.DiscordID AS Player2DiscordId,
                mm.Player5 AS Player3,
                p3.Name AS Player3Name,
                p3.DiscordID AS Player3DiscordId,
                mm.Player6 AS Player4,
                p4.Name AS Player4Name,
                p4.DiscordID AS Player4DiscordId,
                mm.Score,
                mm.Team1Wins,
                mm.Team1Losses,
                mm.MatchDate,
                mm.Tournament,
                mm.Stage,
                mm.Channel,
                mm.ServerID
         FROM dbo.MultiMatch mm
         LEFT JOIN dbo.Player p1 ON p1.ID = mm.Player1
         LEFT JOIN dbo.Player p2 ON p2.ID = mm.Player2
         LEFT JOIN dbo.Player p3 ON p3.ID = mm.Player5
         LEFT JOIN dbo.Player p4 ON p4.ID = mm.Player6
         LEFT JOIN ${T.whrSync} sync ON sync.LegacyMultiMatchId = mm.ID
         LEFT JOIN ${T.ratedMatch} existing ON existing.MatchCode = CONCAT('manual:2:', CONVERT(VARCHAR(20), mm.ID))
         WHERE mm.MatchDate >= @since
           AND mm.MatchDate >= @seasonStart
           AND mm.MatchDate < @seasonEnd
           AND mm.GameType IN (1, 2, 3)
           AND ISNULL(mm.FutureMatch, 0) = 0
           AND sync.RatedMatchId IS NULL
           AND existing.Id IS NULL
         ORDER BY mm.MatchDate ASC, mm.ID ASC`,
        {
            since: [sql.DateTime2, since],
            seasonStart: [sql.DateTime2, toDate(season.StartDateUtc, 'season start')],
            seasonEnd: [sql.DateTime2, toDate(season.EndDateUtc, 'season end')]
        }
    );
    return result.recordset.map(normalizeDouble);
}

function describeCandidate(candidate) {
    const names = candidate.participants
        .map(participant => `${participant.name ?? participant.discordId}#T${participant.teamNumber}`)
        .join(' vs ');
    const legacyId = candidate.legacyMatchId ?? candidate.legacyMultiMatchId;
    return `${gameCode(candidate.gameId)} ${candidate.mode} legacy=${legacyId} date=${candidate.matchDate.toISOString()} score=${candidate.team1Score}-${candidate.team2Score} ${names}`;
}

async function importCandidate(candidate, season) {
    const matchCode = buildManualMatchCode(candidate);
    const winnerTeamNumber = candidate.team1Score > candidate.team2Score ? 1 : 2;
    const ratedMatch = await ratedMatchDao.createMatchWithDetails({
        matchCode,
        gameId: candidate.gameId,
        mode: candidate.mode,
        firstTo: Math.max(candidate.team1Score, candidate.team2Score),
        seasonId: season.Id,
        homeTeamNumber: 1,
        awayTeamNumber: 2,
        participants: candidate.participants.map(participant => ({
            playerId: participant.playerId,
            discordId: participant.discordId,
            teamNumber: participant.teamNumber,
            isRepresentative: participant.isRepresentative
        })),
        guildId: candidate.guildId,
        panelChannelId: null,
        threadId: null,
        threadUrl: null
    });

    const competitiveResult = await competitiveRating.recordCompetitiveResult({
        ratedMatchId: ratedMatch.id,
        matchCode,
        seasonId: season.Id,
        gameType: candidate.gameId,
        mode: candidate.mode,
        winnerTeamNumber,
        team1Score: candidate.team1Score,
        team2Score: candidate.team2Score,
        homeTeamNumber: 1,
        awayTeamNumber: 2,
        skipWhrSync: true,
        completedAtUtc: candidate.matchDate
    });
    if (!competitiveResult) {
        throw new Error(`Competitive rating update failed for ${matchCode}.`);
    }

    await whrSyncDao.linkExistingLegacyMirror({
        ratedMatchId: ratedMatch.id,
        legacyMatchId: candidate.legacyMatchId,
        legacyMultiMatchId: candidate.legacyMultiMatchId
    });

    return {
        ratedMatchId: ratedMatch.id,
        matchCode,
        matchNumber: ratedMatch.matchNumber,
        seasonMatchNumber: ratedMatch.seasonMatchNumber,
        gameId: candidate.gameId,
        mode: candidate.mode,
        legacyMatchId: candidate.legacyMatchId,
        legacyMultiMatchId: candidate.legacyMultiMatchId
    };
}

async function discordRequest({ token, method, path }) {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
        method,
        headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json'
        }
    });
    if (response.status === 204) return null;
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
}

async function getHighestOneVOneRank({ seasonId, playerId }) {
    const result = await executeQuery(
        `SELECT p.DiscordID AS DiscordId,
                COALESCE(MAX(CASE
                    WHEN cpr.PlacementComplete = 1 THEN cpr.RankNumber
                    ELSE 0
                END), 0) AS HighestRank
         FROM dbo.Player p
         LEFT JOIN ${T.rating} cpr
            ON cpr.PlayerId = p.Id
           AND cpr.SeasonId = @seasonId
           AND cpr.ModeCode = '1v1'
         WHERE p.Id = @playerId
         GROUP BY p.DiscordID`,
        { seasonId, playerId }
    );
    return result.recordset[0] ?? null;
}

async function getCompetitiveRankRoles() {
    const result = await executeQuery(
        `SELECT RankNumber, DiscordRoleId
         FROM ${T.threshold}
         WHERE IsActive = 1
           AND DiscordRoleId IS NOT NULL`
    );
    const legacyRoleIds = new Set((CONSTANTS.LEGACY_RANK_ROLE_IDS ?? []).map(String));
    const rows = result.recordset
        .filter(row => row.DiscordRoleId && !legacyRoleIds.has(String(row.DiscordRoleId)))
        .map(row => ({
            rankNumber: Number(row.RankNumber),
            roleId: String(row.DiscordRoleId)
        }));
    return {
        rows,
        allRoleIds: rows.map(row => row.roleId),
        byRank: new Map(rows.map(row => [row.rankNumber, row.roleId]))
    };
}

async function syncDiscordRankRoles({ seasonId, guildId, playerIds }) {
    const token = process.env.FUTBOT_TOKEN;
    if (!token) {
        console.warn('Skipping Discord rank role sync: FUTBOT_TOKEN is not configured.');
        return [];
    }
    if (!guildId) {
        console.warn('Skipping Discord rank role sync: no guild id is available.');
        return [];
    }

    const roles = await getCompetitiveRankRoles();
    if (!roles.allRoleIds.length) {
        console.warn('Skipping Discord rank role sync: no active Competitive rank roles are configured.');
        return [];
    }

    const synced = [];
    for (const playerId of [...playerIds].sort((a, b) => a - b)) {
        const rating = await getHighestOneVOneRank({ seasonId, playerId });
        if (!rating?.DiscordId) continue;

        const discordId = String(rating.DiscordId);
        const targetRoleId = roles.byRank.get(Number(rating.HighestRank)) ?? null;
        const member = await discordRequest({
            token,
            method: 'GET',
            path: `/guilds/${guildId}/members/${discordId}`
        }).catch(error => {
            console.warn(`Could not fetch Discord member ${discordId}: ${error.message}`);
            return null;
        });
        if (!member) continue;

        const currentRoleIds = new Set((member.roles ?? []).map(String));
        for (const roleId of roles.allRoleIds) {
            if (roleId !== targetRoleId && currentRoleIds.has(roleId)) {
                await discordRequest({
                    token,
                    method: 'DELETE',
                    path: `/guilds/${guildId}/members/${discordId}/roles/${roleId}`
                });
            }
        }
        if (targetRoleId && !currentRoleIds.has(targetRoleId)) {
            await discordRequest({
                token,
                method: 'PUT',
                path: `/guilds/${guildId}/members/${discordId}/roles/${targetRoleId}`
            });
        }
        synced.push({ playerId, discordId, highestRank: Number(rating.HighestRank), roleId: targetRoleId });
    }
    return synced;
}

async function main() {
    const apply = hasArg('--apply');
    const noRoleSync = hasArg('--no-role-sync');
    const seasonIdArg = getArg('--season-id');
    const sinceArg = getArg('--since');
    const includeDoubles = !hasArg('--singles-only');
    const season = await getTargetSeason({
        seasonId: seasonIdArg ? toInt(seasonIdArg, '--season-id') : null
    });
    const since = sinceArg
        ? toDate(sinceArg, '--since')
        : toDate(season.StartDateUtc, 'season StartDateUtc');

    const singles = await getSingleCandidates({ since, season });
    const doubles = includeDoubles ? await getDoubleCandidates({ since, season }) : [];
    const candidates = [...singles, ...doubles].sort((a, b) => {
        const dateDiff = a.matchDate.getTime() - b.matchDate.getTime();
        if (dateDiff !== 0) return dateDiff;
        return (a.legacyMatchId ?? a.legacyMultiMatchId) - (b.legacyMatchId ?? b.legacyMultiMatchId);
    });

    console.log(`Season: ${season.DisplayName} (${season.Id})`);
    console.log(`Since: ${since.toISOString()}`);
    console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`Candidates: ${candidates.length}`);
    for (const candidate of candidates) {
        console.log(`- ${describeCandidate(candidate)}`);
    }

    if (!apply) {
        console.log('No writes performed. Re-run with --apply to import and rebuild.');
        return;
    }

    const imported = [];
    const affectedPartitions = new Map();
    const affectedOneVOnePlayerIds = new Set();
    let guildId = null;
    for (const candidate of candidates) {
        const result = await importCandidate(candidate, season);
        imported.push(result);
        affectedPartitions.set(`${candidate.gameId}:${candidate.mode}`, {
            seasonId: season.Id,
            gameId: candidate.gameId,
            mode: candidate.mode
        });
        if (candidate.mode === '1v1') {
            for (const participant of candidate.participants) {
                affectedOneVOnePlayerIds.add(participant.playerId);
            }
        }
        guildId = guildId ?? candidate.guildId;
        console.log(`Imported ${gameCode(candidate.gameId)} ${candidate.mode} #${result.matchNumber} from ${result.matchCode}.`);
    }

    const rebuilds = [];
    for (const partition of [...affectedPartitions.values()].sort((a, b) => a.gameId - b.gameId || a.mode.localeCompare(b.mode))) {
        const result = await competitiveRating.rebuildRatingPartition(partition);
        rebuilds.push({ ...partition, ...result });
        console.log(`Rebuilt ${gameCode(partition.gameId)} ${partition.mode}: ${result.replayedMatchCount} matches, ${result.recalculatedChangeCount} changes.`);
    }

    const roleSync = noRoleSync
        ? []
        : await syncDiscordRankRoles({
            seasonId: season.Id,
            guildId: guildId ?? CONSTANTS.GUILD_ID,
            playerIds: affectedOneVOnePlayerIds
        });

    if (roleSync.length) {
        console.log(`Synced ${roleSync.length} Discord rank role(s).`);
    } else if (!noRoleSync && affectedOneVOnePlayerIds.size) {
        console.log('No Discord rank roles changed or role sync was skipped.');
    }

    console.log(JSON.stringify({ imported, rebuilds, roleSync }, null, 2));
}

main()
    .catch(error => {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => {}));
