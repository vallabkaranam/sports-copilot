import { describe, expect, it } from 'vitest';
import {
  buildLiveGameStateSummary,
  buildPossessionLabel,
  buildRosterFromLiveMatch,
  normalizeSportmonksFixture,
} from './sportmonks';

describe('sportmonks normalization', () => {
  it('maps participants, events, lineups, cards, substitutions, and stats into live match state', () => {
    const snapshot = normalizeSportmonksFixture({
      data: {
        id: 19427573,
        state: {
          developer_name: 'LIVE',
          short_name: '1H',
          name: 'First Half',
        },
        participants: [
          {
            id: 14,
            name: 'Barcelona',
            meta: { location: 'home' },
            short_code: 'BAR',
          },
          {
            id: 15,
            name: 'Real Madrid',
            meta: { location: 'away' },
            short_code: 'RMA',
          },
        ],
        scores: [
          { participant_id: 14, score: { participant: 'home', goals: 1 } },
          { participant_id: 15, score: { participant: 'away', goals: 0 } },
        ],
        events: [
          {
            id: 1,
            participant_id: 14,
            minute: 23,
            player_name: 'Robert Lewandowski',
            type: { developer_name: 'goal', name: 'Goal' },
          },
          {
            id: 2,
            participant_id: 15,
            minute: 28,
            player_name: 'Antonio Rudiger',
            type: { developer_name: 'yellow_card', name: 'Yellow Card' },
          },
          {
            id: 3,
            participant_id: 15,
            minute: 61,
            player_name: 'Rodrygo',
            related_player_name: 'Joselu',
            type: { developer_name: 'substitution', name: 'Substitution' },
          },
        ],
        lineups: [
          {
            id: 10,
            participant_id: 14,
            player_id: 100,
            player_name: 'Marc-Andre ter Stegen',
            jersey_number: 1,
            type_id: 11,
            position: { name: 'Goalkeeper' },
            formation: { formation: '4-3-3' },
          },
          {
            id: 11,
            participant_id: 15,
            player_id: 101,
            player_name: 'Jude Bellingham',
            jersey_number: 5,
            type_id: 11,
            position: { name: 'Midfielder' },
            formation: { formation: '4-4-2' },
          },
        ],
        statistics: [
          {
            participant_id: 14,
            data: { value: '61%' },
            type: { name: 'Possession' },
          },
          {
            participant_id: 15,
            data: { value: '3' },
            type: { name: 'Shots On Target' },
          },
        ],
      },
    });

    expect(snapshot.liveMatch.fixtureId).toBe('19427573');
    expect(snapshot.liveMatch.status).toBe('live');
    expect(snapshot.score).toEqual({ home: 1, away: 0 });
    expect(snapshot.events.map((event) => event.type)).toEqual([
      'GOAL',
      'YELLOW_CARD',
      'SUBSTITUTION',
    ]);
    expect(snapshot.liveMatch.cards.find((card) => card.teamSide === 'away')?.yellow).toBe(1);
    expect(snapshot.liveMatch.substitutions[0]?.playerOn).toBe('Joselu');
    expect(snapshot.liveMatch.lineups[0]?.formation).toBe('4-3-3');
    expect(snapshot.liveMatch.stats[0]?.label).toBe('Possession');
  });

  it('builds a live summary, possession label, and roster from normalized live state', () => {
    const snapshot = normalizeSportmonksFixture({
      data: {
        id: 42,
        state: {
          developer_name: 'LIVE',
        },
        participants: [
          { id: 1, name: 'Barcelona', meta: { location: 'home' }, short_code: 'BAR' },
          { id: 2, name: 'Real Madrid', meta: { location: 'away' }, short_code: 'RMA' },
        ],
        scores: [
          { participant_id: 1, score: { participant: 'home', goals: 0 } },
          { participant_id: 2, score: { participant: 'away', goals: 0 } },
        ],
        lineups: [
          {
            id: 10,
            participant_id: 1,
            player_id: 100,
            player_name: 'Pedri',
            jersey_number: 8,
            type_id: 11,
            position: { name: 'Midfielder' },
          },
        ],
        statistics: [
          {
            participant_id: 1,
            data: { value: '58%' },
            type: { name: 'Possession' },
          },
        ],
      },
    });

    expect(
      buildLiveGameStateSummary({
        liveMatch: snapshot.liveMatch,
        events: snapshot.events,
        score: snapshot.score,
      }),
    ).toContain('Barcelona');
    expect(buildPossessionLabel(snapshot.liveMatch, snapshot.liveMatch.stats)).toBe('BAR');
    expect(buildRosterFromLiveMatch(snapshot.liveMatch).home.roster[0]?.name).toBe('Pedri');
  });
});
