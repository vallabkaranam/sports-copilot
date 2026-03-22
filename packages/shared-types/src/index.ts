import { z } from 'zod';

/**
 * Shared Style Modes for the assistant
 */
export const StyleModeSchema = z.enum(['hype', 'analyst']);
export type StyleMode = z.infer<typeof StyleModeSchema>;

export const AssistUrgencySchema = z.enum(['low', 'medium', 'high']);
export type AssistUrgency = z.infer<typeof AssistUrgencySchema>;

export const ReplayPlaybackStatusSchema = z.enum(['playing', 'paused']);
export type ReplayPlaybackStatus = z.infer<typeof ReplayPlaybackStatusSchema>;

export const TeamSideSchema = z.enum(['home', 'away', 'neutral']);
export type TeamSide = z.infer<typeof TeamSideSchema>;

export const LiveMatchStatusSchema = z.enum([
  'not_started',
  'live',
  'halftime',
  'paused',
  'full_time',
  'postponed',
  'cancelled',
  'unknown',
]);
export type LiveMatchStatus = z.infer<typeof LiveMatchStatusSchema>;

/**
 * Transcript speaker labels
 */
export const SpeakerSchema = z.enum(['lead', 'cohost']);
export type Speaker = z.infer<typeof SpeakerSchema>;

export const ActiveSpeakerSchema = z.enum(['lead', 'cohost', 'none']);
export type ActiveSpeaker = z.infer<typeof ActiveSpeakerSchema>;

/**
 * Structured transcript entries shared across replay and commentary analysis
 */
export const TranscriptEntrySchema = z.object({
  timestamp: z.number(),
  text: z.string(),
  speaker: SpeakerSchema,
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

/**
 * Suggested toss-up cues for bringing in the co-host
 */
export const CoHostTossUpCueSchema = z.object({
  question: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  sourceEventId: z.string(),
  sourceEventType: z.string(),
});
export type CoHostTossUpCue = z.infer<typeof CoHostTossUpCueSchema>;

export const MemoryTierSchema = z.enum(['static', 'session', 'live', 'pre_match', 'user']);
export type MemoryTier = z.infer<typeof MemoryTierSchema>;

export const PreMatchChunkCategorySchema = z.enum([
  'recent-form',
  'head-to-head',
  'venue',
  'weather',
  'opener',
  'trend',
]);
export type PreMatchChunkCategory = z.infer<typeof PreMatchChunkCategorySchema>;

export const RetrievalPhaseHintSchema = z.enum([
  'pre_kickoff',
  'early_match',
  'quiet_stretch',
  'general',
]);
export type RetrievalPhaseHint = z.infer<typeof RetrievalPhaseHintSchema>;

export const SocialPostSchema = z.object({
  timestamp: z.number(),
  handle: z.string(),
  text: z.string(),
  sentiment: z.string(),
});
export type SocialPost = z.infer<typeof SocialPostSchema>;

export const VisionCueTagSchema = z.enum([
  'attack',
  'replay',
  'crowd-reaction',
  'player-close-up',
  'coach-reaction',
  'celebration',
  'set-piece',
  'stoppage',
]);
export type VisionCueTag = z.infer<typeof VisionCueTagSchema>;

export const VisionCueSchema = z.object({
  timestamp: z.number(),
  tag: VisionCueTagSchema,
  label: z.string(),
});
export type VisionCue = z.infer<typeof VisionCueSchema>;

export const VisionFrameSchema = z.object({
  timestamp: z.number(),
  description: z.string(),
});
export type VisionFrame = z.infer<typeof VisionFrameSchema>;

/**
 * Source attribution chips
 */
export const SourceChipSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  relevance: z.number().min(0).max(1),
  metadata: z
    .object({
      chunkCategory: PreMatchChunkCategorySchema.optional(),
      teamSide: TeamSideSchema.optional(),
      fixtureId: z.string().optional(),
      documentId: z.string().optional(),
      userProvided: z.boolean().optional(),
      phaseHints: z.array(RetrievalPhaseHintSchema).optional(),
    })
    .optional(),
});
export type SourceChip = z.infer<typeof SourceChipSchema>;

export const AgentExecutionStateSchema = z.enum(['quiet', 'ready', 'active', 'waiting']);
export type AgentExecutionState = z.infer<typeof AgentExecutionStateSchema>;

export const AgentExplainabilitySchema = z.object({
  agentName: z.string(),
  output: z.string(),
  reasoningTrace: z.array(z.string()),
  sourcesUsed: z.array(SourceChipSchema),
  state: AgentExecutionStateSchema,
});
export type AgentExplainability = z.infer<typeof AgentExplainabilitySchema>;

