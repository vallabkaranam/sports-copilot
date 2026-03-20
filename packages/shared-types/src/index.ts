import { z } from 'zod';

/**
 * Shared Style Modes for the assistant
 */
export const StyleModeSchema = z.enum(['hype', 'analyst']);
export type StyleMode = z.infer<typeof StyleModeSchema>;

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
  isSpeaking: z.boolean(),
  recentTranscript: z.string(),
  hesitationScore: z.number().min(0).max(1),
  pauseDuration: z.number(),
  fillerWords: z.array(z.string()),
  lastSpokeAt: z.number(),
});
export type CommentatorState = z.infer<typeof CommentatorStateSchema>;

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
