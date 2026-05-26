const {
    getSeasonAwardDefinition,
    isClutchMatchWin,
    isSweepMatchWin
} = require('../../src/utils/competitiveSeasonAwards');

describe('competitive season awards', () => {
    it('exposes stable award definitions', () => {
        expect(getSeasonAwardDefinition('TOP_10').name).toBe('Top 10');
        expect(getSeasonAwardDefinition('DUO_OF_THE_SEASON').name).toBe('Duo of the Season');
        expect(getSeasonAwardDefinition('UNKNOWN')).toBeNull();
    });

    it('identifies clutch wins by final match score', () => {
        expect(isClutchMatchWin({ FirstTo: 2, WinnerTeamNumber: 1, Team1Score: 2, Team2Score: 1 })).toBe(true);
        expect(isClutchMatchWin({ FirstTo: 2, WinnerTeamNumber: 2, Team1Score: 1, Team2Score: 2 })).toBe(true);
        expect(isClutchMatchWin({ FirstTo: 2, WinnerTeamNumber: 1, Team1Score: 2, Team2Score: 0 })).toBe(false);
    });

    it('identifies sweep wins as wins without opponent match point', () => {
        expect(isSweepMatchWin({ FirstTo: 2, WinnerTeamNumber: 1, Team1Score: 2, Team2Score: 0 })).toBe(true);
        expect(isSweepMatchWin({ FirstTo: 3, WinnerTeamNumber: 1, Team1Score: 3, Team2Score: 1 })).toBe(true);
        expect(isSweepMatchWin({ FirstTo: 3, WinnerTeamNumber: 1, Team1Score: 3, Team2Score: 2 })).toBe(false);
        expect(isSweepMatchWin({ FirstTo: 1, WinnerTeamNumber: 1, Team1Score: 1, Team2Score: 0 })).toBe(false);
    });
});
