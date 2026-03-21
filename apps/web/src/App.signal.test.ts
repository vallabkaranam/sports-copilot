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
    expect(signal.hesitationScore).toBeGreaterThan(0);
    expect(signal.hesitationReasons[0]).toContain('paused');
  });

  it('returns a higher level for a louder waveform', () => {
    const quiet = calculateAudioLevel(new Uint8Array([128, 128, 128, 128]));
    const louder = calculateAudioLevel(new Uint8Array([128, 160, 96, 128]));

    expect(quiet).toBe(0);
    expect(louder).toBeGreaterThan(quiet);
  });
});
