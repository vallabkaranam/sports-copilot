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

export const MemoryTierSchema = z.enum(['static', 'session', 'live', 'pre_match']);
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
      phaseHints: z.array(RetrievalPhaseHintSchema).optional(),
    })
    .optional(),
});
export type SourceChip = z.infer<typeof SourceChipSchema>;

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
      phaseHints: z.array(RetrievalPhaseHintSchema).optional(),
    })
    .optional(),
  sourceChip: SourceChipSchema,
});
export type RetrievedFact = z.infer<typeof RetrievedFactSchema>;

export const RetrievalStateSchema = z.object({
  query: z.string(),
  supportingFacts: z.array(RetrievedFactSchema),
});
export type RetrievalState = z.infer<typeof RetrievalStateSchema>;

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
  assist: AssistCardSchema,
  preMatch: PreMatchStateSchema,
  liveMatch: LiveMatchStateSchema,
  liveSignals: z.object({
    social: z.array(SocialPostSchema),
    vision: z.array(VisionCueSchema),
  }),
});
export type WorldState = z.infer<typeof WorldStateSchema>;
