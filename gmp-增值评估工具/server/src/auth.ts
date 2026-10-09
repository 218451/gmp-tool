// ===== JWT 签发/校验 + 密码哈希 =====
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config';
import type { Role } from './types';

export interface TokenPayload {
  uid: string;
  name: string;
  role: Role;
}

export function signToken(p: TokenPayload): string {
  return jwt.sign(p, config.jwtSecret, { expiresIn: config.jwtExpiresIn as any });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as TokenPayload;
  } catch {
    return null;
  }
}

export const hashPassword = (plain: string) => bcrypt.hashSync(plain, 10);
export const checkPassword = (plain: string, hash: string) => bcrypt.compareSync(plain, hash);
