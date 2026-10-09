// ===== Prisma 客户端单例 =====
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/** 供 seed 脚本复用同一套 Prisma 客户端 */
export function createPrisma(): PrismaClient {
  return new PrismaClient();
}