export const GenerationExplainabilitySchema = z.object({
  contributingAgents: z.array(AgentExplainabilitySchema),
  reasoningTrace: z.array(z.string()),
  sourcesUsed: z.array(SourceChipSchema),
});
export type GenerationExplainability = z.infer<typeof GenerationExplainabilitySchema>;

export const RetrievalScoreBreakdownSchema = z.object({
  lexical: z.number().min(0).max(1),
  semantic: z.number().min(0).max(1),
  freshness: z.number().min(0).max(1),
  tier: z.number().min(0).max(1),
  total: z.number().min(0).max(1),
});
export type RetrievalScoreBreakdown = z.infer<typeof RetrievalScoreBreakdownSchema>;

export const RetrievedFactSchema = z.object({
  id: z.string(),
  tier: MemoryTierSchema,
  text: z.string(),
  source: z.string(),
  timestamp: z.number().nullable(),
  relevance: z.number().min(0).max(1),
  metadata: z
    .object({
      chunkCategory: PreMatchChunkCategorySchema.optional(),
      teamSide: TeamSideSchema.optional(),
      fixtureId: z.string().optional(),
      documentId: z.string().optional(),
      userProvided: z.boolean().optional(),
      phaseHints: z.array(RetrievalPhaseHintSchema).optional(),
    })
    .optional(),
  scoreBreakdown: RetrievalScoreBreakdownSchema.optional(),
  usedByAgents: z.array(z.string()).optional(),
  sourceChip: SourceChipSchema,
});
export type RetrievedFact = z.infer<typeof RetrievedFactSchema>;

export const RetrievalStateSchema = z.object({
  query: z.string(),
  supportingFacts: z.array(RetrievedFactSchema),
  unusedFacts: z.array(RetrievedFactSchema).default([]),
});
export type RetrievalState = z.infer<typeof RetrievalStateSchema>;

export const ContextBundleLaneSchema = z.enum([
  'live-moment',
  'social-pulse',
  'pre-match',
  'session-thread',
  'user-context',
]);
export type ContextBundleLane = z.infer<typeof ContextBundleLaneSchema>;

export const ContextBundleItemSchema = z.object({
  id: z.string(),
  lane: ContextBundleLaneSchema,
  headline: z.string(),
  detail: z.string(),
  expiresAt: z.number().int().nonnegative().nullable(),
  salience: z.number().min(0).max(1),
  sourceChip: SourceChipSchema,
});
export type ContextBundleItem = z.infer<typeof ContextBundleItemSchema>;

export const ContextBundleSchema = z.object({
  summary: z.string(),
  items: z.array(ContextBundleItemSchema),
});
export type ContextBundle = z.infer<typeof ContextBundleSchema>;

export function createEmptyContextBundle(): ContextBundle {
  return {
    summary: 'Context rack is waiting for the next live beat.',
    items: [],
  };
}

export const LiveStreamContextEventSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  source: z.enum(['event', 'transcript', 'vision', 'scoreboard']),
  headline: z.string(),
  detail: z.string(),
  salience: z.number().min(0).max(1),
});
export type LiveStreamContextEvent = z.infer<typeof LiveStreamContextEventSchema>;

export const LiveStreamContextSchema = z.object({
  windowStartMs: z.number().int().nonnegative(),
  windowEndMs: z.number().int().nonnegative(),
  windowMs: z.number().int().positive(),
  summary: z.string(),
  teams: z.object({
    home: z.string(),
    away: z.string(),
  }),
  scoreState: z.object({
    clock: z.string(),
    status: z.string(),
    home: z.number(),
    away: z.number(),
  }),
  momentumHint: z.string(),
  recentEvents: z.array(LiveStreamContextEventSchema),
  transcriptSnippets: z.array(z.string()),
  signalSummary: z.array(z.string()),
});
export type LiveStreamContext = z.infer<typeof LiveStreamContextSchema>;

export function createEmptyLiveStreamContext(): LiveStreamContext {
  return {
    windowStartMs: 0,
    windowEndMs: 0,
    windowMs: 12_000,
    summary: 'Live stream context is waiting for the next active beat.',
    teams: {
      home: '',
      away: '',
    },
    scoreState: {
      clock: '00:00',
      status: 'waiting',
      home: 0,
      away: 0,
    },
    momentumHint: 'Balanced',
    recentEvents: [],
    transcriptSnippets: [],
    signalSummary: [],
  };
}

/**
 * Assist cards displayed to the commentator
 */
export const AssistCardSchema = z.object({
  type: z.enum([
    'hype',
    'context',
    'stat',
    'narrative',
    'transition',
    'co-host-tossup',
    'none',
  ]),
  text: z.string(),
  styleMode: StyleModeSchema,
  urgency: AssistUrgencySchema,
  confidence: z.number().min(0).max(1),
  whyNow: z.string(),
  sourceChips: z.array(SourceChipSchema),
});
export type AssistCard = z.infer<typeof AssistCardSchema>;

