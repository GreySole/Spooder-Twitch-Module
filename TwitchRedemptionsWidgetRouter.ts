import { Request, Response, Router } from 'express';
import ModuleService from '../../core/service/ModuleService';
import WidgetSocketChannel from '../../core/service/WidgetSocketChannel';
import { KeyedObject } from '../../Types';
import Twitch, { twitchLog } from './twitch';

// Path shared by the REST routes below and the push channel: the same widget, two
// mechanisms - GET /pending is the one-shot initial state, the socket is live updates
// after that. WS upgrades are dispatched off the raw http.Server before Express ever
// sees them, so reusing the exact path Express also mounts these routes under is fine.
const WIDGET_PATH = '/twitch/widgets/twitch_redemption_queue';
const redemptionSocket = new WidgetSocketChannel(WIDGET_PATH);

// Called by OnEventSubReceived.ts whenever a redemption is added or its status changes,
// so the widget can update without polling. 'add' events are always unfulfilled; 'update'
// carries whatever status Twitch settled the redemption to (fulfilled/canceled included),
// so the widget can drop it from its pending list without a round trip.
export function broadcastRedemptionEvent(kind: 'add' | 'update', event: KeyedObject) {
  redemptionSocket.broadcast({ type: kind, redemption: event });
}

// API for the "Pending Redemptions" widget - a small standalone page (served from
// widgets/twitch_redemption_queue) that lists unfulfilled channel point redemptions with
// approve/refund buttons, so it can sit in a bare iframe. Kept in its own router/file
// rather than folded into TwitchRouter.ts so each widget's surface stays easy to find as
// more widgets are added, instead of one router file growing to cover all of them.
export default function getRedemptionsWidgetRouter() {
  const router = Router();
  redemptionSocket.open();

  function getModule(): Twitch {
    return ModuleService.getStreamModule('twitch') as Twitch;
  }

  // Same guard TwitchRouter.ts uses for its channel point routes, duplicated rather than
  // shared because that copy is private to getTwitchRouters()'s closure.
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

  function redemptionError(error: any): string {
    return error?.response?.data?.message ?? error?.message ?? String(error);
  }

  // Guards against a second Approve/Refund for the same redemption landing while the first
  // is still in flight - two browser tabs on the widget, or a click that beat the button's own
  // `disabled` state to the wire. Each is a real call to Twitch's Update Redemption Status
  // endpoint, so a duplicate here isn't a display glitch: it's a second live EventSub
  // notification for a redemption nothing but this route ever changes the status of.
  const redemptionsInFlight = new Set<string>();

  async function withRedemptionLock(
    res: Response,
    redemptionId: string,
    action: () => Promise<KeyedObject | undefined>,
  ) {
    if (redemptionsInFlight.has(redemptionId)) {
      res.send({ error: 'Already processing this redemption.' });
      return;
    }
    redemptionsInFlight.add(redemptionId);
    try {
      const redemption = await action();
      res.send({ status: 'ok', redemption });
    } catch (error: any) {
      twitchLog('Redemption action error: ', redemptionError(error));
      res.send({ error: redemptionError(error) });
    } finally {
      redemptionsInFlight.delete(redemptionId);
    }
  }

  router.get('/pending', async (req: Request, res: Response) => {
    if (!(await requireBroadcaster(res))) {
      return;
    }

    try {
      const data = await getModule().api.getPendingRedemptions();
      res.send({ data });
    } catch (error: any) {
      twitchLog('Pending redemptions error: ', redemptionError(error));
      res.send({ error: redemptionError(error) });
    }
  });

  router.post('/approve', async (req: Request, res: Response) => {
    if (!(await requireBroadcaster(res))) {
      return;
    }

    const { rewardId, redemptionId } = req.body;
    if (!rewardId || !redemptionId) {
      res.send({ error: 'rewardId and redemptionId are required' });
      return;
    }

    await withRedemptionLock(res, redemptionId, () =>
      getModule().api.updateRedemptionStatus(rewardId, redemptionId, 'FULFILLED'),
    );
  });

  router.post('/refund', async (req: Request, res: Response) => {
    if (!(await requireBroadcaster(res))) {
      return;
    }

    const { rewardId, redemptionId } = req.body;
    if (!rewardId || !redemptionId) {
      res.send({ error: 'rewardId and redemptionId are required' });
      return;
    }

    // CANCELED is Twitch's refund: it returns the channel points to the redeemer, there is
    // no separate refund endpoint.
    await withRedemptionLock(res, redemptionId, () =>
      getModule().api.updateRedemptionStatus(rewardId, redemptionId, 'CANCELED'),
    );
  });

  return router;
}
