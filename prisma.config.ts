import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

function formatUrl(rawUrl: string | undefined): string {
  if (!rawUrl) return '';
  const isLocal = rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1');
  if (!isLocal && !rawUrl.includes('sslmode=')) {
    return `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}sslmode=require`;
  }
  return rawUrl;
}

const directUrl = env('DIRECT_URL');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: formatUrl(directUrl),
  },
});