export function createEmptyAssistCard(): AssistCard {
  return {
    type: 'none',
    text: '',
    styleMode: 'analyst',
    urgency: 'low',
    confidence: 0,
    whyNow: 'No assist needed right now.',
    sourceChips: [],
  };
}

/**
 * Individual Match Events
 */
export const GameEventSchema = z.object({
  id: z.string(),
  timestamp: z.number(), // Match time in ms or epoch
  matchTime: z.string(), // "12:05" format
  type: z.string(),
  provider: z.string().optional(),
  providerEventId: z.string().optional(),
  teamSide: TeamSideSchema.optional(),
  description: z.string(),
  highSalience: z.boolean(),
  data: z.record(z.string(), z.any()).optional(),
});
export type GameEvent = z.infer<typeof GameEventSchema>;

export const LiveTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  shortCode: z.string(),
  logoUrl: z.string().nullable(),
});
export type LiveTeam = z.infer<typeof LiveTeamSchema>;

export const LiveLineupPlayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  number: z.number().nullable(),
  position: z.string().nullable(),
  formationPosition: z.string().nullable(),
  starter: z.boolean(),
});
export type LiveLineupPlayer = z.infer<typeof LiveLineupPlayerSchema>;

export const LiveLineupTeamSchema = z.object({
  teamSide: TeamSideSchema,
  teamId: z.string(),
  teamName: z.string(),
  formation: z.string().nullable(),
  startingXI: z.array(LiveLineupPlayerSchema),
  bench: z.array(LiveLineupPlayerSchema),
});
export type LiveLineupTeam = z.infer<typeof LiveLineupTeamSchema>;

export const LiveCardSummarySchema = z.object({
  teamSide: TeamSideSchema,
  yellow: z.number().int().nonnegative(),
  red: z.number().int().nonnegative(),
});
export type LiveCardSummary = z.infer<typeof LiveCardSummarySchema>;

export const LiveSubstitutionSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  matchTime: z.string(),
  teamSide: TeamSideSchema,
  playerOff: z.string(),
  playerOn: z.string(),
});
export type LiveSubstitution = z.infer<typeof LiveSubstitutionSchema>;

export const LiveTeamStatSchema = z.object({
  teamSide: TeamSideSchema,
  label: z.string(),
  value: z.string(),
});
export type LiveTeamStat = z.infer<typeof LiveTeamStatSchema>;

export const LiveMatchStateSchema = z.object({
  provider: z.string(),
  fixtureId: z.string(),
  status: LiveMatchStatusSchema,
  period: z.string().nullable(),
  minute: z.number().int().nonnegative(),
  stoppageMinute: z.number().int().nonnegative().nullable(),
  lastUpdatedAt: z.number(),
  isDegraded: z.boolean(),
  degradedReason: z.string().nullable(),
  homeTeam: LiveTeamSchema,
  awayTeam: LiveTeamSchema,
  lineups: z.array(LiveLineupTeamSchema),
  cards: z.array(LiveCardSummarySchema),
  substitutions: z.array(LiveSubstitutionSchema),
  stats: z.array(LiveTeamStatSchema),
});
export type LiveMatchState = z.infer<typeof LiveMatchStateSchema>;

export const MatchResultSchema = z.enum(['win', 'draw', 'loss', 'unknown']);
export type MatchResult = z.infer<typeof MatchResultSchema>;

export const PreMatchLoadStatusSchema = z.enum(['pending', 'ready', 'degraded']);
export type PreMatchLoadStatus = z.infer<typeof PreMatchLoadStatusSchema>;

export const RecentMatchSummarySchema = z.object({
  fixtureId: z.string(),
  kickoffAt: z.string(),
  opponent: z.string(),
  venue: z.enum(['home', 'away', 'neutral']),
  scoreFor: z.number(),
  scoreAgainst: z.number(),
  result: MatchResultSchema,
});
export type RecentMatchSummary = z.infer<typeof RecentMatchSummarySchema>;

export const TeamRecentFormSchema = z.object({
  teamSide: TeamSideSchema,
  teamName: z.string(),
  record: z.object({
    wins: z.number().int().nonnegative(),
    draws: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
  }),
  lastFive: z.array(RecentMatchSummarySchema),
});
export type TeamRecentForm = z.infer<typeof TeamRecentFormSchema>;

export const HeadToHeadSummarySchema = z.object({
  meetings: z.array(RecentMatchSummarySchema),
  homeWins: z.number().int().nonnegative(),
  awayWins: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  summary: z.string(),
});
export type HeadToHeadSummary = z.infer<typeof HeadToHeadSummarySchema>;

