/** ===== API 封装：统一注入 Token、统一错误处理 ===== */
import type { User, Role } from './types';

const TOKEN_KEY = 'gmp_token';
const USER_KEY = 'gmp_user';

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const getStoredUser = (): User | null => {
  const s = localStorage.getItem(USER_KEY);
  return s ? (JSON.parse(s) as User) : null;
};
export const setSession = (token: string, user: User) => {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
};
export const clearSession = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  // 仅当 body 非 FormData 时才设置 JSON Content-Type
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, { ...options, headers });

  if (res.status === 401) {
    clearSession();
    // 避免在登录页反复跳转
    if (!location.hash.includes('/login')) location.hash = '#/login';
    throw new ApiError(401, '登录已过期，请重新登录');
  }

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `请求失败（${res.status}）`);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: any) => request<T>(p, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body ?? {}) }),
  patch: <T>(p: string, body?: any) => request<T>(p, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
  upload: <T>(p: string, form: FormData) => request<T>(p, { method: 'POST', body: form }),
};

// ===== 认证接口 =====
export const authApi = {
  login: (username: string, password: string, role: Role) => api.post<{ token: string; user: User }>('/auth/login', { username, password, role }),
  /**
   * 审核员登录。
   * password 可空：组长上传计划时自动建的免密账号只需姓名；
   * 自行注册过的账号需密码（几十个组并行时同名靠密码区分）。
   */
  loginAuditor: (name: string, password = '') =>
    api.post<{ token: string; user: User; projects: any[] }>('/auth/login-auditor', { name, password }),
  register: (body: { name: string; phone: string; password: string; role: string; org?: string }) =>
    api.post<{ ok: boolean; upgraded: boolean; token: string; user: User }>('/auth/register', body),
  me: () => api.get<User>('/auth/me'),
  changePassword: (oldPassword: string, newPassword: string) => api.post('/auth/password', { oldPassword, newPassword }),
};

/** 触发浏览器下载（Word / Excel / CSV 导出） */
export function downloadFile(path: string, fallbackName: string) {
  const token = getToken();
  // 用 fetch + blob 方式携带 Authorization 头
  fetch(`/api${path}`, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (res) => {
      if (!res.ok) throw new Error(`导出失败（${res.status}）`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    })
    .catch((e) => alert(e.message));
}
