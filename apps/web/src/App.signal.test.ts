import { describe, expect, it } from 'vitest';
import { buildBoothSignal, calculateAudioLevel, resolveBoothGuidanceScores } from './boothSignal';

describe('booth signal audio activity', () => {
  it('treats recent mic activity as speaking even without transcript text', () => {
    const signal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: -1,
      lastVoiceActivityAtMs: 10_000,
      speechStreakStartedAtMs: 9_200,
      audioLevel: 0.12,
      nowMs: 10_400,
    });

    expect(signal.isSpeaking).toBe(true);
    expect(signal.activeSpeaker).toBe('lead');
    expect(signal.pauseDurationMs).toBe(0);
    expect(signal.hasVoiceActivity).toBe(true);
    expect(signal.confidenceScore).toBeGreaterThan(0.3);
    expect(signal.transcriptStabilityScore).toBe(1);
  });

  it('raises hesitation after voice activity stops even without transcript recognition', () => {
    const signal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: -1,
      lastVoiceActivityAtMs: 10_000,
      silenceStreakStartedAtMs: 10_000,
      audioLevel: 0.01,
      nowMs: 12_400,
    });

    expect(signal.isSpeaking).toBe(false);
    expect(signal.pauseDurationMs).toBe(2_400);
    expect(signal.hesitationScore).toBeGreaterThan(0.3);
    expect(signal.hesitationReasons[0]).toContain('paused');
    expect(signal.shouldSurfaceAssist).toBe(true);
    expect(signal.confidenceScore).toBe(0);
  });

  it('raises transcript-instability metrics for fillers and repeated starts', () => {
    const signal = buildBoothSignal({
      boothTranscript: [
        { timestamp: 0, speaker: 'lead', text: 'Vinicius is driving here' },
        { timestamp: 800, speaker: 'lead', text: 'Vinicius is driving again' },
      ],
      interimTranscript: 'um vinicius is driving on',
      isMicListening: true,
      lastSpeechAtMs: 11_000,
      lastVoiceActivityAtMs: 11_000,
      speechStreakStartedAtMs: 10_000,
      audioLevel: 0.09,
      nowMs: 11_400,
    });

    expect(signal.fillerCount).toBeGreaterThan(0);
    expect(signal.fillerDensity).toBeGreaterThan(0);
    expect(signal.repeatedOpeningCount).toBeGreaterThan(0);
    expect(signal.transcriptStabilityScore).toBeLessThan(1);
  });

  it('detects filler-driven repeated starts from the interim line before a final transcript lands', () => {
    const signal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: 'uh vinicius is, uh vinicius is driving...',
      isMicListening: true,
      lastSpeechAtMs: 11_200,
      lastVoiceActivityAtMs: 11_200,
      speechStreakStartedAtMs: 10_300,
      audioLevel: 0.11,
      nowMs: 11_600,
    });

    expect(signal.fillerCount).toBeGreaterThanOrEqual(2);
    expect(signal.repeatedOpeningCount).toBeGreaterThan(0);
    expect(signal.unfinishedPhrase).toBe(true);
    expect(signal.transcriptStabilityScore).toBeLessThan(0.8);
  });

  it('surfaces hesitation from filler bursts even before a long pause lands', () => {
    const signal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: 'um uh well um this is, uh this is opening up',
      isMicListening: true,
      lastSpeechAtMs: 11_200,
      lastVoiceActivityAtMs: 11_200,
      speechStreakStartedAtMs: 10_100,
      audioLevel: 0.08,
      nowMs: 11_600,
    });

    expect(signal.fillerCount).toBeGreaterThanOrEqual(4);
    expect(signal.hesitationScore).toBeGreaterThanOrEqual(0.36);
    expect(signal.shouldSurfaceAssist).toBe(true);
    expect(signal.hesitationReasons.join(' ')).toContain('filler words');
  });

  it('treats err and erm variants as filler words', () => {
    const signal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: 'err erm this is getting stretched here',
      isMicListening: true,
      lastSpeechAtMs: 11_200,
      lastVoiceActivityAtMs: 11_200,
      speechStreakStartedAtMs: 10_100,
      audioLevel: 0.08,
      nowMs: 11_600,
    });

    expect(signal.fillerCount).toBeGreaterThanOrEqual(2);
    expect(signal.fillerWords).toContain('err');
    expect(signal.fillerWords).toContain('erm');
  });

  it('treats kind-of and basically variants as filler pressure', () => {
    const signal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: 'kind of basically this is sort of getting away here',
      isMicListening: true,
      lastSpeechAtMs: 11_200,
      lastVoiceActivityAtMs: 11_200,
      speechStreakStartedAtMs: 10_100,
      audioLevel: 0.08,
      nowMs: 11_900,
    });

    expect(signal.fillerWords).toContain('kind of');
    expect(signal.fillerWords).toContain('basically');
    expect(signal.fillerWords).toContain('sort of');
  });

  it('detects repeated ideas even when the exact opening changes', () => {
    const signal = buildBoothSignal({
      boothTranscript: [
        { timestamp: 0, speaker: 'lead', text: 'Madrid have to survive this pressure now' },
        { timestamp: 1_300, speaker: 'lead', text: 'Real Madrid are just trying to survive this pressure' },
      ],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: 1_400,
      lastVoiceActivityAtMs: 1_400,
      speechStreakStartedAtMs: 0,
      audioLevel: 0.09,
      nowMs: 1_900,
    });

    expect(signal.repeatedIdeaCount).toBeGreaterThan(0);
    expect(signal.hesitationReasons.join(' ')).toContain('Repeated idea');
  });

  it('tracks pace pressure when delivery becomes unusually slow', () => {
    const signal = buildBoothSignal({
      boothTranscript: [
        { timestamp: 0, speaker: 'lead', text: 'This is getting tense now' },
      ],
      interimTranscript: 'uh this is really getting tense now',
      isMicListening: true,
      lastSpeechAtMs: 9_500,
      lastVoiceActivityAtMs: 9_500,
      speechStreakStartedAtMs: 2_000,
      audioLevel: 0.06,
      nowMs: 10_000,
    });

    expect(signal.wordsPerMinute).toBeGreaterThan(0);
    expect(signal.pacePressureScore).toBeGreaterThan(0);
  });

  it('steps in immediately when the wake phrase is spoken', () => {
    const signal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: 'line line give me the next beat',
      isMicListening: true,
      lastSpeechAtMs: 11_100,
      lastVoiceActivityAtMs: 11_100,
      speechStreakStartedAtMs: 10_500,
      audioLevel: 0.09,
      nowMs: 11_400,
    });

    expect(signal.wakePhraseDetected).toBe(true);
    expect(signal.hesitationScore).toBeGreaterThanOrEqual(0.72);
    expect(signal.shouldSurfaceAssist).toBe(true);
    expect(signal.hesitationReasons.join(' ')).toContain('wake phrase');
  });

  it('weans hesitation off and restores confidence once speech resumes', () => {
    const pausedSignal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: -1,
      lastVoiceActivityAtMs: 10_000,
      silenceStreakStartedAtMs: 10_000,
      audioLevel: 0.01,
      nowMs: 12_600,
    });
    const resumedSignal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: -1,
      lastVoiceActivityAtMs: 12_700,
      speechStreakStartedAtMs: 12_700,
      audioLevel: 0.14,
      nowMs: 12_900,
    });

    expect(pausedSignal.hesitationScore).toBeGreaterThan(resumedSignal.hesitationScore);
    expect(resumedSignal.hesitationScore).toBe(0);
    expect(resumedSignal.confidenceScore).toBeGreaterThan(pausedSignal.confidenceScore);
  });

  it('keeps hesitation high during a sustained silence instead of decaying on its own', () => {
    const shorterPause = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: -1,
      lastVoiceActivityAtMs: 10_000,
      silenceStreakStartedAtMs: 10_000,
      audioLevel: 0.01,
      nowMs: 12_800,
    });
    const longerPause = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: -1,
      lastVoiceActivityAtMs: 10_000,
      silenceStreakStartedAtMs: 10_000,
      audioLevel: 0.01,
      nowMs: 20_000,
    });

    expect(longerPause.hesitationScore).toBeGreaterThanOrEqual(shorterPause.hesitationScore);
    expect(longerPause.shouldSurfaceAssist).toBe(true);
    expect(longerPause.confidenceScore).toBeLessThanOrEqual(shorterPause.confidenceScore);
  });

  it('allows a long silence to reach full hesitation instead of stopping at an arbitrary cap', () => {
    const signal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: -1,
      lastVoiceActivityAtMs: 10_000,
      silenceStreakStartedAtMs: 10_000,
      audioLevel: 0.01,
      nowMs: 15_500,
    });

    expect(signal.pauseDurationMs).toBe(5_500);
    expect(signal.hesitationScore).toBe(1);
    expect(signal.shouldSurfaceAssist).toBe(true);
  });

  it('reduces effective hesitation when recovery overtakes the hesitation moment', () => {
    const resolved = resolveBoothGuidanceScores({
      localHesitationScore: 0.72,
      localConfidenceScore: 0.76,
      interpretedHesitationScore: 0.68,
      interpretedRecoveryScore: 0.58,
      interpretationState: 'weaning-off',
    });

    expect(resolved.effectiveHesitationScore).toBeLessThan(0.3);
    expect(resolved.effectiveRecoveryScore).toBeGreaterThan(resolved.effectiveHesitationScore);
  });

  it('preserves rising hesitation when recovery is genuinely absent', () => {
    const resolved = resolveBoothGuidanceScores({
      localHesitationScore: 0.72,
      localConfidenceScore: 0.08,
      interpretedHesitationScore: 0.7,
      interpretedRecoveryScore: 0.04,
      interpretationState: 'step-in',
    });

    expect(resolved.effectiveHesitationScore).toBeGreaterThan(0.6);
    expect(resolved.effectiveRecoveryScore).toBeLessThan(0.3);
  });

  it('returns a higher level for a louder waveform', () => {
    const quiet = calculateAudioLevel(new Uint8Array([128, 128, 128, 128]));
    const louder = calculateAudioLevel(new Uint8Array([128, 160, 96, 128]));

    expect(quiet).toBe(0);
    expect(louder).toBeGreaterThan(quiet);
  });
});
