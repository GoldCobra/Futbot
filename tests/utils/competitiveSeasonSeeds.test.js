const { buildDefaultCompetitiveSeasons } = require('../../src/utils/competitiveSeasonSeeds');

describe('buildDefaultCompetitiveSeasons', () => {
    it('starts with Burst Season 2026 and uses first-Wednesday season boundaries', () => {
        const seasons = buildDefaultCompetitiveSeasons();

        expect(seasons.slice(0, 5)).toEqual([
            expect.objectContaining({
                Id: 2,
                SeasonNumber: 1,
                DisplayName: 'Burst Season 2026',
                StartDateUtc: '2026-06-04T08:00:00.000Z',
                EndDateUtc: '2026-09-02T08:00:00.000Z',
                IsActive: true
            }),
            expect.objectContaining({
                Id: 3,
                SeasonNumber: 2,
                DisplayName: 'Dusk Season 2026',
                StartDateUtc: '2026-09-03T08:00:00.000Z',
                EndDateUtc: '2026-12-02T08:00:00.000Z',
                IsActive: false
            }),
            expect.objectContaining({
                Id: 4,
                SeasonNumber: 3,
                DisplayName: 'Chill Season 2026',
                StartDateUtc: '2026-12-03T08:00:00.000Z',
                EndDateUtc: '2027-03-03T08:00:00.000Z'
            }),
            expect.objectContaining({
                Id: 5,
                SeasonNumber: 4,
                DisplayName: 'Rise Season 2027',
                StartDateUtc: '2027-03-04T08:00:00.000Z',
                EndDateUtc: '2027-06-02T08:00:00.000Z'
            }),
            expect.objectContaining({
                Id: 6,
                SeasonNumber: 5,
                DisplayName: 'Burst Season 2027',
                StartDateUtc: '2027-06-03T08:00:00.000Z',
                EndDateUtc: '2027-09-01T08:00:00.000Z'
            })
        ]);
    });

    it('handles first Wednesdays that fall after the third day of the month', () => {
        const seasons = buildDefaultCompetitiveSeasons();

        expect(seasons[7]).toEqual(expect.objectContaining({
            SeasonNumber: 8,
            DisplayName: 'Rise Season 2028',
            StartDateUtc: '2028-03-02T08:00:00.000Z',
            EndDateUtc: '2028-06-07T08:00:00.000Z'
        }));
        expect(seasons[8]).toEqual(expect.objectContaining({
            SeasonNumber: 9,
            DisplayName: 'Burst Season 2028',
            StartDateUtc: '2028-06-08T08:00:00.000Z',
            EndDateUtc: '2028-09-06T08:00:00.000Z'
        }));
    });

    it('keeps consecutive seasons connected by the Wednesday-to-Thursday rollover', () => {
        const seasons = buildDefaultCompetitiveSeasons();

        for (let index = 1; index < seasons.length; index += 1) {
            const previousEnd = new Date(seasons[index - 1].EndDateUtc);
            const expectedStart = new Date(previousEnd.getTime());
            expectedStart.setUTCDate(expectedStart.getUTCDate() + 1);

            expect(seasons[index].StartDateUtc).toBe(expectedStart.toISOString());
            expect(new Date(seasons[index - 1].EndDateUtc).getUTCDay()).toBe(3);
            expect(new Date(seasons[index].StartDateUtc).getUTCDay()).toBe(4);
        }
    });
});