export const VenueSummarySchema = z.object({
  name: z.string(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  capacity: z.number().int().nonnegative().nullable(),
  surface: z.string().nullable(),
});
export type VenueSummary = z.infer<typeof VenueSummarySchema>;

export const WeatherSummarySchema = z.object({
  summary: z.string(),
  temperatureC: z.number().nullable(),
  windKph: z.number().nullable(),
  precipitationMm: z.number().nullable(),
  source: z.string(),
  isFallback: z.boolean(),
});
export type WeatherSummary = z.infer<typeof WeatherSummarySchema>;

export const TeamScoringTrendSummarySchema = z.object({
  teamSide: TeamSideSchema,
  teamName: z.string(),
  sampleSize: z.number().int().nonnegative(),
  matchesScoredIn: z.number().int().nonnegative(),
  matchesConcededIn: z.number().int().nonnegative(),
  averageGoalsFor: z.number().nonnegative(),
  averageGoalsAgainst: z.number().nonnegative(),
  matchesOverTwoPointFive: z.number().int().nonnegative(),
  bothTeamsScoredMatches: z.number().int().nonnegative(),
  summary: z.string(),
});
export type TeamScoringTrendSummary = z.infer<typeof TeamScoringTrendSummarySchema>;

export const TeamFirstToScorePatternSchema = z.object({
  teamSide: TeamSideSchema,
  teamName: z.string(),
  sampleSize: z.number().int().nonnegative(),
  scoredFirst: z.number().int().nonnegative(),
  concededFirst: z.number().int().nonnegative(),
  scorelessMatches: z.number().int().nonnegative(),
  unknownMatches: z.number().int().nonnegative(),
  summary: z.string(),
});
export type TeamFirstToScorePattern = z.infer<typeof TeamFirstToScorePatternSchema>;

export const PreMatchSourceMetadataSchema = z.object({
  provider: z.string(),
  fetchedAt: z.number(),
  sourceNotes: z.array(z.string()),
  usedWeatherFallback: z.boolean(),
});
export type PreMatchSourceMetadata = z.infer<typeof PreMatchSourceMetadataSchema>;

export const PreMatchStateSchema = z.object({
  loadStatus: PreMatchLoadStatusSchema,
  generatedAt: z.number(),
  homeRecentForm: TeamRecentFormSchema,
  awayRecentForm: TeamRecentFormSchema,
  headToHead: HeadToHeadSummarySchema,
  venue: VenueSummarySchema,
  weather: WeatherSummarySchema.nullable(),
  homeScoringTrend: TeamScoringTrendSummarySchema,
  awayScoringTrend: TeamScoringTrendSummarySchema,
  homeFirstToScore: TeamFirstToScorePatternSchema,
  awayFirstToScore: TeamFirstToScorePatternSchema,
  deterministicOpener: z.string(),
  aiOpener: z.string().nullable(),
  sourceMetadata: PreMatchSourceMetadataSchema,
});
export type PreMatchState = z.infer<typeof PreMatchStateSchema>;

export function createEmptyLiveMatchState(): LiveMatchState {
  return {
    provider: 'sportmonks',
    fixtureId: '',
    status: 'unknown',
    period: null,
    minute: 0,
    stoppageMinute: null,
    lastUpdatedAt: 0,
    isDegraded: false,
    degradedReason: null,
    homeTeam: {
      id: 'home',
      name: 'Home',
      shortCode: 'HOME',
      logoUrl: null,
    },
    awayTeam: {
      id: 'away',
      name: 'Away',
      shortCode: 'AWAY',
      logoUrl: null,
    },
    lineups: [],
    cards: [
      { teamSide: 'home', yellow: 0, red: 0 },
      { teamSide: 'away', yellow: 0, red: 0 },
    ],
    substitutions: [],
    stats: [],
  };
}

function createEmptyTeamRecentForm(teamSide: TeamSide, teamName: string): TeamRecentForm {
  return {
    teamSide,
    teamName,
    record: {
      wins: 0,
      draws: 0,
      losses: 0,
    },
    lastFive: [],
  };
}

function createEmptyTeamScoringTrend(teamSide: TeamSide, teamName: string): TeamScoringTrendSummary {
  return {
    teamSide,
    teamName,
    sampleSize: 0,
    matchesScoredIn: 0,
    matchesConcededIn: 0,
    averageGoalsFor: 0,
    averageGoalsAgainst: 0,
    matchesOverTwoPointFive: 0,
    bothTeamsScoredMatches: 0,
    summary: `${teamName} scoring trends are not loaded yet.`,
  };
}

function createEmptyFirstToScorePattern(teamSide: TeamSide, teamName: string): TeamFirstToScorePattern {
  return {
    teamSide,
    teamName,
    sampleSize: 0,
    scoredFirst: 0,
    concededFirst: 0,
    scorelessMatches: 0,
    unknownMatches: 0,
    summary: `${teamName} first-to-score pattern is not loaded yet.`,
  };
}

export function createEmptyPreMatchState(): PreMatchState {
  return {
    loadStatus: 'pending',
    generatedAt: 0,
    homeRecentForm: createEmptyTeamRecentForm('home', 'Home'),
    awayRecentForm: createEmptyTeamRecentForm('away', 'Away'),
    headToHead: {
      meetings: [],
      homeWins: 0,
      awayWins: 0,
      draws: 0,
      summary: 'Head-to-head history is not loaded yet.',
    },
    venue: {
      name: 'Venue pending',
      city: null,
      country: null,
      capacity: null,
      surface: null,
    },
    weather: null,
    homeScoringTrend: createEmptyTeamScoringTrend('home', 'Home'),
    awayScoringTrend: createEmptyTeamScoringTrend('away', 'Away'),
    homeFirstToScore: createEmptyFirstToScorePattern('home', 'Home'),
    awayFirstToScore: createEmptyFirstToScorePattern('away', 'Away'),
    deterministicOpener: 'Pre-match context is loading.',
    aiOpener: null,
    sourceMetadata: {
      provider: 'sportmonks',
      fetchedAt: 0,
      sourceNotes: [],
      usedWeatherFallback: false,
    },
  };
}

export const SessionMemorySchema = z.object({
  recentEvents: z.array(GameEventSchema),
  surfacedAssists: z.array(AssistCardSchema),
  recentCommentary: z.array(TranscriptEntrySchema),
});
export type SessionMemory = z.infer<typeof SessionMemorySchema>;

export function createEmptySessionMemory(): SessionMemory {
  return {
    recentEvents: [],
    surfacedAssists: [],
    recentCommentary: [],
  };
}

/**
 * Commentator state trackers
 */
export const CommentatorStateSchema = z.object({
  activeSpeaker: ActiveSpeakerSchema,
  isSpeaking: z.boolean(),
  coHostIsSpeaking: z.boolean(),
  coHostTossUp: CoHostTossUpCueSchema.nullable(),
  pauseDurationMs: z.number(),
  fillerWords: z.array(z.string()),
  repeatedPhrases: z.array(z.string()),
  unfinishedPhrase: z.boolean(),
  hesitationScore: z.number().min(0).max(1),
  hesitationReasons: z.array(z.string()),
  shouldSuppressAssist: z.boolean(),
  lastLeadSpokeAt: z.number(),
  recentTranscript: z.array(TranscriptEntrySchema),
});
export type CommentatorState = z.infer<typeof CommentatorStateSchema>;

export function createEmptyCommentatorState(): CommentatorState {
  return {
    activeSpeaker: 'none',
    isSpeaking: false,
    coHostIsSpeaking: false,
    coHostTossUp: null,
    pauseDurationMs: 0,
    fillerWords: [],
    repeatedPhrases: [],
    unfinishedPhrase: false,
    hesitationScore: 0,
    hesitationReasons: [],
    shouldSuppressAssist: false,
    lastLeadSpokeAt: -1,
    recentTranscript: [],
  };
}

export function createEmptyRetrievalState(): RetrievalState {
  return {
    query: '',
    supportingFacts: [],
    unusedFacts: [],
  };
}

/**
 * Narrative state
 */
export const NarrativeStateSchema = z.object({
  topNarrative: z.string().nullable(),
  activeNarratives: z.array(z.string()),
  currentSentiment: z.string(),
  momentum: z.enum(['home', 'away', 'neutral']),
});
export type NarrativeState = z.infer<typeof NarrativeStateSchema>;

export function createEmptyNarrativeState(): NarrativeState {
  return {
    topNarrative: null,
    activeNarratives: [],
    currentSentiment: 'neutral',
    momentum: 'neutral',
  };
}

export const ReplayControlStateSchema = z.object({
  playbackStatus: ReplayPlaybackStatusSchema,
  preferredStyleMode: StyleModeSchema,
  forceHesitation: z.boolean(),
  restartToken: z.number().int().nonnegative(),
  activeFixtureId: z.string().optional(),
});
export type ReplayControlState = z.infer<typeof ReplayControlStateSchema>;

export function createDefaultReplayControlState(): ReplayControlState {
  return {
    playbackStatus: 'playing',
    preferredStyleMode: 'analyst',
    forceHesitation: false,
    restartToken: 0,
    activeFixtureId: undefined,
  };
}

/**
 * Global World State
 */
export const WorldStateSchema = z.object({
  matchId: z.string(),
  clock: z.string(),
  score: z.object({
    home: z.number(),
    away: z.number(),
  }),
  possession: z.string(),
  gameStateSummary: z.string(),
  highSalienceMoments: z.array(GameEventSchema),
  recentEvents: z.array(GameEventSchema),
  sessionMemory: SessionMemorySchema,
  commentator: CommentatorStateSchema,
  narrative: NarrativeStateSchema,
  retrieval: RetrievalStateSchema,
  contextBundle: ContextBundleSchema,
  liveStreamContext: LiveStreamContextSchema,
  assist: AssistCardSchema,
  preMatch: PreMatchStateSchema,
  liveMatch: LiveMatchStateSchema,
  liveSignals: z.object({
    social: z.array(SocialPostSchema),
    vision: z.array(VisionCueSchema),
    commentary: z.array(TranscriptEntrySchema),
  }),
  orchestration: z
    .object({
      agentRuns: z.array(AgentExplainabilitySchema),
      agentWeights: z.array(
        z.object({
          agentName: z.string(),
          weight: z.number().min(0).max(1),
          reasons: z.array(z.string()),
        }),
      ),
      retrievalReasoning: z.array(z.string()),
      memoryState: z.array(z.string()),
      lastGeneration: GenerationExplainabilitySchema.nullable(),
      confidenceReason: z.string().nullable(),
    })
    .optional(),
});
export type WorldState = z.infer<typeof WorldStateSchema>;

export const BoothSessionSampleSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  hesitationScore: z.number().min(0).max(1),
  confidenceScore: z.number().min(0).max(1),
  pauseDurationMs: z.number().int().nonnegative(),
  audioLevel: z.number().min(0).max(1),
  isSpeaking: z.boolean(),
  triggerBadges: z.array(z.string()),
  activeAssistText: z.string().nullable(),
  featureSnapshot: z.unknown().optional(),
  interpretation: z.unknown().optional(),
});
export type BoothSessionSample = z.infer<typeof BoothSessionSampleSchema>;

