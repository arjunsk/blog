import { getCollection } from 'astro:content';

export const siteName = 'AutoInc';

export function sitePath(path = '') {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}/${path.replace(/^\//, '')}`;
}

export const projects = [
  {
    name: 'Tiny DB',
    url: 'https://github.com/dborchard/tiny-db',
  },
  {
    name: 'Tiny Dataframe',
    url: 'https://github.com/dborchard/tiny_dataframe',
  },
  {
    name: 'K-means',
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

const shortDate = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

export function formatShortDate(date: Date) {
  return shortDate.format(date);
}

export function topicAnchor(topic: string) {
  return `topic-${topic.toLowerCase().trim().replace(/\s+/g, '-')}`;
}
