/** Keyword Planner targeting choices, shared by the server and the page. */

export const KEYWORD_LOCATIONS = [
  { id: "2840", label: "United States" },
  { id: "2124", label: "Canada" },
  { id: "2826", label: "United Kingdom" },
  { id: "2036", label: "Australia" },
  { id: "2356", label: "India" },
  { id: "", label: "All locations" },
];

export const KEYWORD_LANGUAGES = [
  { id: "1000", label: "English" },
  { id: "1003", label: "Spanish" },
  { id: "1002", label: "French" },
];

export type Competition = "LOW" | "MEDIUM" | "HIGH" | "UNSPECIFIED" | "UNKNOWN";

export interface KeywordIdea {
  keyword: string;
  avgMonthlySearches: number | null;
  competition: Competition;
  competitionIndex: number | null;
  lowBid: number | null;
  highBid: number | null;
  /** Last 12 months, oldest first. */
  trend: { month: string; searches: number }[];
}

export type KeywordSetupStep = "connect" | "reconnect" | "token" | "account" | "ready";

export interface KeywordStatus {
  step: KeywordSetupStep;
  accounts?: string[];
  customerId?: string;
  loginCustomerId?: string;
  error?: string;
}

/** 1234567890 → 123-456-7890, the way Google Ads shows account IDs. */
export const formatCustomerId = (id: string) => id.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3");
