# Demo Script

## Goal
Show that Sports Copilot is an AI sidekick, not a chatbot:
- it ingests multiple messy streams
- maintains a live world model
- waits while the booth is active
- detects hesitation at the right moment
- surfaces one short grounded assist
- adapts to style mode on command

## Operator Setup
1. Run `npm run demo`.
2. Open `http://localhost:5173`.
3. Confirm the dashboard loads in a paused state.
4. Keep style mode on `analyst` for the first pass.

## Judge Flow
1. Start with the replay paused and explain that the system is running entirely from local deterministic fixtures.
2. Press `Play`.
3. Point out the scoreboard, event timeline, narrative stack, hesitation meter, source chips, and replay panel as the feed advances.
4. Let the save sequence arrive, then call out that the system stays quiet while the co-host is still talking.
5. As soon as the co-host line clears, show the grounded toss-up assist.
6. Let the clip continue into the Madrid counter.
7. In `analyst` mode, note that the expected assist is a context line.
8. Restart, switch to `hype`, and replay the late counter if you want to show style adaptation.
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
### Save Window
- Replay time: `01:19.0`
- Style mode: `analyst`
- Expected assist type: `co-host-tossup`
- Expected assist text:
  `What did you make of Courtois's save there?`

### Late Counter in Analyst Mode
- Replay time: `01:32.5`
- Style mode: `analyst`
- Expected assist type: `context`
- Expected assist text:
  `Vinícius Júnior is at the heart of it, and the bigger story is Real Madrid are flipping the momentum.`

### Late Counter in Hype Mode
- Replay time: `01:32.5`
- Style mode: `hype`
- Expected assist type: `hype`
- Expected assist text:
  `Vinícius Júnior has Real Madrid flying in transition!`

## Backup Plan
- If you miss the timing, press `Restart`.
- If the booth does not naturally land in hesitation during the demo, toggle `Force Hesitation`.
- If optional social or vision fixtures fail to load, the replay still runs with match, transcript, narrative, and assist generation intact.
