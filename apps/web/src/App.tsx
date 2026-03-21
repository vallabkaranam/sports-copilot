import { startTransition, useEffect, useState } from 'react';
import { ReplayControlState } from '@sports-copilot/shared-types';
import './App.css';
import { fetchControlState, fetchWorldState, updateControlState } from './api';
import {
  TEAM_META,
  createInitialWorldState,
  formatAssistType,
  formatEventType,
  formatMomentum,
  formatPercent,
  getReplayProgress,
} from './dashboard';

function App() {
  const [worldState, setWorldState] = useState(createInitialWorldState);
  const [controls, setControls] = useState<ReplayControlState>({
    playbackStatus: 'paused',
    preferredStyleMode: 'analyst',
    forceHesitation: false,
    restartToken: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isUpdatingControls, setIsUpdatingControls] = useState(false);

  useEffect(() => {
    let isActive = true;

    const syncDashboard = async () => {
      try {
        const [nextWorldState, nextControls] = await Promise.all([
          fetchWorldState(),
          fetchControlState(),
        ]);

        if (!isActive) {
          return;
        }

        startTransition(() => {
          setWorldState(nextWorldState);
          setControls(nextControls);
          setError(null);
          setIsHydrated(true);
        });
      } catch (_error) {
        if (!isActive) {
          return;
        }

        setError('Waiting for the API and worker loop to come online.');
      }
    };

    void syncDashboard();
    const intervalId = window.setInterval(() => {
      void syncDashboard();
    }, 1_000);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, []);

  async function sendControlPatch(
    patch: Partial<ReplayControlState> & {
      restart?: boolean;
    },
  ) {
    setIsUpdatingControls(true);
    setControls((current) => ({
      ...current,
      ...(patch.playbackStatus ? { playbackStatus: patch.playbackStatus } : {}),
      ...(patch.preferredStyleMode ? { preferredStyleMode: patch.preferredStyleMode } : {}),
      ...(typeof patch.forceHesitation === 'boolean'
        ? { forceHesitation: patch.forceHesitation }
        : {}),
      restartToken: current.restartToken + (patch.restart ? 1 : 0),
    }));

    try {
      const nextControls = await updateControlState(patch);
      setControls(nextControls);
      setError(null);
    } catch (_error) {
      setError('Control update failed. The API may still be warming up.');
    } finally {
      setIsUpdatingControls(false);
    }
  }

  const assist = worldState.assist;
  const assistSignature = `${assist.type}:${assist.text}:${assist.whyNow}`;
  const latestTranscript =
    worldState.commentator.recentTranscript[
      worldState.commentator.recentTranscript.length - 1
    ];
  const latestSocial =
    worldState.liveSignals.social[worldState.liveSignals.social.length - 1];
  const replayProgress = getReplayProgress(worldState.clock);
  const recentEvents = [...worldState.recentEvents].reverse();
  const surfacedAssists = [...worldState.sessionMemory.surfacedAssists].reverse();
  const hesitationReasons =
    worldState.commentator.hesitationReasons.length > 0
      ? worldState.commentator.hesitationReasons
      : ['No hesitation trigger is active right now.'];
  const hesitationPercent = formatPercent(worldState.commentator.hesitationScore);
  const assistConfidencePercent = formatPercent(worldState.assist.confidence);

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Controlled El Clásico Replay</p>
          <h1>Sports Copilot</h1>
          <p className="hero-copy">
            AI commentator sidekick for live booth momentum, grounded context, and minimal
            intervention.
          </p>
        </div>

        <div className="hero-meta">
          <span className={`status-pill ${error ? 'status-pill--warning' : 'status-pill--live'}`}>
            {error ? 'Reconnecting' : isHydrated ? 'Live Sync' : 'Booting'}
          </span>
          <span className="status-pill status-pill--ghost">{controls.playbackStatus}</span>
          <span className="status-pill status-pill--ghost">
            {controls.preferredStyleMode} mode
          </span>
        </div>
      </header>

      {error ? <div className="warning-banner">{error}</div> : null}

      <section className="panel score-strip">
        <div className="team-block">
          <span className="team-code">{TEAM_META.home.code}</span>
          <div>
            <p className="team-name">{TEAM_META.home.name}</p>
            <p className="team-note">Home control lane</p>
          </div>
        </div>

        <div className="score-center">
          <p className="score-label">Replay Clock</p>
          <div className="scoreline">
            <span>{worldState.score.home}</span>
            <span className="score-divider">:</span>
            <span>{worldState.score.away}</span>
          </div>
          <p className="clock-chip">{worldState.clock}</p>
        </div>

        <div className="team-block team-block--away">
          <div>
            <p className="team-name">{TEAM_META.away.name}</p>
            <p className="team-note">Counter threat live</p>
          </div>
          <span className="team-code">{TEAM_META.away.code}</span>
        </div>

        <div className="score-sidecar">
          <p className="score-label">Possession</p>
          <strong>{worldState.possession}</strong>
          <p className="score-sidecar-copy">{worldState.gameStateSummary}</p>
        </div>
      </section>

      <div className="main-grid">
        <section className="panel replay-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Replay Feed</p>
              <h2>Broadcast view</h2>
            </div>
            <span className="panel-tag">{replayProgress}% through clip</span>
          </div>

          <div className="replay-stage">
            <div className="replay-stage__scrim" />
            <div className="replay-stage__content">
              <div className="replay-copy">
                <span className="live-chip">Director cue</span>
                <h3>{worldState.gameStateSummary}</h3>
                <p>
                  {latestTranscript
                    ? latestTranscript.text
                    : 'Transcript and hesitation signals appear here once the replay rolls.'}
                </p>
              </div>

              <div className="replay-tags">
                {worldState.liveSignals.vision.length > 0 ? (
                  worldState.liveSignals.vision.map((cue) => (
                    <span className="scene-chip" key={`${cue.timestamp}-${cue.tag}`}>
                      {cue.tag}
                    </span>
                  ))
                ) : (
                  <span className="scene-chip scene-chip--muted">Awaiting visual cue</span>
                )}
              </div>

              <div className="replay-footer">
                <div className="progress-track" aria-label="Replay progress">
                  <span style={{ width: `${replayProgress}%` }} />
                </div>
                <p className="pulse-copy">
                  {latestSocial
                    ? `${latestSocial.handle}: ${latestSocial.text}`
                    : 'Social pulse and crowd reaction will populate as the sequence heats up.'}
                </p>
              </div>
            </div>
          </div>
        </section>

        <div className="side-column">
          <section className="panel control-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Demo Controls</p>
                <h2>Control Desk</h2>
              </div>
              <span className="panel-tag">{isUpdatingControls ? 'Applying' : 'Ready'}</span>
            </div>

            <div className="control-group">
              <p className="control-label">Replay</p>
              <div className="segmented-control">
                <button
                  type="button"
                  className={controls.playbackStatus === 'playing' ? 'is-active' : ''}
                  onClick={() => void sendControlPatch({ playbackStatus: 'playing' })}
                >
                  Play
                </button>
                <button
                  type="button"
                  className={controls.playbackStatus === 'paused' ? 'is-active' : ''}
                  onClick={() => void sendControlPatch({ playbackStatus: 'paused' })}
                >
                  Pause
                </button>
                <button type="button" onClick={() => void sendControlPatch({ restart: true })}>
                  Restart
                </button>
              </div>
            </div>

            <div className="control-group">
              <p className="control-label">Style Mode</p>
              <div className="segmented-control">
                <button
                  type="button"
                  aria-pressed={controls.preferredStyleMode === 'analyst'}
                  className={controls.preferredStyleMode === 'analyst' ? 'is-active' : ''}
                  onClick={() => void sendControlPatch({ preferredStyleMode: 'analyst' })}
                >
                  Analyst
                </button>
                <button
                  type="button"
                  aria-pressed={controls.preferredStyleMode === 'hype'}
                  className={controls.preferredStyleMode === 'hype' ? 'is-active' : ''}
                  onClick={() => void sendControlPatch({ preferredStyleMode: 'hype' })}
                >
                  Hype
                </button>
              </div>
            </div>

            <div className="control-group">
              <p className="control-label">Backup Trigger</p>
              <button
                type="button"
                className={`toggle-button ${controls.forceHesitation ? 'toggle-button--on' : ''}`}
                aria-pressed={controls.forceHesitation}
                onClick={() =>
                  void sendControlPatch({ forceHesitation: !controls.forceHesitation })
                }
              >
                {controls.forceHesitation ? 'Force Hesitation On' : 'Force Hesitation Off'}
              </button>
            </div>
          </section>

          <section className="panel assist-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Active Assist</p>
                <h2>Copilot card</h2>
              </div>
              <span className={`panel-tag panel-tag--${assist.styleMode}`}>{assist.styleMode}</span>
            </div>

            <article
              className={`assist-card ${assist.type !== 'none' ? 'assist-card--live' : ''}`}
              key={assistSignature}
            >
              <div className="assist-card__header">
                <div>
                  <p className="assist-type">{formatAssistType(assist.type)}</p>
                  <h3>{assist.text || 'System holding its fire until the booth needs help.'}</h3>
                </div>
                <div className="assist-confidence">
                  <span>Confidence</span>
                  <strong>{assistConfidencePercent}</strong>
                </div>
              </div>

              <p className="assist-why">{assist.whyNow}</p>

              <div className="assist-meta">
                <span className="meta-pill">{assist.urgency} urgency</span>
                <span className="meta-pill">{controls.preferredStyleMode} preference</span>
                <span className="meta-pill">{worldState.retrieval.supportingFacts.length} facts live</span>
              </div>

              <div className="source-chip-row">
                {assist.sourceChips.length > 0 ? (
                  assist.sourceChips.map((chip) => (
                    <span className="source-chip" key={chip.id}>
                      {chip.label}
                    </span>
                  ))
                ) : (
                  <span className="source-chip source-chip--muted">
                    Source chips appear when an assist is surfaced.
                  </span>
                )}
              </div>
            </article>
          </section>
        </div>
      </div>

      <div className="bottom-grid">
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Match Flow</p>
              <h2>Event Timeline</h2>
            </div>
            <span className="panel-tag">{recentEvents.length} recent events</span>
          </div>

          <div className="timeline-list">
            {recentEvents.length > 0 ? (
              recentEvents.map((event) => (
                <article
                  className={`timeline-item ${event.highSalience ? 'timeline-item--hot' : ''}`}
                  key={event.id}
                >
                  <div className="timeline-time">
                    <span>{event.matchTime}</span>
                    <small>{formatEventType(event.type)}</small>
                  </div>
                  <p>{event.description}</p>
                </article>
              ))
            ) : (
              <p className="empty-copy">Recent match events will roll in here as the replay advances.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Narrative Stack</p>
              <h2>Storylines</h2>
            </div>
            <span className="panel-tag">{formatMomentum(worldState.narrative.momentum)}</span>
          </div>

          <div className="narrative-focus">
            <p className="narrative-label">Top narrative</p>
            <h3>{worldState.narrative.topNarrative ?? 'No dominant thread yet.'}</h3>
            <p>{worldState.narrative.currentSentiment}</p>
          </div>

          <div className="narrative-stack">
            {worldState.narrative.activeNarratives.length > 0 ? (
              worldState.narrative.activeNarratives.map((narrative) => (
                <span className="stack-chip" key={narrative}>
                  {narrative}
                </span>
              ))
            ) : (
              <span className="stack-chip stack-chip--muted">Narratives will stack here.</span>
            )}
          </div>

          <div className="memory-strip">
            <p className="memory-title">Recent assist memory</p>
            {surfacedAssists.length > 0 ? (
              surfacedAssists.slice(0, 3).map((savedAssist) => (
                <p className="memory-line" key={`${savedAssist.type}:${savedAssist.text}`}>
                  {savedAssist.text}
                </p>
              ))
            ) : (
              <p className="memory-line">No assists have been surfaced yet.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Commentator State</p>
              <h2>Hesitation Meter</h2>
            </div>
            <span className="panel-tag">{hesitationPercent}</span>
          </div>

          <div className="meter-cluster">
            <div>
              <div className="meter-label-row">
                <span>Hesitation</span>
                <strong>{hesitationPercent}</strong>
              </div>
              <div className="meter-track">
                <span style={{ width: hesitationPercent }} />
              </div>
            </div>

            <div>
              <div className="meter-label-row">
                <span>Assist confidence</span>
                <strong>{assistConfidencePercent}</strong>
              </div>
              <div className="meter-track meter-track--gold">
                <span style={{ width: assistConfidencePercent }} />
              </div>
            </div>
          </div>

          <div className="reason-list">
            {hesitationReasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </div>

          <div className="commentary-metadata">
            <div>
              <p className="control-label">Speaker state</p>
              <strong>{worldState.commentator.activeSpeaker}</strong>
            </div>
            <div>
              <p className="control-label">Pause</p>
              <strong>{Math.round(worldState.commentator.pauseDurationMs / 100) / 10}s</strong>
            </div>
            <div>
              <p className="control-label">Filler cues</p>
              <strong>{worldState.commentator.fillerWords.join(', ') || 'Clean'}</strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default App;
