import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

const directUrl = env('DIRECT_URL');
const url = directUrl && !directUrl.includes('sslmode=')
  ? `${directUrl}${directUrl.includes('?') ? '&' : '?'}sslmode=require`
  : directUrl;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url,
  },
});
