import { describe, expect, it } from 'vitest';
import { buildBoothSignal, calculateAudioLevel } from './boothSignal';

describe('booth signal audio activity', () => {
  it('treats recent mic activity as speaking even without transcript text', () => {
    const signal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: -1,
      lastVoiceActivityAtMs: 10_000,
      audioLevel: 0.12,
      nowMs: 10_400,
    });

    expect(signal.isSpeaking).toBe(true);
    expect(signal.activeSpeaker).toBe('lead');
    expect(signal.pauseDurationMs).toBe(0);
    expect(signal.hasVoiceActivity).toBe(true);
    expect(signal.confidenceScore).toBeGreaterThan(0.7);
  });

  it('raises hesitation after voice activity stops even without transcript recognition', () => {
    const signal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: -1,
      lastVoiceActivityAtMs: 10_000,
      audioLevel: 0.01,
      nowMs: 12_400,
    });

    expect(signal.isSpeaking).toBe(false);
    expect(signal.pauseDurationMs).toBe(2_400);
    expect(signal.hesitationScore).toBeGreaterThanOrEqual(0.55);
    expect(signal.hesitationReasons[0]).toContain('paused');
    expect(signal.shouldSurfaceAssist).toBe(true);
    expect(signal.confidenceScore).toBeLessThan(0.45);
  });

  it('weans hesitation off and restores confidence once speech resumes', () => {
    const pausedSignal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: -1,
      lastVoiceActivityAtMs: 10_000,
      audioLevel: 0.01,
      nowMs: 12_600,
    });
    const resumedSignal = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: -1,
      lastVoiceActivityAtMs: 12_700,
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
      audioLevel: 0.01,
      nowMs: 12_800,
    });
    const longerPause = buildBoothSignal({
      boothTranscript: [],
      interimTranscript: '',
      isMicListening: true,
      lastSpeechAtMs: -1,
      lastVoiceActivityAtMs: 10_000,
      audioLevel: 0.01,
      nowMs: 20_000,
    });

    expect(longerPause.hesitationScore).toBeGreaterThanOrEqual(shorterPause.hesitationScore);
    expect(longerPause.shouldSurfaceAssist).toBe(true);
    expect(longerPause.confidenceScore).toBeLessThanOrEqual(shorterPause.confidenceScore);
  });

  it('returns a higher level for a louder waveform', () => {
    const quiet = calculateAudioLevel(new Uint8Array([128, 128, 128, 128]));
    const louder = calculateAudioLevel(new Uint8Array([128, 160, 96, 128]));

    expect(quiet).toBe(0);
    expect(louder).toBeGreaterThan(quiet);
  });
});
