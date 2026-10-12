import { z } from 'zod';
import { normalizeSiteUrl, UrlError, type OwnSiteClient, type OwnSiteConn } from '../adapters/index.js';
import { MASK } from './adminSettings.js';
import type { AuditService } from './audit.js';
import type { SettingsStore } from './settings.js';

export class OwnSiteValidationError extends Error {}

const userId = z.string().trim().regex(/^\d{1,12}$/, '用户 ID 必须是数字');

export const ownSitePatchSchema = z.strictObject({
  /** 空串 = 断开（同时清除令牌与用户 ID） */
  url: z.string().trim().max(2048).optional(),
  /** 留空或回传掩码 = 不修改 */
  token: z.string().max(2048).optional(),
  /** null = 清除；留空或回传掩码 = 不修改 */
  userId: z.union([userId, z.literal(''), z.literal(MASK), z.null()]).optional(),
});
export type OwnSitePatch = z.infer<typeof ownSitePatchSchema>;

export const ownSiteTestSchema = z.strictObject({
  url: z.string().trim().max(2048).optional(),
  token: z.string().max(2048).optional(),
  userId: z.union([userId, z.literal(''), z.literal(MASK), z.null()]).optional(),
});

const typed = (v: string | undefined | null) => (v && v !== MASK ? v : undefined);

/** 本站 new-api 的连接配置（设置页）。令牌与用户 ID 加密存储，接口只返回掩码。 */
export class OwnSiteService {
  constructor(
    private readonly deps: { settings: SettingsStore; audit: AuditService; client: OwnSiteClient },
  ) {}

  view() {
    const { settings } = this.deps;
    const url = settings.get('own_site_url') ?? '';
    return {
      url,
      token: settings.has('own_site_token') ? MASK : '',
      tokenSet: settings.has('own_site_token'),
      userId: settings.has('own_site_user_id') ? MASK : '',
      userIdSet: settings.has('own_site_user_id'),
      configured: url !== '' && settings.has('own_site_token'),
    };
  }

  /** 解密后的连接信息；未配置完整时返回 null。仅在内存中短暂存在。 */
  connection(): OwnSiteConn | null {
    const { settings } = this.deps;
    const siteUrl = settings.get('own_site_url');
    const token = settings.has('own_site_token') ? settings.get('own_site_token') : undefined;
    if (!siteUrl || !token) return null;
    return { siteUrl, token, userId: settings.get('own_site_user_id') || undefined };
  }

  private normalize(raw: string): string {
    try {
      return normalizeSiteUrl(raw);
    } catch (err) {
      if (err instanceof UrlError) throw new OwnSiteValidationError(err.message);
      throw err;
    }
  }

  update(patch: OwnSitePatch, ip?: string): void {
    const { settings, audit } = this.deps;
    const changed: string[] = [];
    const currentUrl = settings.get('own_site_url');

    if (patch.url === '') {
      for (const key of ['own_site_url', 'own_site_token', 'own_site_user_id'] as const) settings.delete(key);
      audit.record('settings.updated', { ip, detail: 'ownSite.disconnected' });
      return;
    }
    const token = typed(patch.token);
    if (patch.url !== undefined) {
      const url = this.normalize(patch.url);
      // 换了主机却沿用旧令牌，等于把旧令牌发给新主机：必须同时重新填写
      if (currentUrl && new URL(url).host !== new URL(currentUrl).host && !token) {
        throw new OwnSiteValidationError('修改了本站地址，请同时重新填写本站访问令牌');
      }
      if (url !== currentUrl) {
        settings.set('own_site_url', url);
        changed.push('ownSite.url');
      }
    }
    if (token) {
      settings.set('own_site_token', token);
      changed.push('ownSite.token');
    }
    if (patch.userId === null) {
      if (settings.has('own_site_user_id')) {
        settings.delete('own_site_user_id');
        changed.push('ownSite.userId');
      }
    } else if (typed(patch.userId)) {
      settings.set('own_site_user_id', patch.userId!);
      changed.push('ownSite.userId');
    }
    if (changed.length > 0) audit.record('settings.updated', { ip, detail: changed.join(',') });
  }

  /** 测试连接：不落库。留空的字段沿用已保存的值（但换了主机必须重填令牌）。 */
  async test(input: z.infer<typeof ownSiteTestSchema>): Promise<{ ok: boolean; total: number | null; error: string | null }> {
    const { settings } = this.deps;
    const storedUrl = settings.get('own_site_url');
    const siteUrl = input.url ? this.normalize(input.url) : storedUrl;
    if (!siteUrl) throw new OwnSiteValidationError('请填写本站地址');
    const token = typed(input.token);
    if (storedUrl && new URL(storedUrl).host !== new URL(siteUrl).host && !token) {
      throw new OwnSiteValidationError('修改了本站地址，请重新填写本站访问令牌后再测试');
    }
    const useToken = token ?? (settings.has('own_site_token') ? settings.get('own_site_token') : undefined);
    if (!useToken) throw new OwnSiteValidationError('请填写本站访问令牌');
    const hostChanged = storedUrl !== undefined && new URL(storedUrl).host !== new URL(siteUrl).host;
    const storedUid = hostChanged ? undefined : settings.get('own_site_user_id') || undefined;
    const uid = input.userId === null ? undefined : (typed(input.userId) ?? storedUid);
    const r = await this.deps.client.probe({ siteUrl, token: useToken, userId: uid });
    return r.ok ? { ok: true, total: r.total, error: null } : { ok: false, total: null, error: r.error };
  }
}
