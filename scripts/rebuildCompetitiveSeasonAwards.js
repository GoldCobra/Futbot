const { closePool } = require('../src/db/sqlClient');
const CompetitiveRatingDao = require('../src/db/daos/competitiveRatingDao');

async function rebuild() {
    const dao = new CompetitiveRatingDao();
    const results = await dao.rebuildAllSeasonAwards();
    console.log(JSON.stringify(results, null, 2));
    console.log('Competitive season award rebuild complete.');
}

rebuild().catch(err => {
    console.error('Competitive season award rebuild failed:', err.message);
    process.exitCode = 1;
}).finally(closePool);
