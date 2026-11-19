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

export const publishedWriting = [
  {
    title: 'Build a Tiny Database in Java',
    url: 'https://medium.com/javarevisited/build-a-tiny-database-in-java-ca6d3f06e115',
  },
  {
    title: 'Build a Tiny Compiler in Java',
    url: 'https://medium.com/javarevisited/build-a-tiny-compiler-in-java-662f67a1ce85',
  },
];

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}
