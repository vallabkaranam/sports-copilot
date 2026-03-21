import { describe, expect, it, vi } from 'vitest';
import { buildPreMatchContext, createDegradedPreMatchState } from './pre-match';

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => data,
  } as Response);
}

describe('pre-match context', () => {
  it('builds recent form, head-to-head, venue, and weather fallback into a session opener', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/fixtures/19686615')) {
        return jsonResponse({
          data: {
            id: 19686615,
            starting_at: '2026-03-20 18:00:00',
            participants: [
              { id: 7466, name: 'Vejle Boldklub', meta: { location: 'home' } },
              { id: 1789, name: 'Odense BK', meta: { location: 'away' } },
            ],
            venue: {
              name: 'Vejle Stadion',
              city_name: 'Vejle',
              country_name: 'Denmark',
              latitude: 55.709,
              longitude: 9.535,
            },
          },
        });
      }

      if (url.includes('/fixtures/between/') && url.includes('/7466')) {
        return jsonResponse({
          data: [
            {
              id: 1,
              starting_at: '2026-03-14 18:00:00',
              participants: [
                { id: 7466, name: 'Vejle Boldklub', meta: { location: 'home' } },
                { id: 999, name: 'Randers FC', meta: { location: 'away' } },
              ],
              scores: [
                { participant_id: 7466, description: 'CURRENT', score: { participant: 'home', goals: 2 } },
                { participant_id: 999, description: 'CURRENT', score: { participant: 'away', goals: 1 } },
              ],
            },
            {
              id: 2,
              starting_at: '2026-03-08 18:00:00',
              participants: [
                { id: 7466, name: 'Vejle Boldklub', meta: { location: 'away' } },
                { id: 1789, name: 'Odense BK', meta: { location: 'home' } },
              ],
              scores: [
                { participant_id: 7466, description: 'CURRENT', score: { participant: 'away', goals: 1 } },
                { participant_id: 1789, description: 'CURRENT', score: { participant: 'home', goals: 1 } },
              ],
            },
          ],
        });
      }

      if (url.includes('/fixtures/between/') && url.includes('/1789')) {
        return jsonResponse({
          data: [
            {
              id: 3,
              starting_at: '2026-03-15 18:00:00',
              participants: [
                { id: 1789, name: 'Odense BK', meta: { location: 'home' } },
                { id: 555, name: 'Aalborg', meta: { location: 'away' } },
              ],
              scores: [
                { participant_id: 1789, description: 'CURRENT', score: { participant: 'home', goals: 3 } },
                { participant_id: 555, description: 'CURRENT', score: { participant: 'away', goals: 0 } },
              ],
            },
            {
              id: 2,
              starting_at: '2026-03-08 18:00:00',
              participants: [
                { id: 7466, name: 'Vejle Boldklub', meta: { location: 'away' } },
                { id: 1789, name: 'Odense BK', meta: { location: 'home' } },
              ],
              scores: [
                { participant_id: 7466, description: 'CURRENT', score: { participant: 'away', goals: 1 } },
                { participant_id: 1789, description: 'CURRENT', score: { participant: 'home', goals: 1 } },
              ],
            },
          ],
        });
      }

      if (url.includes('api.open-meteo.com')) {
        return jsonResponse({
          current: {
            temperature_2m: 8.4,
            precipitation: 0,
            wind_speed_10m: 12.2,
            weather_code: 1,
          },
        });
      }

      if (url.includes('/responses')) {
        expect(init?.method).toBe('POST');
        return jsonResponse({
          output_text: 'Both sides arrive with form, and the weather should stay clear in Vejle.',
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    const preMatch = await buildPreMatchContext({
      apiToken: 'token',
      fixtureId: '19686615',
      openAiApiKey: 'openai-token',
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(preMatch.homeRecentForm.teamName).toBe('Vejle Boldklub');
    expect(preMatch.awayRecentForm.teamName).toBe('Odense BK');
    expect(preMatch.headToHead.meetings).toHaveLength(1);
    expect(preMatch.venue.name).toBe('Vejle Stadion');
    expect(preMatch.weather?.source).toBe('open-meteo');
    expect(preMatch.aiOpener).toContain('weather should stay clear');
    expect(preMatch.deterministicOpener).toContain('Vejle Stadion');
  });

  it('falls back to deterministic output when OpenAI is disabled', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/fixtures/42')) {
        return jsonResponse({
          data: {
            id: 42,
            starting_at: '2026-03-20 18:00:00',
            participants: [
              { id: 1, name: 'Barcelona', meta: { location: 'home' } },
              { id: 2, name: 'Real Madrid', meta: { location: 'away' } },
            ],
            venue: {
              name: 'Estadi Olimpic',
              city_name: 'Barcelona',
              country_name: 'Spain',
            },
          },
        });
      }

      if (url.includes('/fixtures/between/') && (url.includes('/1') || url.includes('/2'))) {
        return jsonResponse({ data: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    const preMatch = await buildPreMatchContext({
      apiToken: 'token',
      fixtureId: '42',
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(preMatch.aiOpener).toBeNull();
    expect(preMatch.deterministicOpener).toContain('Estadi Olimpic');
  });

  it('creates a degraded pre-match state when setup fails upstream', () => {
    const degraded = createDegradedPreMatchState('Pre-match context unavailable.');

    expect(degraded.loadStatus).toBe('degraded');
    expect(degraded.deterministicOpener).toContain('unavailable');
  });
});
