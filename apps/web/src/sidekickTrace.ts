import type { BoothSignal } from './boothSignal';

export type SidekickTraceState = 'quiet' | 'ready' | 'active' | 'waiting';

export type SidekickTraceItem = {
  id: 'signal' | 'context' | 'cue' | 'recovery';
  label: string;
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
      state: boothSignal.shouldSurfaceAssist ? 'active' : 'quiet',
      detail: signalDetail,
    },
    {
      id: 'context',
      label: 'Context agent',
      state: activeFixtureId ? 'ready' : fixtureResolutionLabel ? 'active' : 'waiting',
      detail: contextDetail,
    },
    {
      id: 'cue',
      label: 'Cue agent',
      state: shouldSurfaceAssist ? 'active' : isAssistWeaning ? 'ready' : 'quiet',
      detail: cueDetail,
    },
    {
      id: 'recovery',
      label: 'Recovery agent',
      state: effectiveRecoveryScore >= 0.5 ? 'ready' : 'quiet',
      detail: recoveryDetail,
    },
  ];

  return trace;
}
