// Contract: custom ids of rated-queue components. Buttons already posted in
// open threads carry these exact strings, so a deploy must keep building and
// parsing them the same way (including the `<game>.<controlVersion>` token).
const ids = require('../../src/services/competitiveRatedQueue/customIds');
const { getMatchActionToken, matchActionTokenMatches } = require('../../src/services/competitiveRatedQueue/matchState');

const MATCH = 'm-abc123';

test('builders produce the deployed custom id formats', () => {
    expect({
        panelJoin: ids.panelJoinCustomId('111', '1v1'),
        cancelSearch: ids.cancelSearchCustomId('s-1'),
        extendSearch: ids.extendSearchCustomId('s-1', 15, 'tok'),
        stadium: ids.stadiumButtonCustomId(MATCH, 'Crater Field', '2.0'),
        captain: ids.captainButtonCustomId(MATCH, 'mario', 3),
        winner: ids.winnerButtonCustomId(MATCH, '2.0'),
        winnerWithoutToken: ids.winnerButtonCustomId(MATCH),
        loserConfirm: ids.loserConfirmCustomId(MATCH, '2.0'),
        loserAdvantage: ids.loserAdvantageCustomId(MATCH, 'stadium', '2.0'),
        reportIssue: ids.reportIssueCustomId(MATCH),
        rematch: ids.rematchCustomId(MATCH),
        cancelMatch: ids.cancelMatchCustomId(MATCH, '1.0'),
        startSetup: ids.startSetupCustomId(MATCH, '1.0'),
        openPick: ids.openPrivatePickCustomId(MATCH, 'home', '1.0')
    }).toEqual({
        panelJoin: 'rated:competitive:join:111:1v1',
        cancelSearch: 'rated:competitive:search:cancel:s-1',
        extendSearch: 'rated:competitive:search:extend:s-1:15:tok',
        stadium: 'rated:competitive:match:stadium:m-abc123:Crater%20Field:2.0',
        captain: 'rated:competitive:match:captain:m-abc123:mario:3',
        winner: 'rated:competitive:match:winner:m-abc123:2.0',
        winnerWithoutToken: 'rated:competitive:match:winner:m-abc123',
        loserConfirm: 'rated:competitive:match:loser_confirm:m-abc123:2.0',
        loserAdvantage: 'rated:competitive:match:loser_advantage:m-abc123:stadium:2.0',
        reportIssue: 'rated:competitive:match:report_issue:m-abc123',
        rematch: 'rated:competitive:match:rematch:m-abc123',
        cancelMatch: 'rated:competitive:match:cancel:m-abc123:1.0',
        startSetup: 'rated:competitive:match:start:m-abc123:1.0',
        openPick: 'rated:competitive:match:openpick:m-abc123:home:1.0'
    });
});

test('parsers read ids, values and tokens from deployed formats', () => {
    expect(ids.parseChannelIdFromCustomId('rated:competitive:join:111:1v1')).toBe('111');
    expect(ids.parseModeFromCustomId('rated:competitive:join:111:1v1')).toBe('1v1');
    expect(ids.parseIdFromCustomId('rated:competitive:match:winner:m-abc123:2.0')).toBe(MATCH);
    expect(ids.parseOptionValueFromCustomId('rated:competitive:match:stadium:m-abc123:Crater%20Field:2.0')).toBe('Crater Field');
    expect(ids.parseLoserChoiceFromCustomId('rated:competitive:match:loser_advantage:m-abc123:stadium:2.0')).toBe('stadium');
    expect(ids.parseOpenPickPlayerFromCustomId('rated:competitive:match:openpick:m-abc123:home:1.0')).toBe('home');

    expect(ids.parseActionTokenFromCustomId('rated:competitive:match:winner:m-abc123:2.0')).toBe('2.0');
    expect(ids.parseActionTokenFromCustomId('rated:competitive:match:stadium:m-abc123:Crater%20Field:2.0')).toBe('2.0');
    expect(ids.parseActionTokenFromCustomId('rated:competitive:search:extend:s-1:15:tok')).toBe('tok');
    expect(ids.parseActionTokenFromCustomId('rated:competitive:match:winner:m-abc123')).toBeNull();
});

test('match action tokens accept `<game>.<controlVersion>`, the bare game number and token-less ids', () => {
    const match = { score: { team1: 1, team2: 0 }, stage: 'awaiting_winner', controlVersion: 0 };
    expect(getMatchActionToken(match)).toBe('2.0');
    expect(matchActionTokenMatches(match, 'rated:competitive:match:winner:m-abc123:2.0')).toBe(true);
    expect(matchActionTokenMatches(match, 'rated:competitive:match:winner:m-abc123:2')).toBe(true);
    expect(matchActionTokenMatches(match, 'rated:competitive:match:winner:m-abc123')).toBe(true);
    expect(matchActionTokenMatches(match, 'rated:competitive:match:winner:m-abc123:1.0')).toBe(false);
});
