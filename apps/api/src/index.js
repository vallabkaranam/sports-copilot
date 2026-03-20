import fastify from 'fastify';
import fs from 'fs/promises';
import path from 'path';
const server = fastify({ logger: true });
// Minimal initial state
let worldState = {
    matchId: 'clásico-2024-demo',
    clock: '00:00',
    score: { home: 0, away: 0 },
    possession: 'BAR',
    recentEvents: [],
};
server.get('/health', async () => {
    return { status: 'ok', matchId: worldState.matchId };
});
server.get('/world-state', async () => {
    return worldState;
});
// Load seed data
const start = async () => {
    try {
        const rosterPath = path.resolve(__dirname, '../../../data/demo_match/roster.json');
        const rosterData = await fs.readFile(rosterPath, 'utf8');
        const roster = JSON.parse(rosterData);
        console.log('Loaded Roster:', roster.home.name, 'vs', roster.away.name);
        await server.listen({ port: 3001, host: '0.0.0.0' });
        console.log('API running on http://localhost:3001');
    }
    catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};
start();