export const BoothSessionStatusSchema = z.enum(['active', 'completed']);
export type BoothSessionStatus = z.infer<typeof BoothSessionStatusSchema>;

export const BoothSessionSummarySchema = z.object({
  id: z.string(),
  clipName: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: BoothSessionStatusSchema,
  sampleCount: z.number().int().nonnegative(),
  maxHesitationScore: z.number().min(0).max(1),
  maxConfidenceScore: z.number().min(0).max(1),
  longestPauseMs: z.number().int().nonnegative(),
  assistCount: z.number().int().nonnegative(),
  lastTriggerBadges: z.array(z.string()),
});
export type BoothSessionSummary = z.infer<typeof BoothSessionSummarySchema>;

export const BoothSessionAnalyticsSchema = z.object({
  totalSessions: z.number().int().nonnegative(),
  completedSessions: z.number().int().nonnegative(),
  averageMaxHesitationScore: z.number().min(0).max(1),
  averageLongestPauseMs: z.number().int().nonnegative(),
  totalAssistCount: z.number().int().nonnegative(),
});
export type BoothSessionAnalytics = z.infer<typeof BoothSessionAnalyticsSchema>;

export const BoothSessionRecordSchema = BoothSessionSummarySchema.extend({
  samples: z.array(BoothSessionSampleSchema),
});
export type BoothSessionRecord = z.infer<typeof BoothSessionRecordSchema>;

