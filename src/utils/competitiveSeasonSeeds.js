const SEASON_START_HOUR_UTC = 8;
const DEFAULT_SOFT_RESET_FACTOR = 0.70;
const SEASON_CYCLE = [
    { label: 'Rise', startMonth: 3 },
    { label: 'Burst', startMonth: 6 },
    { label: 'Dusk', startMonth: 9 },
    { label: 'Chill', startMonth: 12 }
];

function addMonths(year, month, monthsToAdd) {
    const zeroBasedMonth = month - 1 + monthsToAdd;
    return {
        year: year + Math.floor(zeroBasedMonth / 12),
        month: (zeroBasedMonth % 12) + 1
    };
}

function firstWednesdayUtc(year, month) {
    const date = new Date(Date.UTC(year, month - 1, 1, SEASON_START_HOUR_UTC, 0, 0, 0));
    const daysUntilWednesday = (3 - date.getUTCDay() + 7) % 7;
    date.setUTCDate(date.getUTCDate() + daysUntilWednesday);
    return date;
}

function getSeasonDates(year, startMonth) {
    const startBoundary = firstWednesdayUtc(year, startMonth);
    const startDate = new Date(startBoundary.getTime());
    startDate.setUTCDate(startDate.getUTCDate() + 1);

    const endBoundary = addMonths(year, startMonth, 3);
    const endDate = firstWednesdayUtc(endBoundary.year, endBoundary.month);

    return {
        StartDateUtc: startDate.toISOString(),
        EndDateUtc: endDate.toISOString()
    };
}

function buildDefaultCompetitiveSeasons() {
    const seasons = [];
    let seasonNumber = 1;
    let id = 2;
    let started = false;

    for (let year = 2026; year <= 2050; year += 1) {
        for (const season of SEASON_CYCLE) {
            if (!started) {
                started = year === 2026 && season.label === 'Burst';
                if (!started) continue;
            }

            const seasonDates = getSeasonDates(year, season.startMonth);

            seasons.push({
                Id: id,
                SeasonNumber: seasonNumber,
                DisplayName: `${season.label} Season ${year}`,
                StartDateUtc: seasonDates.StartDateUtc,
                EndDateUtc: seasonDates.EndDateUtc,
                IsActive: seasonNumber === 1,
                IsCompleted: false,
                SoftResetFactor: DEFAULT_SOFT_RESET_FACTOR
            });

            if (year === 2050 && season.label === 'Chill') {
                return seasons;
            }

            seasonNumber += 1;
            id += 1;
        }
    }

    return seasons;
}

module.exports = {
    buildDefaultCompetitiveSeasons
};
