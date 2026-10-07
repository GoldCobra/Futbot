// The rated queue is split into modules whose dependencies only point one way:
//   interactionRouter → finishedMatch / season / watchdog → matchmaking → matchFlow → helpers
// service.js is the façade on top. A require cycle would hand some module a half-initialised
// export object at load time, so this test keeps the graph acyclic and the match flow at the bottom.
const fs = require('fs');
const path = require('path');

const QUEUE_DIR = path.join(__dirname, '..', '..', 'src', 'services', 'competitiveRatedQueue');

function localRequires(file) {
    const text = fs.readFileSync(path.join(QUEUE_DIR, file), 'utf8');
    return [...text.matchAll(/require\('\.\/([\w-]+)'\)/g)].map(match => `${match[1]}.js`);
}

const files = fs.readdirSync(QUEUE_DIR).filter(file => file.endsWith('.js'));
const graph = new Map(files.map(file => [file, localRequires(file)]));

test('the rated queue modules have no require cycle', () => {
    const visiting = new Set();
    const done = new Set();
    const cycles = [];
    const visit = (file, trail) => {
        if (done.has(file)) return;
        if (visiting.has(file)) {
            cycles.push([...trail, file].join(' -> '));
            return;
        }
        visiting.add(file);
        for (const dep of graph.get(file) ?? []) visit(dep, [...trail, file]);
        visiting.delete(file);
        done.add(file);
    };
    for (const file of files) visit(file, []);
    expect(cycles).toEqual([]);
});

test.each([
    ['matchFlow.js', ['matchmaking.js', 'watchdog.js', 'season.js', 'finishedMatch.js', 'interactionRouter.js', 'service.js']],
    ['matchmaking.js', ['watchdog.js', 'season.js', 'finishedMatch.js', 'interactionRouter.js', 'service.js']],
    ['watchdog.js', ['season.js', 'finishedMatch.js', 'interactionRouter.js', 'service.js']],
    ['interactionRouter.js', ['service.js']]
])('%s does not depend on the layers above it', (file, forbidden) => {
    expect(graph.get(file).filter(dep => forbidden.includes(dep))).toEqual([]);
});
