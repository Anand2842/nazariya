// Guided-capture content: what to shoot in each room type, and how.
import type { Target } from "./orientation";

export interface Shot {
  id: string;
  title: string;
  how: string;
}

const COMMON_START: Shot[] = [
  { id: "corner_a", title: "Whole room from a corner", how: "Stand in a corner, hold the phone at chest height and fit as much of the room as you can." },
  { id: "corner_b", title: "Whole room from the opposite corner", how: "Walk to the diagonally opposite corner and repeat." },
];

export const SHOT_LISTS: Record<string, Shot[]> = {
  living: [
    ...COMMON_START,
    { id: "window", title: "Windows & natural light", how: "Face the main window with curtains open. Avoid pointing straight at bright sun." },
    { id: "entry", title: "Entrance / door", how: "Show where you enter the room from." },
    { id: "feature", title: "Best feature", how: "False ceiling, balcony door, flooring or anything worth highlighting." },
  ],
  bedroom: [
    ...COMMON_START,
    { id: "storage", title: "Wardrobe & storage", how: "Open one wardrobe door if it's empty and tidy." },
    { id: "window", title: "Window & view", how: "Capture the window and what's outside." },
    { id: "bath_door", title: "Attached bathroom / balcony door", how: "If the room has one, show the doorway." },
  ],
  kitchen: [
    { id: "overview", title: "Kitchen overview", how: "From the doorway, capture the full counter run." },
    { id: "counter", title: "Counter & stove", how: "Face the hob/chimney straight on." },
    { id: "storage", title: "Cabinets & storage", how: "Show the upper and lower cabinets." },
    { id: "appliances", title: "Appliances & utilities", how: "Fridge space, RO purifier, washing-machine point." },
  ],
  bathroom: [
    { id: "door", title: "From the door", how: "Stand in the doorway and capture the whole bathroom. Close the toilet lid." },
    { id: "fittings", title: "Shower & fittings", how: "Show the shower area, geyser and taps." },
    { id: "basin", title: "Basin & mirror", how: "Angle slightly so you're not in the mirror." },
  ],
  balcony: [
    { id: "overview", title: "Balcony overview", how: "From the door, capture the full balcony." },
    { id: "view", title: "The view", how: "Hold level and capture the view." },
  ],
  dining: [...COMMON_START, { id: "table", title: "Dining table area", how: "Capture the table with chairs pushed in." }],
  lobby: [{ id: "entrance", title: "Entrance", how: "From the main door, looking in." }, ...COMMON_START],
  office: [...COMMON_START, { id: "desks", title: "Work area", how: "Show desks and seating." }, { id: "window", title: "Windows & light", how: "Face the windows." }],
  common: [...COMMON_START, { id: "feature", title: "Facilities", how: "Show seating, TV, games or other facilities." }],
  room: [...COMMON_START, { id: "window", title: "Window & light", how: "Face the window with curtains open." }, { id: "feature", title: "Key feature", how: "Anything a visitor should notice." }],
};

export function shotListFor(roomType: string): Shot[] {
  return SHOT_LISTS[roomType] ?? SHOT_LISTS.room;
}

export const PREP_CHECKLIST = [
  "Switch on all lights and open curtains",
  "Tidy up: clear beds, counters and floors",
  "Keep people and pets out of the shot",
  "Clean the camera lens with a soft cloth",
];

export const MODE_GUIDES = {
  photos: {
    title: "Guided photos",
    steps: ["Hold the phone at chest height and keep it level (watch the level indicator)", "Follow the shot list: each shot tells you where to stand", "Wait for the green ✓ for light and steadiness before tapping"],
  },
  pano: {
    title: "360° capture",
    steps: [
      "Stand in the middle of the room and face a wall",
      "Keep the camera lens in one spot the whole time: step around the phone, don't swing it around your body. In small rooms this matters most (corners are close)",
      "Move the ring onto the one orange dot and hold still. The ring fills and the photo is taken automatically",
      "Dots go clockwise: middle row, then upper row, lower row, ceiling and floor",
      "Best result: put the phone on a small tripod (₹400–800) and turn it on the tripod",
    ],
  },
  video: {
    title: "Walkthrough video",
    steps: [
      "Turn the fan off, switch every light on, and keep people out of the room",
      "Hold the phone sideways at chest height, about 1 m from walls and furniture; walk at half your normal pace",
      "Lap 1 along the walls with the phone pointing across the room, lap 2 through the middle pointing out at the walls",
      "Follow the yellow hints: they appear when the phone points at the ceiling or floor, moves too fast, or sees only a plain wall",
      "2–3 minutes per room; finish where you started",
    ],
  },
} as const;

export const RING_ORDER: Target["ring"][] = ["horizon", "up", "down", "zenith", "nadir"];
export const RING_TEXT: Record<Target["ring"], string> = {
  horizon: "Middle row: keep the phone level",
  up: "Upper row: tilt the phone up",
  down: "Lower row: tilt the phone down",
  zenith: "Ceiling: point straight up",
  nadir: "Floor: point straight down",
};

