const { closePool } = require('../src/db/sqlClient');
const CompetitiveRatingDao = require('../src/db/daos/competitiveRatingDao');

async function rebuild() {
    const dao = new CompetitiveRatingDao();
    const results = await dao.rebuildAllSeasonRewards();
    console.log(JSON.stringify(results, null, 2));
    console.log('Competitive season reward rebuild complete.');
}

rebuild().catch(err => {
    console.error('Competitive season reward rebuild failed:', err.message);
    process.exitCode = 1;
}).finally(closePool);
