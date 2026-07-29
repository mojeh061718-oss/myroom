/**
 * English string catalog (docs/09 M6: "localization scaffold; strings
 * externalized; en launch").
 *
 * Keys are `screen.thing`, values are the copy. Nothing here is interpolated by
 * string concatenation — `t()` takes named parameters, because word order is
 * the first thing that changes in another language.
 *
 * Migration status: the capture flow's privacy surface and the shared
 * reconstruction copy live here. The older screens (splash, tutorial, home,
 * drawing board, sandbox) still hold their strings inline; see CHANGELOG.
 */
export const en = {
  "privacy.title": "Your photos, your room",
  "privacy.intro": "Five promises about what happens to what you give us. No defined terms, no cross-references.",
  "privacy.back": "Back to my rooms",
  "privacy.where.title": "Where your room gets built",
  "privacy.where.detecting": "Checking what this device can do\u2026",
  "privacy.deleteHint":
    "You can delete any room, and everything in it, from the menu on its card on the home screen.",

  "privacy.1.title": "Your photos are used for your room, and nothing else",
  "privacy.1.body":
    "Photos and scans you upload are used only to build your own room. They are never used to train models, never shared, and never shown to anyone else.",
  "privacy.2.title": "Nothing leaves your device until you build a room",
  "privacy.2.body":
    "Photos you take or choose stay on this device while you're capturing. They're uploaded only when you start building, and only for that build.",
  "privacy.3.title": "Deleting a room really deletes it",
  "privacy.3.body":
    "Deleting a project removes its photos from this device immediately, and its uploads and generated files from our storage within 24 hours. Completion is recorded, so the promise is auditable rather than aspirational.",
  "privacy.4.title": "Your rooms work offline, because they live here",
  "privacy.4.body":
    "The whole project — the plan, the room, every saved version — is stored on this device first. The cloud is a backup and a way to run reconstruction, not the only copy.",
  "privacy.5.title": "The accuracy badge is not marketing",
  "privacy.5.body":
    "Sketch means the walls are exactly as you drew them and nothing was measured. Photo-calibrated and LiDAR-verified mean measurements were actually taken, from what you provided. We would rather tell you a room is a sketch than imply a precision we didn't earn.",

  "recon.demoNotice":
    "Demo reconstruction: these pieces are examples laid out from your floor plan, not objects detected in your photos.",
  "recon.noPhotos": "No photos yet — add pieces yourself from the catalog whenever you like.",
  "recon.fromScan": "{count} pieces came from your scan, at the sizes it measured.",
  "recon.ready": "Your room is ready",
  "recon.building": "Building your room…",
  "recon.open": "See your room",
  "recon.openAnyway": "Open the room anyway",
  "recon.leaveHint": "You can leave this screen; we'll keep going.",
  "recon.found": "Found: {label} · {size}",

  "notify.roomReadyTitle": "Your room is ready",
  "notify.roomReadyBody": "{name} is built and waiting.",

  "accuracy.sketch": "Sketch",
  "accuracy.photo": "Photo-calibrated",
  "accuracy.lidar": "LiDAR-verified",
  "accuracy.sketch.help": "Walls exactly as you drew them. Anything in the room is an example, not something measured from your photos.",
  "accuracy.photo.help": "Walls exact; object positions within about 6 inches, sizes within 10%.",
  "accuracy.lidar.help": "Shell within about ¾ inch; object positions within 2 inches, sizes within 5%.",
} as const;

export type MessageKey = keyof typeof en;
