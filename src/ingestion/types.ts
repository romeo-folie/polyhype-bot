export interface RawArticle {
  id: string;
  source: string;
  url: string;
  title: string;
  summary: string;
  publishedAt: Date;
}

export interface ScoredArticle extends RawArticle {
  urgencyScore: number;
  keywords: string[];
  scoredAt: Date;
}
