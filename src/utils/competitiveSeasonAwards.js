const SEASON_AWARD_DEFINITIONS = Object.freeze([
    { code: 'TOP_10', name: 'Top 10' },
    { code: 'MOST_WINS', name: 'Most Wins' },
    { code: 'BIGGEST_UPSET', name: 'Biggest Upset' },
    { code: 'CLUTCH_PLAYER', name: 'Clutch Player' },
    { code: 'SWEEP_SPECIALIST', name: 'Sweep Specialist' },
    { code: 'COMEBACK_KING', name: 'Comeback King' },
    { code: 'MOST_ACTIVE', name: 'Most Active' },
    { code: 'IRON_PLAYER', name: 'Iron Player' },
    { code: 'DUO_OF_THE_SEASON', name: 'Duo of the Season' }
]);

const SEASON_AWARD_BY_CODE = new Map(SEASON_AWARD_DEFINITIONS.map(award => [award.code, award]));

function getSeasonAwardDefinition(code) {
    return SEASON_AWARD_BY_CODE.get(code) ?? null;
}

function getLoserScore(match) {
    const winnerTeam = Number(match.WinnerTeamNumber ?? match.winnerTeamNumber);
    if (winnerTeam === 1) return Number(match.Team2Score ?? match.team2Score ?? 0);
    if (winnerTeam === 2) return Number(match.Team1Score ?? match.team1Score ?? 0);
    return 0;
}

function isClutchMatchWin(match) {
    const firstTo = Number(match.FirstTo ?? match.firstTo ?? 0);
    return firstTo > 0 && getLoserScore(match) === firstTo - 1;
}

function isSweepMatchWin(match) {
    const firstTo = Number(match.FirstTo ?? match.firstTo ?? 0);
    return firstTo > 1 && getLoserScore(match) <= firstTo - 2;
}

function formatAwardMetric(value, suffix = '') {
    const number = Number(value);
    if (!Number.isFinite(number)) return suffix.trim();
    const formatted = Number.isInteger(number) ? String(number) : number.toFixed(2);
    return `${formatted}${suffix ? ` ${suffix}` : ''}`;
}

module.exports = {
    SEASON_AWARD_DEFINITIONS,
    getSeasonAwardDefinition,
    isClutchMatchWin,
    isSweepMatchWin,
    formatAwardMetric
};
