import { ThirdPartyEmote } from '../ThirdPartyEmotes';

// What a chat widget actually needs to render a message: an ordered walk of the text where
// native Twitch emotes and community (BTTV/FFZ/7TV) emotes are already resolved to images, so
// the widget itself never has to know Twitch's emote-position format or match emote codes.
export type ChatMessageSegment =
  | { type: 'text'; value: string }
  | { type: 'emote'; code: string; url: string; source: 'twitch' | ThirdPartyEmote['source'] };

export interface NativeEmoteRange {
  id: string;
  start: number;
  end: number;
}

// Twitch's static CDN serves any emote (global, sub, channel) by id with no API call needed -
// this is the same URL shape twitch.tv's own chat renders emotes with.
function nativeEmoteUrl(id: string): string {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/3.0`;
}

// Community emote codes are whitespace-delimited tokens, same as cheermotes - split on runs of
// whitespace so the delimiters themselves pass through as plain text segments unchanged.
const WHITESPACE_SPLIT = /(\s+)/;

function splitThirdPartyEmotes(
  text: string,
  thirdPartyEmotes: Map<string, ThirdPartyEmote>,
): ChatMessageSegment[] {
  if (!text) {
    return [];
  }
  if (thirdPartyEmotes.size === 0) {
    return [{ type: 'text', value: text }];
  }

  const segments: ChatMessageSegment[] = [];
  let pendingText = '';

  for (const token of text.split(WHITESPACE_SPLIT)) {
    const emote = thirdPartyEmotes.get(token);
    if (emote && emote.url) {
      if (pendingText) {
        segments.push({ type: 'text', value: pendingText });
        pendingText = '';
      }
      segments.push({ type: 'emote', code: emote.code, url: emote.url, source: emote.source });
    } else {
      pendingText += token;
    }
  }
  if (pendingText) {
    segments.push({ type: 'text', value: pendingText });
  }
  return segments;
}

// Walks a message once, producing an ordered list of text/emote segments: native Twitch emote
// ranges first (exact character offsets tmi.js hands out), then a community-emote token scan of
// whatever text falls between them. Returns [{type:'text', value: message}] for a plain message
// with nothing to resolve, so a widget can always just iterate `segments`.
export default function parseChatMessageEmotes(
  message: string | undefined,
  nativeEmotes: NativeEmoteRange[] | undefined,
  thirdPartyEmotes: Map<string, ThirdPartyEmote>,
): ChatMessageSegment[] {
  if (!message) {
    return [];
  }

  const ranges = [...(nativeEmotes ?? [])].sort((a, b) => a.start - b.start);
  const segments: ChatMessageSegment[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.start < cursor || range.end < range.start) {
      // Overlapping/out-of-order data from tmi - skip rather than produce a garbled split.
      continue;
    }
    if (range.start > cursor) {
      segments.push(...splitThirdPartyEmotes(message.slice(cursor, range.start), thirdPartyEmotes));
    }
    const code = message.slice(range.start, range.end + 1);
    segments.push({ type: 'emote', code, url: nativeEmoteUrl(range.id), source: 'twitch' });
    cursor = range.end + 1;
  }

  if (cursor < message.length) {
    segments.push(...splitThirdPartyEmotes(message.slice(cursor), thirdPartyEmotes));
  }

  return segments;
}
