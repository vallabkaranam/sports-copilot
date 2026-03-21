import { GameEvent, WorldState } from '@sports-copilot/shared-types';

export interface ReplayEngineOptions {
  events: GameEvent[];
  tickRateMs: number;
}

export class ReplayEngine {
  private events: GameEvent[];
  private currentIndex: number = 0;
  private matchClockMs: number = 0;
  private isPlaying: boolean = false;
  private score = { home: 0, away: 0 };
  private currentPossession: string = 'BAR';
  private processedEvents: GameEvent[] = [];

  constructor(options: ReplayEngineOptions) {
    this.events = [...options.events].sort((a, b) => a.timestamp - b.timestamp);
  }

  public tick(deltaMs: number) {
    if (!this.isPlaying) return null;

    this.matchClockMs += deltaMs;
    
    const newEvents: GameEvent[] = [];
    while (
      this.currentIndex < this.events.length &&
      this.events[this.currentIndex].timestamp <= this.matchClockMs
    ) {
      const event = this.events[this.currentIndex];
      newEvents.push(event);
      this.processedEvents.push(event);
      
      // Update local state based on event types
      if (event.type === 'GOAL') {
        const team = event.data?.team;
        if (team === 'BAR') this.score.home++;
        if (team === 'RMA') this.score.away++;
      }
      if (event.type === 'POSSESSION' && event.data?.team) {
        this.currentPossession = event.data.team;
      }

      this.currentIndex++;
    }

    return newEvents.length > 0 ? newEvents : null;
  }

  public getStatus(): Partial<WorldState> {
    const seconds = Math.floor(this.matchClockMs / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const clockStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    return {
      clock: clockStr,
      score: { ...this.score },
      possession: this.currentPossession,
      gameStateSummary: this.getGameStateSummary(),
      highSalienceMoments: this.getHighSalienceMoments(),
      recentEvents: this.getRecentEvents(),
    };
  }

  public getMatchClockMs() {
    return this.matchClockMs;
  }

  public getRecentEvents(limit: number = 6) {
    return this.processedEvents.slice(-limit);
  }

  public getHighSalienceMoments(limit: number = 4) {
    return this.processedEvents.filter((event) => event.highSalience).slice(-limit);
  }

  public getGameStateSummary() {
    const latestEvent = this.processedEvents[this.processedEvents.length - 1];

    if (!latestEvent) {
      return 'El Clasico is underway and both sides are settling into shape.';
    }

    if (latestEvent.highSalience) {
      return latestEvent.description;
    }

    return `${this.currentPossession} in control with the score ${this.score.home}-${this.score.away}.`;
  }

  public play() { this.isPlaying = true; }
  public pause() { this.isPlaying = false; }
  public restart() {
    this.matchClockMs = 0;
    this.currentIndex = 0;
    this.score = { home: 0, away: 0 };
    this.currentPossession = 'BAR';
    this.processedEvents = [];
    this.isPlaying = true;
  }
}
