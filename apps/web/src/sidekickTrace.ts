import type { BoothSignal } from './boothSignal';

export type SidekickTraceState = 'quiet' | 'ready' | 'active' | 'waiting';
export type SidekickTraceLane = 'sensing' | 'content';

export type SidekickTraceItem = {
  id:
    | 'signal'
    | 'fillers'
    | 'pace'
    | 'context'
    | 'grounding'
    | 'cue'
    | 'recovery';
  label: string;
  lane: SidekickTraceLane;
  state: SidekickTraceState;
  detail: string;
};

function countContextSignals(params: {
  recentEventCount: number;
  socialCount: number;
  visionCount: number;
  supportingFactCount: number;
  transcriptLineCount: number;
}) {
  const { recentEventCount, socialCount, visionCount, supportingFactCount, transcriptLineCount } = params;

  return [
    recentEventCount > 0 ? 'live events' : null,
    socialCount > 0 ? 'social' : null,
    visionCount > 0 ? 'vision' : null,
    supportingFactCount > 0 ? 'context facts' : null,
    transcriptLineCount > 0 ? 'transcript' : null,
  ].filter((value): value is string => Boolean(value));
}

export function buildSidekickTrace(params: {
  boothSignal: BoothSignal;
  effectiveRecoveryScore: number;
  shouldSurfaceAssist: boolean;
  isAssistWeaning: boolean;
  activeFixtureId?: string;
  fixtureResolutionLabel?: string | null;
  cueSource: 'openai' | 'local' | 'worker' | 'none';
  recentEventCount: number;
  socialCount: number;
  visionCount: number;
  supportingFactCount: number;
  transcriptLineCount: number;
}) {
  const {
    boothSignal,
    effectiveRecoveryScore,
    shouldSurfaceAssist,
    isAssistWeaning,
    activeFixtureId,
    fixtureResolutionLabel,
    cueSource,
    recentEventCount,
    socialCount,
    visionCount,
    supportingFactCount,
    transcriptLineCount,
  } = params;

  const topSignalLabels = boothSignal.hesitationContributors
    .slice()
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .map((contributor) => contributor.label.toLowerCase());

  const contextSignals = countContextSignals({
    recentEventCount,
    socialCount,
    visionCount,
    supportingFactCount,
    transcriptLineCount,
  });

  const signalDetail = topSignalLabels.length
    ? `Tracking ${topSignalLabels.join(' + ')}`
    : boothSignal.shouldSurfaceAssist
      ? 'Delivery slip detected'
      : 'Monitoring delivery only';

  const contextDetail = activeFixtureId
    ? `${fixtureResolutionLabel ?? 'Fixture linked'} · ${contextSignals.slice(0, 3).join(' · ') || 'context warming'}`
    : fixtureResolutionLabel
      ? `${fixtureResolutionLabel} · confirming fixture`
      : 'Waiting for match resolution';

  const fillerDetail =
    boothSignal.fillerCount > 0
      ? `${boothSignal.fillerWords.slice(0, 3).join(' · ')}${boothSignal.wakePhraseDetected ? ' · wake phrase' : ''}`
      : boothSignal.wakePhraseDetected
        ? 'Wake phrase detected'
        : 'No filler or wake-word trigger';

  const paceDetail =
    boothSignal.pauseDurationMs >= 1_200
      ? `Pause at ${Math.round(boothSignal.pauseDurationMs / 100) / 10}s`
      : boothSignal.pacePressureScore >= 0.18
        ? `${Math.round(boothSignal.wordsPerMinute)} WPM · pace pressure rising`
        : boothSignal.wordsPerMinute > 0
          ? `${Math.round(boothSignal.wordsPerMinute)} WPM · cadence stable`
          : 'Waiting for enough speech';

  const groundingSignalCount = recentEventCount + socialCount + visionCount + supportingFactCount + transcriptLineCount;
  const groundingDetail =
    groundingSignalCount > 0
      ? [
          recentEventCount > 0 ? `${recentEventCount} event${recentEventCount === 1 ? '' : 's'}` : null,
          socialCount > 0 ? `${socialCount} social` : null,
          visionCount > 0 ? `${visionCount} vision` : null,
          supportingFactCount > 0 ? `${supportingFactCount} facts` : null,
          transcriptLineCount > 0 ? `${transcriptLineCount} transcript` : null,
        ]
          .filter(Boolean)
          .slice(0, 3)
          .join(' · ')
      : 'No grounding inputs yet';

  let cueDetail = 'Standing by';
  if (shouldSurfaceAssist) {
    cueDetail =
      cueSource === 'openai'
        ? 'Grounded cue live from OpenAI'
        : cueSource === 'local'
          ? 'Grounded local fallback is active'
          : cueSource === 'worker'
            ? 'Worker cue is holding the desk'
            : 'Cue is live';
  } else if (isAssistWeaning) {
    cueDetail = 'Backing off as confidence returns';
  }

  const recoveryDetail =
    effectiveRecoveryScore >= 0.72
      ? 'Recovery is strong'
      : effectiveRecoveryScore >= 0.5
        ? 'Recovery is building'
        : 'Recovery not established';

  const trace: SidekickTraceItem[] = [
    {
      id: 'signal',
      label: 'Signal agent',
      lane: 'sensing',
      state: boothSignal.shouldSurfaceAssist ? 'active' : 'quiet',
      detail: signalDetail,
    },
    {
      id: 'fillers',
      label: 'Filler agent',
      lane: 'sensing',
      state: boothSignal.fillerCount > 0 || boothSignal.wakePhraseDetected ? 'active' : 'quiet',
      detail: fillerDetail,
    },
    {
      id: 'pace',
      label: 'Pace agent',
      lane: 'sensing',
      state:
        boothSignal.pauseDurationMs >= 1_200 || boothSignal.pacePressureScore >= 0.18
          ? 'active'
          : boothSignal.wordsPerMinute > 0
            ? 'ready'
            : 'waiting',
      detail: paceDetail,
    },
    {
      id: 'context',
      label: 'Context agent',
      lane: 'content',
      state: activeFixtureId ? 'ready' : fixtureResolutionLabel ? 'active' : 'waiting',
      detail: contextDetail,
    },
    {
      id: 'grounding',
      label: 'Grounding agent',
      lane: 'content',
      state: groundingSignalCount > 0 ? 'ready' : 'waiting',
      detail: groundingDetail,
    },
    {
      id: 'cue',
      label: 'Cue agent',
      lane: 'content',
      state: shouldSurfaceAssist ? 'active' : isAssistWeaning ? 'ready' : 'quiet',
      detail: cueDetail,
    },
    {
      id: 'recovery',
      label: 'Recovery agent',
      lane: 'sensing',
      state: effectiveRecoveryScore >= 0.5 ? 'ready' : 'quiet',
      detail: recoveryDetail,
    },
  ];

  return trace;
}
