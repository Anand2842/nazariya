// Controlled vocabularies shared by UI and server.

export const SPACE_KINDS: Record<string, string> = {
  apartment: "Apartment / flat",
  room: "Single room / PG room",
  villa: "Villa / independent house",
  office: "Office / commercial",
  hotel_room: "Hotel room",
  retail: "Showroom / retail",
  other: "Other",
};

export const ROOM_TYPES: Record<string, string> = {
  living: "Living room",
  bedroom: "Bedroom",
  kitchen: "Kitchen",
  bathroom: "Bathroom",
  dining: "Dining",
  balcony: "Balcony / terrace",
  lobby: "Lobby / entrance",
  office: "Workspace",
  common: "Common area",
  room: "Room",
  walkthrough: "3D walkthrough",
};

export const HOTSPOT_TYPES: Record<string, string> = {
  info: "Info",
  amenity: "Feature",
  door_to_zone: "Go to room",
  view: "View",
  link: "Link",
};
