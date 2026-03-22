import { ResolveFixtureResponse } from '@sports-copilot/shared-types';

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const SPORTMONKS_BASE_URL = 'https://api.sportmonks.com/v3/football';
const OPENAI_FIXTURE_MODEL = 'gpt-5.4-mini';

interface ExtractedFixtureHints {
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  confidence: number;
}

type PresetFixtureFallback = {
  fixtureId: string;
  fixtureName: string;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
};

const PRESET_FIXTURE_FALLBACKS: Array<{
  matchers: string[];
  fixture: PresetFixtureFallback;
}> = [
  {
    matchers: ['barca preset', 'barcelona preset', 'barca'],
    fixture: {
      fixtureId: '19427573',
      fixtureName: 'Barcelona vs Real Madrid',
      homeTeam: 'Barcelona',
      awayTeam: 'Real Madrid',
      competition: 'La Liga',
    },
  },
  {
    matchers: ['rangers preset', 'rangers'],
    fixture: {
      fixtureId: '19428224',
      fixtureName: 'Rangers vs Aberdeen',
      homeTeam: 'Rangers',
      awayTeam: 'Aberdeen',
      competition: null,
    },
  },
];

interface SportmonksFixtureSearchResponse {
  data?: Array<{
    id?: number | string;
    name?: string | null;
    starting_at?: string | null;
    state?: {
      developer_name?: string | null;
      short_name?: string | null;
      name?: string | null;
    } | null;
    league?: {
      name?: string | null;
    } | null;
    participants?: Array<{
      id?: number | string;
      name?: string | null;
      meta?: {
        location?: 'home' | 'away';
      };
    }>;
  }>;
}

type SportmonksFixtureCandidate = NonNullable<SportmonksFixtureSearchResponse['data']>[number];
type SportmonksFixtureParticipant = NonNullable<SportmonksFixtureCandidate['participants']>[number];

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeText(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text: string) {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length > 1);
}

function getKnownPresetFixture(clipName?: string): PresetFixtureFallback | null {
  const normalizedClipName = normalizeText(clipName ?? '');
  if (!normalizedClipName) {
    return null;
  }

  for (const preset of PRESET_FIXTURE_FALLBACKS) {
    if (preset.matchers.some((matcher) => normalizedClipName.includes(normalizeText(matcher)))) {
      return preset.fixture;
    }
  }

  return null;
}

function extractResponseText(payload: unknown) {
  const candidate = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };

  if (typeof candidate.output_text === 'string' && candidate.output_text.trim().length > 0) {
    return candidate.output_text;
  }

  return (
    candidate.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? '')
      .join('')
      .trim() ?? ''
  );
}

