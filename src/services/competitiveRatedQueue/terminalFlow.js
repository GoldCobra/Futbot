const {
    CONSTANTS,
    RATED_ISSUE_FORUM_BY_GAME_TYPE,
    THREAD_NAME_MAX_LENGTH
} = require('./constants');
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
    const participants = match.teams.flatMap(team =>
        team.members.map(member => ({
            id: member.id,
            mention: member.mention,
            username: member.username
        }))
    );

    return {
        id: match.id,
        mode: match.mode,
        gameType: match.gameType,
        threadId: match.threadId,
        threadName: completedThreadName,
        threadUrl: match.threadUrl,
        finalMessageId,
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
    const forumChannelId = RATED_ISSUE_FORUM_BY_GAME_TYPE[snapshot.gameType];
    const forumChannel = await client.channels.fetch(forumChannelId).catch(err => {
        console.error(`[RatedQueue] Failed to fetch issue forum channel ${forumChannelId}: ${err.message}`);
        logRatedError(client, snapshot, 'report_issue.forum_fetch_failed', err, { forum: forumChannelId });
        return null;
    });
    if (!forumChannel?.threads?.create) {
        console.error(`[RatedQueue] Issue forum channel ${forumChannelId} is not available for thread creation.`);
        logRatedError(client, snapshot, 'report_issue.forum_missing', new Error('Forum channel is unavailable'), { forum: forumChannelId });
        return null;
    }

    const staffRoleIds = getIssueReportStaffRoleIds(snapshot.gameType);
    const reportThread = await forumChannel.threads.create({
        name: truncateDiscordName(snapshot.threadName, THREAD_NAME_MAX_LENGTH),
        reason: `${snapshot.gameType} rated match issue report`,
        message: {
            content: buildIssueReportPostContent(snapshot),
            allowedMentions: {
                roles: staffRoleIds,
                users: snapshot.participantIds
            }
        }
    }).catch(err => {
        console.error(`[RatedQueue] Failed to create issue report post for match ${snapshot.id}: ${err.message}`);
        logRatedError(client, snapshot, 'report_issue.create_failed', err, { forum: forumChannelId });
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

    logRatedInfo(client, snapshot, 'report_issue.created', {
        match: snapshot.id,
        issueThread: reportThread.id,
        forum: forumChannelId
    });
    return reportThread;
}

module.exports = {
    createIssueReportPost,
    getIssueReportStaffRoleIds,
    isReportableMatch,
    storeReportableMatch
};
