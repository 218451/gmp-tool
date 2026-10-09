// ===== 运行时配置（集中读取环境变量，提供默认值） =====
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const config = {
  port: num(process.env.PORT, 3000),
  jwtSecret: process.env.JWT_SECRET || 'change-me-to-a-long-random-string',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || '请在 .env 中设置 DEFAULT_ADMIN_PASSWORD',
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  },
  corsOrigin: process.env.CORS_ORIGIN || '*',
  maxPlanRows: num(process.env.MAX_PLAN_ROWS, 2000),
};

export const hasDeepSeek = () => !!config.deepseek.apiKey;
