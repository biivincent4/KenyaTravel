export type Destination = {
  id: string;
  name: string;
  region: string;
  eyebrow: string;
  description: string;
  image: string;
  interests: string[];
  dailyUsd: number;
  activities: { id: string; name: string }[];
};

export const destinations: Destination[] = [
  {
    id: "mara",
    name: "Maasai Mara",
    region: "Great Rift Valley",
    eyebrow: "THE WILD, UNFILTERED",
    description:
      "Golden grasslands, extraordinary wildlife, and slow evenings beneath an endless sky.",
    image:
      "https://images.unsplash.com/photo-1516026672322-bc52d61a55d5?auto=format&fit=crop&w=1200&q=85",
    interests: ["Wildlife", "Photography"],
    dailyUsd: 290,
    activities: [
      { id: "mara-drive", name: "Guided game drive" },
      {
        id: "mara-community",
        name: "Community-led cultural visit (subject to consent)",
      },
      { id: "mara-sunset", name: "Sundowner in the conservancy" },
    ],
  },
  {
    id: "diani",
    name: "Diani Beach",
    region: "Indian Ocean coast",
    eyebrow: "A LITTLE MORE BAREFOOT",
    description:
      "Palm-fringed shores, warm turquoise water, and a different kind of Kenyan rhythm.",
    image:
      "https://images.unsplash.com/photo-1500375592092-40eb2168fd21?auto=format&fit=crop&w=1200&q=85",
    interests: ["Beach", "Relaxation"],
    dailyUsd: 170,
    activities: [
      { id: "diani-beach", name: "Beach and leisure time" },
      { id: "diani-reef", name: "Guided reef excursion (weather dependent)" },
      { id: "diani-food", name: "Local coastal food experience" },
    ],
  },
  {
    id: "amboseli",
    name: "Amboseli",
    region: "Southern Kenya",
    eyebrow: "IN THE SHADOW OF GIANTS",
    description:
      "Elephant country, open plains, and Kilimanjaro on the horizon when the clouds allow.",
    image:
      "https://images.unsplash.com/photo-1549366021-9f761d450615?auto=format&fit=crop&w=1200&q=85",
    interests: ["Wildlife", "Photography"],
    dailyUsd: 240,
    activities: [
      { id: "amboseli-drive", name: "Guided elephant and wildlife drive" },
      { id: "amboseli-view", name: "Observation Hill viewpoint" },
    ],
  },
  {
    id: "naivasha",
    name: "Lake Naivasha",
    region: "Great Rift Valley",
    eyebrow: "TAKE THE SCENIC ROUTE",
    description:
      "Lakeside birdlife, acacia-shaded paths, and an easy escape into the Rift Valley.",
    image:
      "https://images.unsplash.com/photo-1472396961693-142e6e269027?auto=format&fit=crop&w=1200&q=85",
    interests: ["Adventure", "Nature"],
    dailyUsd: 150,
    activities: [
      {
        id: "naivasha-boat",
        name: "Guided lake boat ride (weather dependent)",
      },
      { id: "naivasha-walk", name: "Guided nature walk" },
      {
        id: "naivasha-cycle",
        name: "Hell's Gate cycling (park access dependent)",
      },
    ],
  },
  {
    id: "nairobi",
    name: "Nairobi",
    region: "Kenya's capital",
    eyebrow: "THE CITY, REIMAGINED",
    description:
      "A lively introduction to Kenya through local food, craft, and green city escapes.",
    image:
      "https://images.unsplash.com/photo-1611348524140-53c9a25263d6?auto=format&fit=crop&w=1200&q=85",
    interests: ["Culture", "Food"],
    dailyUsd: 130,
    activities: [
      { id: "nairobi-food", name: "Guided Kenyan food tasting" },
      { id: "nairobi-museum", name: "National museum and city introduction" },
      { id: "nairobi-craft", name: "Local craft and design visit" },
    ],
  },
];

export type TravelPackage = {
  id: string;
  name: string;
  subtitle: string;
  days: number;
  route: string[];
  image: string;
  tag: string;
  description: string;
  active: boolean;
};
export const samplePackages: TravelPackage[] = [
  {
    id: "wild-heart",
    name: "The wild heart of Kenya",
    subtitle: "Nairobi · Lake Naivasha · Maasai Mara",
    days: 6,
    route: ["nairobi", "naivasha", "naivasha", "mara", "mara", "mara"],
    image: destinations[0].image,
    tag: "THE SIGNATURE SAFARI",
    description:
      "A gentle introduction, a lakeside interlude, and three days in the Mara. Road transfers, guide, simple lodge accommodation and selected activities included in the illustrative estimate.",
    active: true,
  },
  {
    id: "coastal-slow",
    name: "The art of slowing down",
    subtitle: "Diani Beach · Indian Ocean",
    days: 5,
    route: ["diani", "diani", "diani", "diani", "diani"],
    image: destinations[1].image,
    tag: "COASTAL ESCAPE",
    description:
      "Five unhurried days on the coast with beach accommodation and selected guided experiences. Starts and ends in Diani; arrival transport is not included.",
    active: true,
  },
  {
    id: "elephant-trails",
    name: "On the elephant trail",
    subtitle: "Nairobi · Amboseli",
    days: 4,
    route: ["nairobi", "amboseli", "amboseli", "amboseli"],
    image: destinations[2].image,
    tag: "SMALL TRIP, BIG WONDER",
    description:
      "City flavours, elephant encounters and open-sky evenings. Ends in Amboseli; onward or return transfers are quoted separately.",
    active: true,
  },
];

export const interests = [
  "Wildlife",
  "Beach",
  "Culture",
  "Adventure",
  "Food",
  "Photography",
  "Nature",
  "Relaxation",
];
export const destinationById = (id: string) =>
  destinations.find((d) => d.id === id);
export function transferHours(from: string, to: string): number {
  if (from === to) return 0;
  const hours: Record<string, number> = {
    "mara:naivasha": 5,
    "mara:nairobi": 6,
    "amboseli:nairobi": 5,
    "nairobi:naivasha": 2.5,
    "amboseli:naivasha": 7,
    "amboseli:mara": 10,
    "diani:nairobi": 10,
    "amboseli:diani": 9,
    "diani:naivasha": 12,
    "diani:mara": 14,
  };
  return hours[[from, to].sort().join(":")] ?? 24;
}
