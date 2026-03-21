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

export const MemoryTierSchema = z.enum(['static', 'session', 'live']);
export type MemoryTier = z.infer<typeof MemoryTierSchema>;

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
});
export type SourceChip = z.infer<typeof SourceChipSchema>;

export const RetrievedFactSchema = z.object({
  id: z.string(),
  tier: MemoryTierSchema,
  text: z.string(),
  source: z.string(),
  timestamp: z.number().nullable(),
  relevance: z.number().min(0).max(1),
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
  description: z.string(),
  highSalience: z.boolean(),
  data: z.record(z.string(), z.any()).optional(),
});
export type GameEvent = z.infer<typeof GameEventSchema>;

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
});
export type ReplayControlState = z.infer<typeof ReplayControlStateSchema>;

export function createDefaultReplayControlState(): ReplayControlState {
  return {
    playbackStatus: 'paused',
    preferredStyleMode: 'analyst',
    forceHesitation: false,
    restartToken: 0,
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
  liveSignals: z.object({
    social: z.array(SocialPostSchema),
    vision: z.array(VisionCueSchema),
  }),
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
  fillerWords: z.array(z.string()),
  repeatedPhrases: z.array(z.string()),
  unfinishedPhrase: z.boolean(),
  hesitationReasons: z.array(z.string()),
  transcriptWindow: z.array(TranscriptEntrySchema),
  interimTranscript: z.string(),
});
export type BoothFeatureSnapshot = z.infer<typeof BoothFeatureSnapshotSchema>;

export const BoothInterpretationSchema = z.object({
  state: BoothInterpretationStateSchema,
  hesitationScore: z.number().min(0).max(1),
  recoveryScore: z.number().min(0).max(1),
  shouldSurfaceAssist: z.boolean(),
  summary: z.string(),
  reasons: z.array(z.string()),
  source: z.enum(['heuristic', 'openai']),
});
export type BoothInterpretation = z.infer<typeof BoothInterpretationSchema>;

export const InterpretBoothInputSchema = z.object({
  features: BoothFeatureSnapshotSchema,
});
export type InterpretBoothInput = z.infer<typeof InterpretBoothInputSchema>;
