# Demo Script

## Goal
Show that AndOne is an adaptive sidekick, not a chatbot:
- it ingests multiple messy streams
- maintains a rolling live context model
- waits while the booth is active
- detects hesitation and recovery
- surfaces one short grounded assist
- shows compact provenance without cluttering the cue

## Operator Setup
1. Run `npm run demo`.
2. Open `http://localhost:5173`.
3. Confirm the dashboard loads in a paused state.
4. Keep style mode on `analyst` for the first pass.

## Judge Flow
1. Start with the replay paused and explain that the system is running entirely from local deterministic fixtures.
2. Press `Play`.
3. Point out the live desk layout, hesitation meter, transcript rail, and the fact that the system stays quiet while delivery is stable.
4. Let the save sequence arrive, then call out that the system stays quiet while the co-host is still talking.
5. As soon as the co-host line clears, show the grounded assist.
6. Let the clip continue into the Madrid counter.
7. Open `Why this cue` and point out that the card is grounded in live context rather than generic filler.
8. Continue speaking and show that once the user takes up the idea, the next cue advances instead of repeating it.
9. Use `Force Hesitation` only as a backup if you miss the natural hesitation window.

## Exact Event Timestamps
| Replay Time | Fixture Beat | Source |
| --- | --- | --- |
| `00:00` | Kickoff and crowd atmosphere | `events.json`, `vision_frames.json` |
| `00:45` | Barcelona possession control | `events.json` |
| `01:05` | Barcelona chance through Lewandowski | `events.json` |
| `01:14` | Lead commentator unfinished line | `transcript_seed.json` |
| `01:15` | Courtois save | `events.json` |
| `01:16` | Co-host reaction line | `transcript_seed.json` |
| `01:22` | Coach reaction visual cue | `vision_frames.json` |
| `01:25` | Lead reaction resumes | `transcript_seed.json` |
| `01:28` | Celebration-style defensive relief cue | `vision_frames.json` |
| `01:30` | Madrid counter through Vinícius Júnior | `events.json` |

## Exact Hesitation Moments
| Replay Time | Why It Matters | Expected System Behavior |
| --- | --- | --- |
| `01:17.5` | Co-host is still active after the save | No assist shown |
| `01:19.0` | Save just happened, co-host line has cleared, lead hesitation is high | Co-host toss-up appears |
| `01:32.5` | Madrid counter is hot and the lead has gone quiet again | Style-sensitive assist appears |

## Exact Expected Assists
### Expected Behavior
- Save window:
  - a grounded assist should appear once the hesitation window opens
  - the prompt should reference the live moment rather than generic bridge phrasing
- After the prompt is taken up in speech:
  - the next cue should move to a fresh grounded angle
  - it should not simply paraphrase the same save line again
- Late counter:
  - the assist should stay short
  - the assist should reflect current match context
  - the provenance reveal should show live supporting sources

## Backup Plan
- If you miss the timing, press `Restart`.
- If the booth does not naturally land in hesitation during the demo, toggle `Force Hesitation`.
- If optional social or vision fixtures fail to load, the replay still runs with match, transcript, narrative, and assist generation intact.
