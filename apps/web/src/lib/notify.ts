/**
 * "Your room is ready" (docs/01 §8, docs/03 §5).
 *
 * Permission is requested at the *first* processing run and never before —
 * asking on launch is how apps train people to say no. If the user leaves the
 * screen while a room is building, they get told when it's done.
 *
 * This is the local half. Web Push proper (VAPID, a service-worker
 * `push` handler, a server that sends it) needs the hosted API and is not
 * implemented; see CHANGELOG. Everything here works offline and without one.
 */

const ASKED_KEY = "myroom.notify.asked";

export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined";
}

/** Ask once, at a moment where the reason is obvious. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  if (localStorage.getItem(ASKED_KEY) === "1") return Notification.permission;
  localStorage.setItem(ASKED_KEY, "1");
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/**
 * Announce a finished room — but only if the user actually left. Notifying
 * someone about something they are looking at is noise.
 */
export function notifyRoomReady(projectName: string): void {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return;
  try {
    new Notification("Your room is ready", {
      body: `${projectName} is built and waiting.`,
      tag: "room-ready",
    });
  } catch {
    // Some browsers require a service-worker registration to construct one.
    // Not being able to notify is never worth an error.
  }
}
