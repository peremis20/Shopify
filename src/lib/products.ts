import { Product } from "@/types";

/** YoYo AK-100 wellness catalog. Each product is tagged with the goals it serves. */
export const PRODUCTS: Product[] = [
  {
    id: "ak-focus",
    name: "AK-100 Focus+",
    tagline: "Clean energy & mental clarity",
    description:
      "A nootropic blend of L-theanine, ginseng and B-vitamins to keep you sharp and focused without the crash.",
    price: 34,
    emoji: "🧠",
    color: "from-amber-400 to-orange-500",
    goals: ["energy-focus", "increase-energy"],
    form: "capsules",
    benefits: ["Sharper focus", "Sustained energy", "No jitters"],
  },
  {
    id: "ak-vitality",
    name: "AK-100 Vitality Boost",
    tagline: "All-day natural energy",
    description:
      "Iron, CoQ10 and adaptogens formulated to fight fatigue and power you through busy days.",
    price: 29,
    emoji: "⚡",
    color: "from-yellow-400 to-amber-500",
    goals: ["increase-energy", "energy-focus"],
    form: "gummies",
    benefits: ["Beats fatigue", "Cellular energy", "Daily stamina"],
  },
  {
    id: "ak-dream",
    name: "AK-100 Dream Sleep",
    tagline: "Deeper, restorative rest",
    description:
      "Magnesium glycinate, L-theanine and a touch of melatonin to help you fall asleep faster and wake refreshed.",
    price: 32,
    emoji: "🌙",
    color: "from-indigo-400 to-violet-500",
    goals: ["better-sleep"],
    form: "capsules",
    benefits: ["Fall asleep faster", "Deeper sleep", "Calm mind"],
  },
  {
    id: "ak-shield",
    name: "AK-100 Immune Shield",
    tagline: "Daily defense support",
    description:
      "Vitamin C, zinc, elderberry and vitamin D to reinforce your body's natural defenses year-round.",
    price: 27,
    emoji: "🛡️",
    color: "from-lime-400 to-green-500",
    goals: ["immunity"],
    form: "gummies",
    benefits: ["Immune support", "Antioxidants", "Year-round defense"],
  },
  {
    id: "ak-gut",
    name: "AK-100 Gut Harmony",
    tagline: "Balanced digestion",
    description:
      "A 12-strain probiotic with prebiotic fiber and digestive enzymes for a comfortable, balanced gut.",
    price: 36,
    emoji: "🌿",
    color: "from-emerald-400 to-teal-500",
    goals: ["digestion"],
    form: "capsules",
    benefits: ["Less bloating", "Gut balance", "Better digestion"],
  },
  {
    id: "ak-heart",
    name: "AK-100 Heart Care",
    tagline: "Cardiovascular support",
    description:
      "Omega-3 fish oil with CoQ10 to support healthy cholesterol, circulation and heart function.",
    price: 39,
    emoji: "❤️",
    color: "from-rose-400 to-red-500",
    goals: ["heart-health"],
    form: "liquid",
    benefits: ["Healthy heart", "Omega-3s", "Circulation"],
  },
  {
    id: "ak-glow",
    name: "AK-100 Radiant Glow",
    tagline: "Skin, hair & nails",
    description:
      "Marine collagen, biotin and hyaluronic acid to nourish your skin from within for a natural glow.",
    price: 42,
    emoji: "✨",
    color: "from-pink-400 to-rose-500",
    goals: ["skin-glow"],
    form: "powder",
    benefits: ["Glowing skin", "Stronger hair", "Hydration"],
  },
  {
    id: "ak-lean",
    name: "AK-100 Lean Balance",
    tagline: "Metabolism & weight",
    description:
      "Green tea extract, chromium and fiber to support a healthy metabolism and appetite balance.",
    price: 33,
    emoji: "⚖️",
    color: "from-teal-400 to-cyan-500",
    goals: ["weight"],
    form: "capsules",
    benefits: ["Metabolism support", "Appetite balance", "Lean energy"],
  },
  {
    id: "ak-calm",
    name: "AK-100 Calm & Clarity",
    tagline: "Stress & mood support",
    description:
      "Ashwagandha, rhodiola and magnesium to ease stress and promote a calm, focused mood.",
    price: 31,
    emoji: "🧘",
    color: "from-violet-400 to-indigo-500",
    goals: ["better-sleep", "energy-focus"],
    form: "gummies",
    benefits: ["Stress relief", "Calm focus", "Balanced mood"],
  },
  {
    id: "ak-greens",
    name: "AK-100 Daily Greens",
    tagline: "Whole-food foundation",
    description:
      "40+ superfoods, vitamins and minerals in one scoop — the perfect foundation for any wellness goal.",
    price: 45,
    emoji: "🥬",
    color: "from-green-400 to-emerald-600",
    goals: ["digestion", "immunity", "energy-focus", "weight"],
    form: "powder",
    benefits: ["40+ superfoods", "Full spectrum", "Everyday wellness"],
  },
];

export function getProductById(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

export function getProductsByIds(ids: string[]): Product[] {
  return ids.map((id) => getProductById(id)).filter((p): p is Product => !!p);
}
