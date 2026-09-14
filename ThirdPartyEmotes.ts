import Axios from 'axios';
import { twitchLog } from './twitch';

// The three community emote services chat viewers actually expect to see rendered, on top of
// Twitch's own. None of these need auth - they're public caches each service exposes for
// exactly this purpose - so this has no dependency on the module being logged in.
export interface ThirdPartyEmote {
  code: string;
  url: string;
  source: 'bttv' | 'ffz' | '7tv';
}

interface SourceCache {
  fetchedAt: number;
  emotes: ThirdPartyEmote[];
}

// Emote sets change on the order of days (a broadcaster adding a BTTV/FFZ/7TV emote), not
// months like Twitch's own cheermotes/badges - a shorter TTL keeps a freshly-added emote from
// sitting unrendered for an hour.
const CACHE_MS = 10 * 60 * 1000;

function bttvUrl(id: string): string {
  return `https://cdn.betterttv.net/emote/${id}/2x`;
}

function ffzUrl(urls: Record<string, string> | undefined): string {
  const raw = urls?.['2'] ?? urls?.['4'] ?? urls?.['1'] ?? '';
  return raw.startsWith('//') ? `https:${raw}` : raw;
}

function sevenTvUrl(host: { url: string; files?: { name: string }[] } | undefined): string {
  if (!host?.url) {
    return '';
  }
  const file =
    host.files?.find((f) => f.name === '2x.webp') ??
    host.files?.find((f) => f.name === '1x.webp') ??
    host.files?.[0];
  if (!file) {
    return '';
  }
  const base = host.url.startsWith('//') ? `https:${host.url}` : host.url;
  return `${base}/${file.name}`;
}

// Each source is fetched and cached independently so one service being down or rate-limiting
// doesn't blank the other two - a merge failure anywhere still yields whatever succeeded.
export default class ThirdPartyEmotes {
  private cache: { [source: string]: { [scopeKey: string]: SourceCache } } = {
    bttv: {},
    ffz: {},
    '7tv': {},
  };

  private async fetchBttv(broadcasterId: string): Promise<ThirdPartyEmote[]> {
    const [globalRes, channelRes] = await Promise.all([
      Axios.get('https://api.betterttv.net/3/cache/emotes/global').catch(() => undefined),
      Axios.get(`https://api.betterttv.net/3/cache/users/twitch/${broadcasterId}`).catch(
        () => undefined,
      ),
    ]);
    const globalEmotes = globalRes?.data ?? [];
    const channelData = channelRes?.data;
    const channelEmotes = [
      ...(channelData?.channelEmotes ?? []),
      ...(channelData?.sharedEmotes ?? []),
    ];
    return [...globalEmotes, ...channelEmotes].map((e: any) => ({
      code: e.code,
      url: bttvUrl(e.id),
      source: 'bttv' as const,
    }));
  }

  private async fetchFfz(channelLogin: string): Promise<ThirdPartyEmote[]> {
    const [globalRes, roomRes] = await Promise.all([
      Axios.get('https://api.frankerfacez.com/v1/set/global').catch(() => undefined),
      Axios.get(`https://api.frankerfacez.com/v1/room/${channelLogin}`).catch(() => undefined),
    ]);
    const sets: KeyedObjectAny = {
      ...(globalRes?.data?.sets ?? {}),
      ...(roomRes?.data?.sets ?? {}),
    };
    const emoticons = Object.values(sets).flatMap((set: any) => set?.emoticons ?? []);
    return emoticons.map((e: any) => ({
      code: e.name,
      url: ffzUrl(e.urls),
      source: 'ffz' as const,
    }));
  }

  private async fetch7tv(broadcasterId: string): Promise<ThirdPartyEmote[]> {
    const [globalRes, userRes] = await Promise.all([
      Axios.get('https://7tv.io/v3/emote-sets/global').catch(() => undefined),
      Axios.get(`https://7tv.io/v3/users/twitch/${broadcasterId}`).catch(() => undefined),
    ]);
    const globalEmotes = globalRes?.data?.emotes ?? [];
    const channelEmotes = userRes?.data?.emote_set?.emotes ?? [];
    return [...globalEmotes, ...channelEmotes].map((e: any) => ({
      code: e.name,
      url: sevenTvUrl(e.data?.host),
      source: '7tv' as const,
    }));
  }

  private async refresh(
    source: 'bttv' | 'ffz' | '7tv',
    scopeKey: string,
    fetcher: () => Promise<ThirdPartyEmote[]>,
  ) {
    try {
      const emotes = await fetcher();
      this.cache[source][scopeKey] = { fetchedAt: Date.now(), emotes };
    } catch (e) {
      twitchLog(`getThirdPartyEmotes (${source}) error: `, e);
    }
  }

  // Synchronous read for twitchjsify (chat messages are normalized from a plain synchronous
  // tmi.js handler). Returns whatever's cached per source - stale or empty included - and kicks
  // off a background refresh for any source that's gone stale, mirroring TwitchApi's cheermote/
  // badge cache pattern.
  getCachedEmoteMap(broadcasterId: string, channelLogin: string): Map<string, ThirdPartyEmote> {
    const scopeKey = broadcasterId;
    const sources: ['bttv' | 'ffz' | '7tv', () => Promise<ThirdPartyEmote[]>][] = [
      ['bttv', () => this.fetchBttv(broadcasterId)],
      ['ffz', () => this.fetchFfz(channelLogin)],
      ['7tv', () => this.fetch7tv(broadcasterId)],
    ];

    const merged = new Map<string, ThirdPartyEmote>();
    for (const [source, fetcher] of sources) {
      const cached = this.cache[source][scopeKey];
      if (!cached || Date.now() - cached.fetchedAt >= CACHE_MS) {
        this.refresh(source, scopeKey, fetcher);
      }
      for (const emote of cached?.emotes ?? []) {
        merged.set(emote.code, emote);
      }
    }
    return merged;
  }
}

// Local alias - avoids pulling in Types.ts's KeyedObject just for one internal helper's shape.
type KeyedObjectAny = { [key: string]: any };
