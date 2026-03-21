import { GameEvent, NarrativeState, createEmptyNarrativeState } from '@sports-copilot/shared-types';
import type { NarrativeFixture } from './retrieval';

const RECENT_NARRATIVE_WINDOW_MS = 20_000;

function unique(values: string[]) {
  return [...new Set(values)];
}

function getLatestEvent(clockMs: number, events: GameEvent[]) {
  return [...events]
    .filter((event) => event.timestamp <= clockMs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
}

function getLatestHighSalienceEvent(clockMs: number, events: GameEvent[]) {
  return [...events]
    .filter(
      (event) =>
        event.highSalience &&
        event.timestamp <= clockMs &&
        clockMs - event.timestamp <= RECENT_NARRATIVE_WINDOW_MS,
    )
    .sort((a, b) => b.timestamp - a.timestamp)[0];
}

function getEventTeam(event?: GameEvent) {
  return typeof event?.data?.team === 'string' ? event.data.team : null;
}

function getEventPlayer(event?: GameEvent) {
  return typeof event?.data?.player === 'string' ? event.data.player : null;
}

function getFixtureNarrative(narratives: NarrativeFixture[], type: string) {
  return narratives.find((narrative) => narrative.type === type);
}

function buildScore(clockMs: number, events: GameEvent[]) {
  return events.reduce(
    (score, event) => {
      if (event.timestamp > clockMs || event.type !== 'GOAL') {
        return score;
      }

      const team = getEventTeam(event);
      if (team === 'BAR') {
        score.home += 1;
      }
      if (team === 'RMA') {
        score.away += 1;
      }

      return score;
    },
    { home: 0, away: 0 },
  );
}

function buildMomentumNarrative(
  latestEvent: GameEvent | undefined,
  narratives: NarrativeFixture[],
): string | null {
  const team = getEventTeam(latestEvent);
  if (!team) {
    return null;
  }

  if (team === 'BAR') {
    const fixtureNarrative = getFixtureNarrative(narratives, 'MOMENTUM');
    return fixtureNarrative?.title ?? "Barcelona's High Press";
  }

  if (team === 'RMA') {
    return 'Real Madrid are flipping the momentum.';
  }

  return null;
}

function buildPlayerSpotlight(
  latestEvent: GameEvent | undefined,
  narratives: NarrativeFixture[],
) {
  const player = getEventPlayer(latestEvent);
  if (!player) {
    return null;
  }

  const fixtureNarrative = getFixtureNarrative(narratives, 'PLAYER_SPOTLIGHT');
  if (
    fixtureNarrative &&
    fixtureNarrative.description.toLowerCase().includes(player.toLowerCase())
  ) {
    return fixtureNarrative.title;
  }

  return `Spotlight on ${player}.`;
}

function buildComebackPressure(clockMs: number, events: GameEvent[]) {
  const score = buildScore(clockMs, events);

  if (score.home === score.away) {
    return null;
  }

  return score.home < score.away
    ? 'Barcelona are under comeback pressure.'
    : 'Real Madrid are under comeback pressure.';
}

function buildDefensiveLapse(latestEvent: GameEvent | undefined) {
  if (latestEvent?.type !== 'CHANCE') {
    return null;
  }

  const team = getEventTeam(latestEvent);
  if (team === 'BAR') {
    return "Real Madrid's back line was stretched open.";
  }

  if (team === 'RMA') {
    return "Barcelona's shape cracked under pressure.";
  }

  return null;
}

export function buildNarrativeState(params: {
  clockMs: number;
  events: GameEvent[];
  narratives: NarrativeFixture[];
}): NarrativeState {
  const { clockMs, events, narratives } = params;
  const baseState = createEmptyNarrativeState();
  const latestHighSalienceEvent = getLatestHighSalienceEvent(clockMs, events);
  const latestEvent = latestHighSalienceEvent ?? getLatestEvent(clockMs, events);
  const rivalryNarrative = getFixtureNarrative(narratives, 'RIVALRY')?.title ?? 'Clásico rivalry';
  const momentumNarrative = buildMomentumNarrative(latestEvent, narratives);
  const playerSpotlight = buildPlayerSpotlight(latestEvent, narratives);
  const comebackPressure = buildComebackPressure(clockMs, events);
  const defensiveLapse = buildDefensiveLapse(latestEvent);
  const activeNarratives = unique(
    [
      momentumNarrative,
      playerSpotlight,
      comebackPressure,
      defensiveLapse,
      rivalryNarrative,
    ].filter((value): value is string => Boolean(value)),
  );
  const topNarrative = activeNarratives[0] ?? null;
  const momentum =
    getEventTeam(latestEvent) === 'BAR'
      ? 'home'
      : getEventTeam(latestEvent) === 'RMA'
        ? 'away'
        : 'neutral';
  const currentSentiment = latestHighSalienceEvent ? 'charged' : 'steady';

  return {
    ...baseState,
    topNarrative,
    activeNarratives,
    currentSentiment,
    momentum,
  };
}