async function extractFixtureHintsWithOpenAI(params: {
  screenshotBase64?: string;
  mimeType?: string;
  clipName?: string;
}): Promise<ExtractedFixtureHints> {
  const content: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }> = [
    {
      type: 'input_text',
      text: [
        'You are extracting likely football match hints from a broadcast screenshot or clip label.',
        'Return strict JSON with keys: homeTeam, awayTeam, competition, confidence.',
        'If the input is uncertain, still return your best guess but lower confidence.',
        'Use null for competition if you cannot infer it.',
        params.clipName ? `Clip name hint: ${params.clipName}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  if (params.screenshotBase64 && params.mimeType) {
    content.push({
      type: 'input_image',
      image_url: `data:${params.mimeType};base64,${params.screenshotBase64}`,
    });
  }

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_FIXTURE_MODEL,
      reasoning: { effort: 'low' },
      input: [
        {
          role: 'user',
          content,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI fixture extraction failed: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as unknown;
  const text = extractResponseText(payload);
  if (!text) {
    throw new Error('OpenAI fixture extraction returned no text');
  }

  const parsed = JSON.parse(text) as {
    homeTeam?: string;
    awayTeam?: string;
    competition?: string | null;
    confidence?: number;
  };

  if (!parsed.homeTeam || !parsed.awayTeam) {
    throw new Error('OpenAI fixture extraction returned invalid team hints');
  }

  return {
    homeTeam: parsed.homeTeam.trim(),
    awayTeam: parsed.awayTeam.trim(),
    competition: parsed.competition?.trim() || null,
    confidence: clamp(typeof parsed.confidence === 'number' ? parsed.confidence : 0.5),
  };
}

function getParticipantName(
  participants: SportmonksFixtureCandidate['participants'],
  side: 'home' | 'away',
) {
  return (
    participants?.find((participant: SportmonksFixtureParticipant) => participant.meta?.location === side)?.name?.trim() ??
    participants?.[side === 'home' ? 0 : 1]?.name?.trim() ??
    ''
  );
}

function getFixtureStateValue(
  state: SportmonksFixtureCandidate['state'],
) {
  return `${state?.developer_name ?? ''} ${state?.short_name ?? ''} ${state?.name ?? ''}`
    .toLowerCase()
    .trim();
}

function getOverlapScore(left: string, right: string) {
  const leftTokens = tokenize(left);
  const rightSet = new Set(tokenize(right));
  if (leftTokens.length === 0 || rightSet.size === 0) {
    return 0;
  }

  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  return overlap / Math.max(leftTokens.length, 1);
}

export function rankFixtureCandidates(
  fixtures: NonNullable<SportmonksFixtureSearchResponse['data']>,
  hints: ExtractedFixtureHints,
) {
  return fixtures
    .map((fixture) => {
      const homeTeam = getParticipantName(fixture.participants, 'home');
      const awayTeam = getParticipantName(fixture.participants, 'away');
      const competition = fixture.league?.name?.trim() ?? null;
      const stateValue = getFixtureStateValue(fixture.state);

      let score = 0;
      score += getOverlapScore(hints.homeTeam, homeTeam) * 0.44;
      score += getOverlapScore(hints.awayTeam, awayTeam) * 0.44;

      if (competition && hints.competition) {
        score += getOverlapScore(hints.competition, competition) * 0.12;
      }

      if (stateValue.includes('live') || stateValue.includes('inplay')) {
        score += 0.08;
      }

      return {
        fixture,
        homeTeam,
        awayTeam,
        competition,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);
}

async function searchSportmonksFixtures(params: {
  hints: ExtractedFixtureHints;
  apiToken: string;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = params.fetchImpl ?? fetch;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const start = yesterday.toISOString().slice(0, 10);
  const end = tomorrow.toISOString().slice(0, 10);
  const participantQueries = [...new Set([params.hints.homeTeam, params.hints.awayTeam].filter(Boolean))];
  const fixturesById = new Map<string, SportmonksFixtureCandidate>();

  for (const participantQuery of participantQueries) {
    const url = new URL(`${SPORTMONKS_BASE_URL}/fixtures/between/${start}/${end}`);
    url.searchParams.set('api_token', params.apiToken);
    url.searchParams.set('include', 'participants;league;state');
    url.searchParams.set('filters', `participantSearch:${participantQuery}`);

    const response = await fetchImpl(url.toString(), {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sportmonks fixture search failed: ${response.status} ${body}`);
    }

    const payload = (await response.json()) as SportmonksFixtureSearchResponse;
    for (const fixture of payload.data ?? []) {
      const fixtureId = String(fixture.id ?? '');
      if (!fixtureId) {
        continue;
      }
      fixturesById.set(fixtureId, fixture);
    }
  }

  const ranked = rankFixtureCandidates([...fixturesById.values()], params.hints);
  return ranked[0] ?? null;
}

export async function resolveFixtureFromScreenshot(params: {
  screenshotBase64?: string;
  mimeType?: string;
  clipName?: string;
  sportmonksApiToken?: string;
}): Promise<ResolveFixtureResponse> {
  const presetFixture = getKnownPresetFixture(params.clipName);
  if (presetFixture) {
    return {
      ...presetFixture,
      confidence: 0.99,
      source: 'preset',
    };
  }

  const sportmonksApiToken = params.sportmonksApiToken ?? process.env.SPORTMONKS_API_TOKEN ?? '';
  if (!sportmonksApiToken) {
    throw new Error('SPORTMONKS_API_TOKEN is required for dynamic fixture resolution.');
  }

  const hints = await extractFixtureHintsWithOpenAI({
    screenshotBase64: params.screenshotBase64,
    mimeType: params.mimeType,
    clipName: params.clipName,
  });
  const rankedCandidate = await searchSportmonksFixtures({
    hints,
    apiToken: sportmonksApiToken,
  });

  if (!rankedCandidate) {
    throw new Error(`No Sportmonks fixture matched ${hints.homeTeam} vs ${hints.awayTeam}.`);
  }

  return {
    fixtureId: String(rankedCandidate.fixture.id ?? ''),
    fixtureName: rankedCandidate.fixture.name?.trim() || `${rankedCandidate.homeTeam} vs ${rankedCandidate.awayTeam}`,
    homeTeam: rankedCandidate.homeTeam,
    awayTeam: rankedCandidate.awayTeam,
    competition: rankedCandidate.competition,
    confidence: clamp((rankedCandidate.score + hints.confidence) / 2),
    source: 'openai+sportsmonks',
  };
}