export const BoothSessionsResponseSchema = z.object({
  analytics: BoothSessionAnalyticsSchema,
  sessions: z.array(BoothSessionSummarySchema),
});
export type BoothSessionsResponse = z.infer<typeof BoothSessionsResponseSchema>;

export const BoothSessionReviewSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  strengths: z.array(z.string()),
  watchouts: z.array(z.string()),
  coachingNotes: z.array(z.string()),
});
export type BoothSessionReview = z.infer<typeof BoothSessionReviewSchema>;

export const StartBoothSessionInputSchema = z.object({
  clipName: z.string().min(1),
});
export type StartBoothSessionInput = z.infer<typeof StartBoothSessionInputSchema>;

export const StartBoothSessionResponseSchema = z.object({
  session: BoothSessionSummarySchema,
});
export type StartBoothSessionResponse = z.infer<typeof StartBoothSessionResponseSchema>;

export const AppendBoothSessionSampleInputSchema = z.object({
  sample: BoothSessionSampleSchema,
});
export type AppendBoothSessionSampleInput = z.infer<typeof AppendBoothSessionSampleInputSchema>;

export const FinishBoothSessionInputSchema = z.object({
  endedAt: z.string().optional(),
});
export type FinishBoothSessionInput = z.infer<typeof FinishBoothSessionInputSchema>;

export const BoothInterpretationStateSchema = z.enum([
  'standby',
  'monitoring',
  'step-in',
  'weaning-off',
]);
export type BoothInterpretationState = z.infer<typeof BoothInterpretationStateSchema>;

