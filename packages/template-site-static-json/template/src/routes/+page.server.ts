import type { PageServerLoad } from './$types';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getSite } from '../site.config';

export const prerender = true;

const ARTICLES_PER_PAGE = 5;

function getAllArticles() {
  try {
    const contentsPath = join(process.cwd(), 'data', 'contents.json');
    const contentsJson = readFileSync(contentsPath, 'utf-8');
    const allContents = JSON.parse(contentsJson);

    return allContents
      .filter((content: any) => content._meta_type === 'MeetingRecap')
      .sort((a: any, b: any) => new Date(b.publish_date).getTime() - new Date(a.publish_date).getTime());
  } catch {
    return [];
  }
}

function mapArticle(article: any) {
  return {
    id: article.id,
    slug: article.slug,
    title: article.title || '',
    description: article.description || '',
    body: article.body || '',
    publish_date: article.publish_date || article.created_at,
    created_at: article.created_at,
    meeting_id: article.meeting_id,
    council_id: article.council_id,
    category: article.category || null,
  };
}

export const load: PageServerLoad = async ({ parent }) => {
  const { siteConfig } = await parent();

  const articles = getAllArticles();
  const totalArticles = articles.length;
  const totalPages = Math.ceil(totalArticles / ARTICLES_PER_PAGE);

  const articlesData = articles.slice(0, ARTICLES_PER_PAGE).map(mapArticle);

  return {
    siteConfig,
    articles: articlesData,
    events: [],
    pagination: {
      currentPage: 1,
      totalPages,
      totalArticles,
      hasNextPage: totalPages > 1,
      hasPrevPage: false,
    },
  };
};
