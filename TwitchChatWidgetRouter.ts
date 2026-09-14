import { Request, Response, Router } from 'express';
import ModuleService from '../../core/service/ModuleService';
import WidgetSocketChannel from '../../core/service/WidgetSocketChannel';
import { KeyedObject, StreamMessage } from '../../Types';
import Twitch, { twitchLog } from './twitch';

// Same shared-path pattern as TwitchRedemptionsWidgetRouter.ts: GET /messages is the one-shot
// backlog, the socket is everything live after that.
const WIDGET_PATH = '/twitch/widgets/twitch_chat';
const chatSocket = new WidgetSocketChannel(WIDGET_PATH);

// How much backlog a viewer opening the widget mid-stream gets, and how much a message-deleted/
// user-banned lookup below has to scan. Twitch chat overlays don't need real history - this is
// only ever "what's still on screen".
const MAX_BUFFERED_MESSAGES = 200;
const recentMessages: KeyedObject[] = [];

function toWidgetMessage(message: StreamMessage): KeyedObject {
  return {
    id: message.tags?.id,
    userId: message.userId,
    username: message.username,
    displayName: message.displayName,
    color: message.tags?.color,
    isBroadcaster: message.isBroadcaster,
    isMod: message.isMod,
    isSubscriber: message.isSubscriber,
    isVIP: message.isVIP,
    badges: message.platformEventData?.badges ?? [],
    segments: message.platformEventData?.segments ?? [],
    timestamp: Date.now(),
    removed: false,
  };
}

// Called by TwitchChat.processMessage for every home-channel chat message.
export function broadcastChatMessage(message: StreamMessage) {
  const widgetMessage = toWidgetMessage(message);
  recentMessages.push(widgetMessage);
  if (recentMessages.length > MAX_BUFFERED_MESSAGES) {
    recentMessages.shift();
  }
  chatSocket.broadcast({ type: 'message', message: widgetMessage });
}

// Called by processTwitchMessage.ts for ban/timeout/messagedeleted/clearchat tmi events - these
// fire for moderation done through this widget's own buttons just as much as for another mod or
// the API acting directly, since Twitch relays them over IRC to every client in the room
// regardless of who performed the action. `targetUserId` marks every buffered message from that
// user as removed (ban/timeout/clearchat with no id clears everyone); `targetMsgId` marks one.
export function broadcastModerationEvent(
  kind: 'ban' | 'timeout' | 'messagedeleted' | 'clearchat',
  payload: { targetUserId?: string; targetMsgId?: string },
) {
  for (const buffered of recentMessages) {
    if (payload.targetMsgId && buffered.id === payload.targetMsgId) {
      buffered.removed = true;
    } else if (payload.targetUserId && buffered.userId === payload.targetUserId) {
      buffered.removed = true;
    } else if (kind === 'clearchat' && !payload.targetUserId && !payload.targetMsgId) {
      buffered.removed = true;
    }
  }
  chatSocket.broadcast({ type: 'moderation', kind, ...payload });
}

// API for the "Live Chat" widget - chat with resolved badges/emotes plus moderation buttons.
// Kept in its own file for the same reason as the redemption widget's router: each widget's
// surface stays easy to find on its own rather than growing one shared file.
export default function getChatWidgetRouter() {
  const router = Router();
  chatSocket.open();

  function getModule(): Twitch {
    return ModuleService.getStreamModule('twitch') as Twitch;
  }

  async function requireBroadcaster(res: Response): Promise<boolean> {
    const twitchModule = getModule();
    if (twitchModule.loggedIn === false) {
      res.send({ error: 'nologin' });
      return false;
    }
    if (!twitchModule.oauth.broadcaster_token) {
      res.send({ error: 'NO BROADCASTER TOKEN' });
      return false;
    }

    await twitchModule.api.validateBroadcaster();
    await twitchModule.api.getBroadcasterId();

    if (twitchModule.api.broadcasterUserID == '') {
      res.send({ error: 'NO BROADCASTER USER ID' });
      return false;
    }
    return true;
  }

  function moderationError(error: any): string {
    return error?.response?.data?.message ?? error?.message ?? String(error);
  }

  router.get('/messages', async (req: Request, res: Response) => {
    if (!(await requireBroadcaster(res))) {
      return;
    }
    res.send({ data: recentMessages });
  });

  router.post('/timeout', async (req: Request, res: Response) => {
    if (!(await requireBroadcaster(res))) {
      return;
    }
    const { userId, duration, reason } = req.body;
    if (!userId || !duration) {
      res.send({ error: 'userId and duration are required' });
      return;
    }
    try {
      await getModule().api.timeoutUser(userId, Number(duration), reason);
      res.send({ status: 'ok' });
    } catch (error: any) {
      twitchLog('Chat widget timeout error: ', moderationError(error));
      res.send({ error: moderationError(error) });
    }
  });

  router.post('/ban', async (req: Request, res: Response) => {
    if (!(await requireBroadcaster(res))) {
      return;
    }
    const { userId, reason } = req.body;
    if (!userId) {
      res.send({ error: 'userId is required' });
      return;
    }
    try {
      await getModule().api.banUser(userId, reason);
      res.send({ status: 'ok' });
    } catch (error: any) {
      twitchLog('Chat widget ban error: ', moderationError(error));
      res.send({ error: moderationError(error) });
    }
  });

  router.post('/delete', async (req: Request, res: Response) => {
    if (!(await requireBroadcaster(res))) {
      return;
    }
    const { messageId } = req.body;
    if (!messageId) {
      res.send({ error: 'messageId is required' });
      return;
    }
    try {
      await getModule().api.deleteChatMessage(messageId);
      res.send({ status: 'ok' });
    } catch (error: any) {
      twitchLog('Chat widget delete error: ', moderationError(error));
      res.send({ error: moderationError(error) });
    }
  });

  return router;
}
