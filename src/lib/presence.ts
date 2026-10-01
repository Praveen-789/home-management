// Presence is process-local: deploy one replica until a shared registry is introduced.
export class PresenceRegistry {
  private sessions = new Map<string, Set<string>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private seen = new Map<string, Date>();
  constructor(private changed: (userId: string, online: boolean, at: Date) => void, private graceMs = 5000) {}

  isOnline(userId: string) { return this.sessions.has(userId); }
  lastSeen(userId: string) { return this.seen.get(userId); }
  onlineUsers() { return [...this.sessions.keys()]; }

  connect(userId: string, sessionId: string) {
    const timer = this.timers.get(userId);
    if (timer) clearTimeout(timer);
    this.timers.delete(userId);
    let sessions = this.sessions.get(userId);
    const wasOnline = !!sessions;
    if (!sessions) { sessions = new Set(); this.sessions.set(userId, sessions); }
    sessions.add(sessionId);
    if (!wasOnline) this.changed(userId, true, new Date());
  }

  disconnect(userId: string, sessionId: string) {
    const sessions = this.sessions.get(userId);
    if (!sessions?.delete(sessionId) || sessions.size) return;
    const at = new Date();
    const timer = setTimeout(() => {
      this.timers.delete(userId);
      this.sessions.delete(userId);
      this.seen.set(userId, at);
      this.changed(userId, false, at);
    }, this.graceMs);
    timer.unref();
    this.timers.set(userId, timer);
  }

  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const userId of this.sessions.keys()) {
      const at = new Date();
      this.seen.set(userId, at);
      this.changed(userId, false, at);
    }
    this.timers.clear();
    this.sessions.clear();
  }
}
