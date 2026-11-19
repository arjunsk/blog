import { getCollection } from 'astro:content';

export const siteName = 'AutoInc';

export function sitePath(path = '') {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}/${path.replace(/^\//, '')}`;
}

export const projects = [
  {
    name: 'Tiny DB',
    description: 'A small relational database with a query planner and storage engine.',
    url: 'https://github.com/dborchard/tiny-db',
  },
  {
    name: 'Tiny Dataframe',
    description: 'A Go dataframe library built on Apache Arrow and Parquet.',
    url: 'https://github.com/dborchard/tiny_dataframe',
  },
  {
    name: 'K-means',
    description: 'A Go implementation of Elkan’s accelerated k-means algorithm.',
    url: 'https://github.com/arjunsk/kmeans',
  },
];

export function getVisiblePosts() {
  return getCollection('posts', ({ data }) => import.meta.env.DEV || !data.draft);
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}
