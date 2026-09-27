import { KeyedObject, StreamMessage } from '../../Types';
import { EventService, sayInChat } from '../../core/service/EventService';
import { ModerationService } from '../../core/service/ModerationService';
import ModuleService from '../../core/service/ModuleService';
import ShareService from '../../core/service/ShareService';
import { triggerExistsAndEnabled } from '../../core/util/EventTriggerUtil';
import { broadcastRedemptionEvent } from './TwitchRedemptionsWidgetRouter';
import Twitch, { twitchLog } from './twitch';
import parseCheermotes from './functions/parseCheermotes';

// The slice of the Discord module this file's go-live notification touches. Declared
// structurally rather than imported, because twitch and discord are separate repos now and
// either can be installed without the other - a compile-time import of discord's class would
// make this module unbuildable wherever discord is absent. ModuleService already returns
// undefined in that case, and the guard below was always the real contract.
interface DiscordGoLiveNotifier {
  loggedIn: boolean;
  config: KeyedObject;
  api: { findUser: (userId: string) => Promise<{ send: (payload: KeyedObject) => void }> };
  buttons: { makeLinkButton: (label: string, url: string) => { toJSON: () => KeyedObject } };
}

// Twitch's EventSub delivery is at-least-once, on both transports: a keepalive race, a slow
// 2xx on a webhook, or nothing at all on Twitch's end can all make the exact same notification
// arrive twice, and Twitch's own docs say to dedupe on `metadata.message_id` rather than assume
// single delivery. A plain Map is enough here - message ids are opaque strings, and the entries
// are pruned by age below, not by count.
const seenMessageIds = new Map<string, number>();
const MESSAGE_ID_TTL_MS = 10 * 60 * 1000;

function isDuplicateMessage(messageId: string | undefined): boolean {
  if (!messageId) {
    // No id to key on (a test event, say) - nothing to compare against, so let it through.
    return false;
  }
  const now = Date.now();
  for (const [id, seenAt] of seenMessageIds) {
    if (now - seenAt > MESSAGE_ID_TTL_MS) {
      seenMessageIds.delete(id);
    }
  }
  if (seenMessageIds.has(messageId)) {
    return true;
  }
  seenMessageIds.set(messageId, now);
  return false;
}

export default async function OnEventSubReceived(
  type: string,
  event: KeyedObject,
  messageId?: string,
) {
  if (isDuplicateMessage(messageId)) {
    twitchLog(`Ignoring duplicate ${type} delivery (message ${messageId})`);
    return;
  }

  const twitchModule = ModuleService.getStreamModule('twitch') as Twitch;

  try {
    if (
      event.broadcaster_user_name === 'testBroadcaster' ||
      event.to_broadcaster_user_name === 'testBroadcaster'
    ) {
      const broadcasterUserId = event.broadcaster_user_id ?? event.to_broadcaster_user_id;
      const userInfo = await twitchModule.api.getUserInfoById(broadcasterUserId);
      if (event.broadcaster_user_id) {
        event.broadcaster_user_id = broadcasterUserId;
        event.broadcaster_user_name = userInfo?.display_name ?? 'unknown';
        event.broadcaster_user_login = userInfo?.login ?? 'unknown';
      } else if (event.to_broadcaster_user_id) {
        event.to_broadcaster_user_id = broadcasterUserId;
        event.to_broadcaster_user_name = userInfo?.display_name ?? 'unknown';
        event.to_broadcaster_user_login = userInfo?.login ?? 'unknown';
      }
    }

    /*if (event.user_name === 'testFromUser' || event.from_broadcaster_user_name === 'testFromUser') {
      const userId = event.user_id ?? event.from_broadcaster_user_id;
      const userInfo = await twitchModule.api.getUserInfoById(userId);
      if (event.user_id) {
        event.user_id = userId;
        event.user_name = userInfo?.display_name ?? 'unknown';
        event.user_login = userInfo?.login ?? 'unknown';
      } else if (event.from_broadcaster_user_id) {
        event.from_broadcaster_user_id = userId;
        event.from_broadcaster_user_name = userInfo?.display_name ?? 'unknown';
        event.from_broadcaster_user_login = userInfo?.login ?? 'unknown';
      }
    }*/
  } catch (e) {
    console.error('Error fetching user info for test event:', e);
  }

  const streamMessage = {
    userId: event.user_id ?? event.from_broadcaster_user_id,
    username: event.user_login ?? event.from_broadcaster_user_login,
    displayName: event.user_name ?? event.from_broadcaster_user_name,
    platform: 'twitch',
    channel: event.broadcaster_user_login ?? event.from_broadcaster_user_login,
    message: event.user_input ?? '',
    messageType: `twitch-event`,
    respond: (responseTxt: string) => {
      sayInChat(responseTxt, 'twitch', twitchModule.api.homeChannel);
    },
    emotes: [],
    tags: {},
    isBroadcaster: event.broadcaster_user_id == twitchModule.api.broadcasterUserID,
    isMod: false,
    isSubscriber: false,
    isVIP: false,
    isFirstMessage: false,
    isReturningChatter: false,
    platformEventData: {
      type,
      ...event,
    },
  } as StreamMessage;

  twitchLog(`Receiving ${type} request`, event);

  if (event.broadcaster_user_id != twitchModule.api.broadcasterUserID && type != 'channel.raid') {
    if (type == 'stream.online') {
      await twitchModule.api.validateChatbot();
      ShareService.setShare(event.broadcaster_user_login, true);
      const discord = ModuleService.getCommunityModule(
        'discord',
      ) as unknown as DiscordGoLiveNotifier;
      if (!discord) {
        return;
      }
      if (discord.loggedIn == true && discord.config.sharenotif == true) {
        discord.api.findUser(discord.config.master).then((user) => {
          let watchButton = discord.buttons.makeLinkButton(
            'Watch',
            'https://twitch.tv/' + event.broadcaster_user_login,
          );
          user.send({
            content: event.broadcaster_user_name + " is live. I'm going in!",
            components: [watchButton.toJSON()],
          });
        });
      }
    } else if (type == 'stream.offline') {
      ShareService.setShare(event.broadcaster_user_login, false);
    }
    return;
  }

  // Cheermotes are not emotes: the channel.cheer payload carries the raw message text
  // ('Cheer100 pogchamp Kappa250') with no positional data at all, so unlike a chat message
  // there is nothing to hand an overlay that says which parts are art. Resolving them here -
  // rather than leaving it to whatever consumes the event - means the Cheer node's `emotes` and
  // `cheermotes` ports carry the same already-positioned array a chat message's do, and an
  // overlay renders both with one code path.
  if (type == 'channel.cheer') {
    // The guard above already returned for any broadcaster but ours, so this id is the home
    // channel's - passed explicitly rather than left to default so the cheermote set is always
    // the one belonging to the channel the cheer happened in.
    const cheermotes = await twitchModule.api.getCheermotes(event.broadcaster_user_id);
    const matches = parseCheermotes(event.message, cheermotes);
    streamMessage.emotes = matches;
    // Also under its own name so a graph can wire cheermotes specifically without having to
    // filter a mixed emote array by `type`.
    streamMessage.platformEventData!.cheermotes = matches;
  }

  if (type == 'channel.subscription.message') {
    // Twitch sends the resub message as { text, emotes }, not a string. Flattened here so the
    // Message port - and anything reading streamMessage.message - gets the viewer's text; the
    // event's own payload is still whole under platformEventData for anything needing emotes.
    const text = event.message?.text ?? '';
    streamMessage.message = text;
    streamMessage.platformEventData!.message = text;
    streamMessage.platformEventData!.messageEmotes = event.message?.emotes ?? [];
  }

  if (type == 'channel.raid') {
    await twitchModule.api.getBroadcasterId();
    // The Raid trigger node's `isReceived` port: true when this channel is the raid's target,
    // false when this channel is the one raiding out. Twitch sends the same subscription type
    // for both directions, so the only thing telling them apart is which side we're on.
    streamMessage.platformEventData!.isReceived =
      event.to_broadcaster_user_id == twitchModule.api.broadcasterUserID;
  }

  if (type == 'channel.channel_points_custom_reward_redemption.add') {
    // Independent of whether any event-graph trigger below matches this reward - the
    // widget wants every redemption, automated or not.
    broadcastRedemptionEvent('add', event);

    dispatchRedemption(streamMessage, event, 'add');
  } else if (type == 'channel.channel_points_custom_reward_redemption.update') {
    // Covers both the widget's own approve/refund calls and anything else that changed the
    // redemption's status (Twitch's own dashboard, another client, auto-fulfillment).
    broadcastRedemptionEvent('update', event);

    dispatchRedemption(streamMessage, event, 'update');
  } else {
    const events = EventService.getEvents();
    for (let e in events) {
      if (!triggerExistsAndEnabled(events[e], 'twitch')) {
        continue;
      }

      if (events[e].triggers.twitch.type == type) {
        EventService.runCommands(streamMessage, e, 'event', {}, 'twitch');
      }
    }
  }
}

