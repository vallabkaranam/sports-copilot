import { z } from 'zod';

/**
 * Shared Style Modes for the assistant
 */
export const StyleModeSchema = z.enum(['hype', 'analyst']);
export type StyleMode = z.infer<typeof StyleModeSchema>;

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
 * Source attribution chips
 */
export const SourceChipSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  relevance: z.number().min(0).max(1),
});
export type SourceChip = z.infer<typeof SourceChipSchema>;

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
  confidence: z.number().min(0).max(1),
  whyNow: z.string(),
  sourceChips: z.array(SourceChipSchema),
});
export type AssistCard = z.infer<typeof AssistCardSchema>;

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

/**
 * Commentator state trackers
 */
export const CommentatorStateSchema = z.object({
  activeSpeaker: ActiveSpeakerSchema,
  isSpeaking: z.boolean(),
  coHostIsSpeaking: z.boolean(),
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

/**
 * Narrative state
 */
export const NarrativeStateSchema = z.object({
  activeNarratives: z.array(z.string()),
  currentSentiment: z.string(),
  momentum: z.enum(['home', 'away', 'neutral']),
});
export type NarrativeState = z.infer<typeof NarrativeStateSchema>;

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
  recentEvents: z.array(GameEventSchema),
  commentator: CommentatorStateSchema,
  narrative: NarrativeStateSchema,
  liveSignals: z.object({
    social: z.array(z.any()),
    vision: z.array(z.any()),
  }),
});
export type WorldState = z.infer<typeof WorldStateSchema>;