export const BoothSpeakerProfileSchema = z.object({
  totalSessions: z.number().int().nonnegative(),
  totalSamples: z.number().int().nonnegative(),
  averageMaxHesitationScore: z.number().min(0).max(1),
  averageRecoveryScore: z.number().min(0).max(1),
  averagePauseDurationMs: z.number().int().nonnegative(),
  averageSpeechStreakMs: z.number().int().nonnegative(),
  averageFillerDensity: z.number().min(0).max(1),
  averageRepeatedOpenings: z.number().min(0).max(1),
  averageTranscriptStability: z.number().min(0).max(1),
  averageWordsPerMinute: z.number().min(0).optional(),
  averagePacePressure: z.number().min(0).max(1).optional(),
  averageRepeatedIdeas: z.number().min(0).optional(),
  wakePhrase: z.string().nullable(),
});
export type BoothSpeakerProfile = z.infer<typeof BoothSpeakerProfileSchema>;

export const BoothFeatureSnapshotSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  hesitationScore: z.number().min(0).max(1),
  confidenceScore: z.number().min(0).max(1),
  pauseDurationMs: z.number().int().nonnegative(),
  speechStreakMs: z.number().int().nonnegative(),
  silenceStreakMs: z.number().int().nonnegative(),
  audioLevel: z.number().min(0).max(1),
  isSpeaking: z.boolean(),
  hasVoiceActivity: z.boolean(),
  fillerCount: z.number().int().nonnegative(),
  fillerDensity: z.number().min(0).max(1),
  fillerWords: z.array(z.string()),
  repeatedOpeningCount: z.number().int().nonnegative(),
  repeatedPhrases: z.array(z.string()),
  unfinishedPhrase: z.boolean(),
  transcriptWordCount: z.number().int().nonnegative(),
  transcriptStabilityScore: z.number().min(0).max(1),
  wordsPerMinute: z.number().min(0).optional(),
  pacePressureScore: z.number().min(0).max(1).optional(),
  repeatedIdeaCount: z.number().int().nonnegative().optional(),
  repeatedIdeaPhrases: z.array(z.string()).optional(),
  hesitationReasons: z.array(z.string()),
  transcriptWindow: z.array(TranscriptEntrySchema),
  interimTranscript: z.string(),
  contextSummary: z.string().optional(),
  expectedTopics: z.array(z.string()).optional(),
  wakePhraseDetected: z.boolean().optional(),
  previousState: BoothInterpretationStateSchema.optional(),
});
export type BoothFeatureSnapshot = z.infer<typeof BoothFeatureSnapshotSchema>;

export const BoothInterpretationSignalSchema = z.object({
  key: z.enum([
    'pauseDurationMs',
    'pauseVsBaseline',
    'speechStreakMs',
    'silenceStreakMs',
    'audioLevel',
    'fillerCount',
    'fillerDensity',
    'fillerVsBaseline',
    'repeatedOpeningCount',
    'repeatedIdeaCount',
    'unfinishedPhrase',
    'transcriptStabilityScore',
    'wordsPerMinute',
    'pacePressureScore',
    'paceVsBaseline',
    'wakePhraseDetected',
  ]),
  label: z.string(),
  value: z.union([z.number(), z.boolean()]),
  detail: z.string(),
});
export type BoothInterpretationSignal = z.infer<typeof BoothInterpretationSignalSchema>;

export const BoothInterpretationSchema = z.object({
  state: BoothInterpretationStateSchema,
  hesitationScore: z.number().min(0).max(1),
  recoveryScore: z.number().min(0).max(1),
  shouldSurfaceAssist: z.boolean(),
  summary: z.string(),
  reasons: z.array(z.string()),
  signals: z.array(BoothInterpretationSignalSchema),
  confidenceReason: z.string().optional(),
  explainability: GenerationExplainabilitySchema.optional(),
  source: z.enum(['openai', 'unavailable']),
});
export type BoothInterpretation = z.infer<typeof BoothInterpretationSchema>;

export const InterpretBoothInputSchema = z.object({
  features: BoothFeatureSnapshotSchema,
  profile: BoothSpeakerProfileSchema.optional(),
});
export type InterpretBoothInput = z.infer<typeof InterpretBoothInputSchema>;

export const TranscribeBoothAudioInputSchema = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().min(1),
});
export type TranscribeBoothAudioInput = z.infer<typeof TranscribeBoothAudioInputSchema>;

export const TranscribeBoothAudioResponseSchema = z.object({
  transcript: z.string(),
  source: z.enum(['openai', 'unavailable']),
});
export type TranscribeBoothAudioResponse = z.infer<typeof TranscribeBoothAudioResponseSchema>;

