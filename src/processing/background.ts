import type { CandidateGoal } from "./requirements.js";

export type BackgroundFragment = {
  index: number;
  page?: number;
  startLine?: number;
  endLine?: number;
  text: string;
};

export type BackgroundSnapshot = {
  /** New runs freeze evidence review; missing preserves the original review contract. */
  contentReviewPolicy?: "evidence-v1" | "manual-v1";
  /** Frozen new-question policy; absence preserves legacy processing semantics. */
  questionPolicy?: import("../processing/deduplication.js").QuestionPolicy;
  requirements: string[];
  currentRequirements?: true;
  userRequests?: string[];
  classifications?: CandidateGoal["classifications"];
  documents: {
    id: string;
    fileName: string;
    sha256: string;
    extractorVersion: string;
    fragments: BackgroundFragment[];
  }[];
};