// Matches the redemption against each Channel Point Redeem trigger node by reward id and fires
// only that node's exec branch. Going per node (rather than per event) matters because a graph can
// hold several redeem triggers, and the flat triggers.twitch view only keeps one of them.
// 'add' runs on fulfilled redemptions or when the node overrides auto-fulfill; 'update' runs
// when a non-overriding redemption is later fulfilled (approved by a mod, say).
function dispatchRedemption(
  streamMessage: StreamMessage,
  event: KeyedObject,
  phase: 'add' | 'update',
) {
  const twitchModule = ModuleService.getStreamModule('twitch') as Twitch;
  const modlocks = ModerationService.getModlocks();
  const graphs = EventService.getGraphs();
  const events = EventService.getEvents();
  twitchLog(
    `Redemption ${phase}: reward ${event.reward?.id} (${event.reward?.title}), status ${event.status}`,
  );
  for (const e in graphs) {
    if (!triggerExistsAndEnabled(events[e] ?? { triggers: {} }, 'twitch')) {
      continue;
    }
    for (const node of graphs[e].nodes) {
      if (
        node.kind !== 'callback' ||
        node.moduleName !== 'twitch' ||
        node.nodeTypeId !== 'channel_point_redeem' ||
        !node.values.rewardId ||
        node.values.rewardId != event.reward.id
      ) {
        continue;
      }
      const override = node.values.overrideAutoFulfill == true;
      twitchLog(
        `Redemption ${phase} matched ${e}/${node.id} (override ${override}, status ${event.status}, locked ${modlocks.events[e] == 1})`,
      );
      const shouldRun =
        phase == 'add'
          ? event.status == 'fulfilled' || override
          : !override && event.status == 'fulfilled';
      if (shouldRun) {
        if (modlocks.events[e] != 1) {
          streamMessage.messageType = 'twitch-redeem';
          EventService.runCommandsFromNode(streamMessage, e, node.id);
        } else {
          twitchModule.chat.sayInChat(event.reward.title + ' is locked on my end. Sorry.');
        }
      } else if (phase == 'add' && !override && modlocks.events[e] == 1) {
        twitchModule.chat.sayInChat(
          "MODS! This event is locked on my end. I can't reject it myself because I didn't create it :( please either lift the lock on " +
            e +
            ' or reject it.',
        );
      }
    }
  }
}