export const GenerateBoothCueInputSchema = z.object({
  features: BoothFeatureSnapshotSchema,
  interpretation: BoothInterpretationSchema.optional(),
  retrieval: RetrievalStateSchema,
  preMatch: PreMatchStateSchema.optional(),
  liveMatch: LiveMatchStateSchema.optional(),
  contextBundle: ContextBundleSchema.optional(),
  liveStreamContext: LiveStreamContextSchema.optional(),
  recentEvents: z.array(GameEventSchema).optional(),
  liveSignals: z
    .object({
      social: z.array(SocialPostSchema),
      vision: z.array(VisionCueSchema),
      commentary: z.array(TranscriptEntrySchema),
    })
    .optional(),
  agentWeights: z
    .array(
      z.object({
        agentName: z.string(),
        weight: z.number().min(0).max(1),
        reasons: z.array(z.string()),
      }),
    )
    .optional(),
  clipName: z.string().optional(),
  contextSummary: z.string().optional(),
  preMatchSummary: z.string().optional(),
  expectedTopics: z.array(z.string()).optional(),
  recentCueTexts: z.array(z.string()).optional(),
  excludedCueTexts: z.array(z.string()).optional(),
});
export type GenerateBoothCueInput = z.infer<typeof GenerateBoothCueInputSchema>;

export const GenerateBoothCueResponseSchema = z.object({
  assist: AssistCardSchema,
  refreshAfterMs: z.number().int().positive(),
  explainability: GenerationExplainabilitySchema,
  source: z.enum(['openai', 'unavailable']),
});
export type GenerateBoothCueResponse = z.infer<typeof GenerateBoothCueResponseSchema>;

export const UserContextDocumentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  sourceType: z.enum(['text', 'file']),
  createdAt: z.string(),
  chunkCount: z.number().int().nonnegative(),
});
export type UserContextDocument = z.infer<typeof UserContextDocumentSchema>;

export const UserContextChunkSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  documentName: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  text: z.string(),
  score: z.number().min(0).max(1),
});
export type UserContextChunk = z.infer<typeof UserContextChunkSchema>;

export const UploadUserContextInputSchema = z.object({
  fileName: z.string().min(1),
  text: z.string().min(1),
  sourceType: z.enum(['text', 'file']).default('file'),
});
export type UploadUserContextInput = z.infer<typeof UploadUserContextInputSchema>;

export const UploadUserContextResponseSchema = z.object({
  document: UserContextDocumentSchema,
});
export type UploadUserContextResponse = z.infer<typeof UploadUserContextResponseSchema>;

export const ListUserContextResponseSchema = z.object({
  documents: z.array(UserContextDocumentSchema),
});
export type ListUserContextResponse = z.infer<typeof ListUserContextResponseSchema>;

export const RetrieveUserContextInputSchema = z.object({
  queryText: z.string().min(1),
  limit: z.number().int().positive().max(20).optional(),
});
export type RetrieveUserContextInput = z.infer<typeof RetrieveUserContextInputSchema>;

export const RetrieveUserContextResponseSchema = z.object({
  chunks: z.array(UserContextChunkSchema),
});
export type RetrieveUserContextResponse = z.infer<typeof RetrieveUserContextResponseSchema>;

export const ResolveFixtureInputSchema = z.object({
  screenshotBase64: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  clipName: z.string().optional(),
}).refine((value) => Boolean(value.clipName || (value.screenshotBase64 && value.mimeType)), {
  message: 'Fixture resolution requires a screenshot or clip name hint.',
});
export type ResolveFixtureInput = z.infer<typeof ResolveFixtureInputSchema>;

export const UpdateBoothLiveSignalsInputSchema = z.object({
  transcriptWindow: z.array(TranscriptEntrySchema).max(12).optional(),
  screenshotBase64: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  clipName: z.string().optional(),
  clockMs: z.number().int().nonnegative().optional(),
});
export type UpdateBoothLiveSignalsInput = z.infer<typeof UpdateBoothLiveSignalsInputSchema>;

export const UpdateBoothLiveSignalsResponseSchema = z.object({
  commentaryCount: z.number().int().nonnegative(),
  visionCue: VisionCueSchema.nullable(),
  source: z.enum(['openai', 'unavailable', 'state-only']),
});
export type UpdateBoothLiveSignalsResponse = z.infer<typeof UpdateBoothLiveSignalsResponseSchema>;

export const ResolveFixtureResponseSchema = z.object({
  fixtureId: z.string(),
  fixtureName: z.string(),
  homeTeam: z.string(),
  awayTeam: z.string(),
  competition: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  source: z.enum(['openai+sportsmonks', 'sportsmonks', 'preset']),
});
export type ResolveFixtureResponse = z.infer<typeof ResolveFixtureResponseSchema>;
