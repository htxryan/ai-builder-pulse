import { z } from "zod";

export const CATEGORIES = [
  "Tools & Launches",
  "Model Releases",
  "Techniques & Patterns",
  "Infrastructure & Deployment",
  "Notable Discussions",
  "Think Pieces & Analysis",
  "News in Brief",
] as const;

export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const SourceSchema = z.enum([
  "hn",
  "github-trending",
  "reddit",
  "rss",
  "twitter",
  "mock",
]);
export type Source = z.infer<typeof SourceSchema>;

export const RawItemMetadataSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("hn"),
    points: z.number().int().nonnegative().optional(),
    numComments: z.number().int().nonnegative().optional(),
    author: z.string().optional(),
  }),
  z.object({
    source: z.literal("github-trending"),
    repoFullName: z.string(),
    stars: z.number().int().nonnegative().optional(),
    language: z.string().nullable().optional(),
    starsToday: z.number().int().nonnegative().optional(),
  }),
  z.object({
    source: z.literal("reddit"),
    subreddit: z.string(),
    upvotes: z.number().int().optional(),
    numComments: z.number().int().nonnegative().optional(),
    permalink: z.string().optional(),
  }),
  z.object({
    source: z.literal("rss"),
    feedUrl: z.string().url(),
    author: z.string().optional(),
  }),
  z.object({
    source: z.literal("twitter"),
    handle: z.string(),
    likes: z.number().int().nonnegative().optional(),
  }),
  z.object({
    source: z.literal("mock"),
  }),
]);
export type RawItemMetadata = z.infer<typeof RawItemMetadataSchema>;

export const RawItemSchema = z.object({
  id: z.string().min(1),
  source: SourceSchema,
  title: z.string().min(1),
  url: z.string().url(),
  sourceUrl: z.string().url().optional(),
  score: z.number(),
  publishedAt: z.string().datetime({ offset: true }),
  metadata: RawItemMetadataSchema,
});
export type RawItem = z.infer<typeof RawItemSchema>;

export const ScoredItemSchema = RawItemSchema.extend({
  category: CategorySchema,
  relevanceScore: z.number().min(0).max(1),
  keep: z.boolean(),
  description: z.string().min(1).max(600),
});
export type ScoredItem = z.infer<typeof ScoredItemSchema>;

export const SourceSummarySchema = z.record(
  SourceSchema,
  z.object({
    count: z.number().int().nonnegative(),
    status: z.enum(["ok", "skipped", "error", "timeout"]),
    error: z.string().optional(),
    // Items from this source that survived pre-filter (E3). Optional because
    // pre-filter has not yet run when collectors first emit their summary;
    // populated by applyPreFilter.
    keptCount: z.number().int().nonnegative().optional(),
  }),
);
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

export interface RunContext {
  readonly runDate: string;
  readonly dryRun: boolean;
  readonly repoRoot: string;
  readonly minItemsToPublish: number;
  readonly minSources: number;
}
