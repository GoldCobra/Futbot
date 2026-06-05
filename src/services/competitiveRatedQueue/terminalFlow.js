const {
    CONSTANTS,
    RATED_ISSUE_SUPPORT_CHANNEL_BY_GAME_TYPE,
    THREAD_NAME_MAX_LENGTH
} = require('./constants');
const { ChannelType } = require('discord.js');
const { truncateDiscordName } = require('./formatting');
const {
    logRatedError,
    logRatedInfo,
    logRatedWarn
} = require('./runtimeLogger');
const { state } = require('./state');

function isReportableMatch(match) {
    return ['MSC', 'SMS', 'MSBL'].includes(match?.gameType) && ['1v1', '2v2'].includes(match?.mode);
}

function createReportableMatchSnapshot(match, completedThreadName, finalMessageId = null) {
    const participants = match.teams.flatMap((team, teamIndex) =>
        team.members.map(member => ({
            id: member.id,
            mention: member.mention,
            username: member.username,
            teamNumber: team.teamIndex ?? teamIndex + 1,
            isRepresentative: member.id === team.repUserId
        }))
    );

    return {
        id: match.id,
        ratedMatchId: match.ratedMatchId ?? null,
        mode: match.mode,
        gameType: match.gameType,
        channelId: match.channelId ?? null,
        threadId: match.threadId,
        threadName: completedThreadName,
        threadUrl: match.threadUrl,
        finalMessageId,
        firstTo: match.firstTo ?? null,
        completedAtMs: Date.now(),
        threadFinalizedAt: null,
        participants,
        participantIds: participants.map(participant => participant.id),
        issueThreadId: null,
        issueThreadUrl: null
    };
}

function storeReportableMatch(match, completedThreadName, finalMessageId = null) {
    if (!isReportableMatch(match)) {
        return;
    }

    state.reportableMatchesById.set(
        match.id,
        createReportableMatchSnapshot(match, completedThreadName, finalMessageId)
    );
}

function getIssueReportStaffRoleIds(gameType) {
    const gameTypeRole = gameType === 'SMS'
        ? CONSTANTS.ROLES.MSL_STAFF_SMS
        : gameType === 'MSBL'
            ? CONSTANTS.ROLES.MSL_STAFF_MSBL
            : CONSTANTS.ROLES.MSL_STAFF_MSC;
    return [...new Set([CONSTANTS.ROLES.ADMIN, gameTypeRole].filter(Boolean))];
}

function buildIssueReportPostContent(snapshot) {
    const staffRoleIds = getIssueReportStaffRoleIds(snapshot.gameType);
    const staffMentions = staffRoleIds.map(roleId => `<@&${roleId}>`).join(' ');
    const playerMentions = snapshot.participantIds.map(userId => `<@${userId}>`).join(' ');
    return [
        `**${snapshot.gameType} Rated Match Issue Report**`,
        `Match: **${snapshot.threadName}**`,
        snapshot.threadUrl ? `Match Thread: ${snapshot.threadUrl}` : null,
        `Staff: ${staffMentions}`,
        `Players: ${playerMentions}`,
        '',
        'Please use this post to discuss any inconsistencies or problems from the match.'
    ].filter(line => line !== null).join('\n');
}

async function createIssueReportPost(client, snapshot) {
    const supportChannelId = RATED_ISSUE_SUPPORT_CHANNEL_BY_GAME_TYPE[snapshot.gameType];
    const supportChannel = await client.channels.fetch(supportChannelId).catch(err => {
        console.error(`[RatedQueue] Failed to fetch issue support channel ${supportChannelId}: ${err.message}`);
        logRatedError(client, snapshot, 'report_issue.channel_fetch_failed', err, { channel: supportChannelId });
        return null;
    });
    if (!supportChannel?.threads?.create) {
        console.error(`[RatedQueue] Issue support channel ${supportChannelId} is not available for thread creation.`);
        logRatedError(client, snapshot, 'report_issue.channel_missing', new Error('Support channel is unavailable'), { channel: supportChannelId });
        return null;
    }

    const staffRoleIds = getIssueReportStaffRoleIds(snapshot.gameType);
    const reportThread = await supportChannel.threads.create({
        name: truncateDiscordName(snapshot.threadName, THREAD_NAME_MAX_LENGTH),
        type: ChannelType.PrivateThread,
        autoArchiveDuration: 1440,
        invitable: false,
        reason: `${snapshot.gameType} rated match issue report`
    }).catch(err => {
        console.error(`[RatedQueue] Failed to create issue report post for match ${snapshot.id}: ${err.message}`);
        logRatedError(client, snapshot, 'report_issue.create_failed', err, { channel: supportChannelId });
        return null;
    });
    if (!reportThread) {
        return null;
    }

    await Promise.all(snapshot.participantIds.map(userId =>
        reportThread.members?.add?.(userId).catch(err =>
            {
                console.warn(`[RatedQueue] Failed to add user ${userId} to issue report ${reportThread.id}: ${err.message}`);
                logRatedWarn(client, snapshot, 'report_issue.member_add_failed', {
                    match: snapshot.id,
                    issueThread: reportThread.id,
                    user: userId,
                    error: err.message
                });
            }
        )
    ));

    if (typeof reportThread.send !== 'function') {
        console.error(`[RatedQueue] Issue report thread ${reportThread.id} is not available for messaging.`);
        logRatedError(client, snapshot, 'report_issue.thread_missing_send', new Error('Issue report thread is unavailable'), {
            match: snapshot.id,
            issueThread: reportThread.id,
            channel: supportChannelId
        });
        return null;
    }

    const reportMessage = await reportThread.send({
        content: buildIssueReportPostContent(snapshot),
        allowedMentions: {
            roles: staffRoleIds,
            users: snapshot.participantIds
        }
    }).catch(err => {
        console.error(`[RatedQueue] Failed to send issue report post for match ${snapshot.id}: ${err.message}`);
        logRatedError(client, snapshot, 'report_issue.message_failed', err, {
            match: snapshot.id,
            issueThread: reportThread.id,
            channel: supportChannelId
        });
        return null;
    });
    if (!reportMessage) {
        return null;
    }

    logRatedInfo(client, snapshot, 'report_issue.created', {
        match: snapshot.id,
        issueThread: reportThread.id,
        channel: supportChannelId
    });
    return reportThread;
}

module.exports = {
    createIssueReportPost,
    getIssueReportStaffRoleIds,
    isReportableMatch,
    storeReportableMatch
};
