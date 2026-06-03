jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: jest.fn()
}));

const CompetitiveRatingDao = require('../../src/db/daos/competitiveRatingDao');
const { executeQuery } = require('../../src/db/sqlClient');

describe('CompetitiveRatingDao rank role lookup', () => {
    beforeEach(() => {
        executeQuery.mockReset();
    });

    it('treats active placement players as Unranked for 1v1 role assignment', async () => {
        executeQuery.mockResolvedValueOnce({ recordset: [{ HighestRank: 0 }] });
        const dao = new CompetitiveRatingDao();

        await expect(dao.getBestCompletedOneVOneRank(7, 2)).resolves.toBe(0);

        const [query, params] = executeQuery.mock.calls[0];
        expect(query).toContain('CASE');
        expect(query).toContain('PlacementComplete = 1');
        expect(query).toContain('ELSE 0');
        expect(query).not.toMatch(/WHERE[\s\S]*PlacementComplete\s*=\s*1/);
        expect(query).not.toMatch(/WHERE[\s\S]*GameId\s*=/);
        expect(query).toContain("ModeCode = '1v1'");
        expect(params).toEqual({ playerId: 7, seasonId: 2 });
    });

    it('returns the best completed placement rank across all competitive 1v1 games', async () => {
        executeQuery.mockResolvedValueOnce({ recordset: [{ HighestRank: 4 }] });
        const dao = new CompetitiveRatingDao();

        await expect(dao.getBestCompletedOneVOneRank(9, 2)).resolves.toBe(4);
    });
});
