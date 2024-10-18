import { SimplePool, VerifiedEvent, Event } from 'nostr-tools';
import {
  Coordinator,
  type Exchange,
  type Origin,
  type PublicOrder,
  type Settings,
  defaultExchange,
} from '.';
import defaultFederation from '../../static/federation.json';
import { systemClient } from '../services/System';
import { getHost } from '../utils';
import { coordinatorDefaultValues } from './Coordinator.model';
import { updateExchangeInfo } from './Exchange.model';
import eventToPublicOrder from '../utils/nostr';
import { SubCloser } from 'nostr-tools/lib/types/pool';
import RoboPool from '../services/RoboPool';

type FederationHooks = 'onFederationUpdate';

export class Federation {
  constructor(origin: Origin, settings: Settings, hostUrl: string) {
    this.coordinators = Object.entries(defaultFederation).reduce(
      (acc: Record<string, Coordinator>, [key, value]: [string, any]) => {
        if (getHost() !== '127.0.0.1:8000' && key === 'local') {
          // Do not add `Local Dev` unless it is running on localhost
          return acc;
        } else {
          acc[key] = new Coordinator(value, origin, settings, hostUrl);

          return acc;
        }
      },
      {},
    );
    this.exchange = {
      ...defaultExchange,
      totalCoordinators: Object.keys(this.coordinators).length,
    };
    this.book = {};
    this.hooks = {
      onFederationUpdate: [],
    };

    Object.keys(defaultFederation).forEach((key) => {
      if (key !== 'local' || getHost() === '127.0.0.1:8000') {
        // Do not add `Local Dev` unless it is running on localhost
        this.addCoordinator(origin, settings, hostUrl, defaultFederation[key]);
      }
    });

    this.exchange.loadingCoordinators = Object.keys(this.coordinators).length;
    this.loading = true;

    const host = getHost();
    const url = `${window.location.protocol}//${host}`;

    const tesnetHost = Object.values(this.coordinators).find((coor) => {
      return Object.values(coor.testnet).includes(url);
    });
    if (tesnetHost) settings.network = 'testnet';
    this.connection = null;

    this.roboPool = new RoboPool(settings, origin);
  }

  public coordinators: Record<string, Coordinator>;
  public exchange: Exchange;
  public book: Record<string, PublicOrder>;
  public loading: boolean;
  public connection: 'api' | 'nostr' | null;

  public hooks: Record<FederationHooks, Array<() => void>>;

  public roboPool: RoboPool;

  setConnection = (settings: Settings): void => {
    this.connection = settings.connection;

    if (this.connection === 'nostr') {
      this.roboPool.connect();
      this.loadBookNostr();
    } else {
      this.roboPool.close();
      this.loadBook();
    }
  };

  loadBookNostr = (): void => {
    this.loading = true;
    this.book = {};

    this.exchange.loadingCache = this.roboPool.relays.length;

    this.roboPool.subscribeBook({
      onevent: (event) => {
        const { dTag, publicOrder } = eventToPublicOrder(event);
        if (publicOrder) {
          this.book[dTag] = publicOrder;
        } else {
          delete this.book[dTag];
        }
      },
      oneose: () => {
        this.exchange.loadingCache = this.exchange.loadingCache - 1;
        this.loading = this.exchange.loadingCache > 0 && this.exchange.loadingCoordinators > 0;
        this.updateExchange();
        this.triggerHook('onFederationUpdate');
      },
    });
  };

  addCoordinator = (
    origin: Origin,
    settings: Settings,
    hostUrl: string,
    attributes: Record<any, any>,
  ): void => {
    const value = {
      ...coordinatorDefaultValues,
      ...attributes,
    };
    this.coordinators[value.shortAlias] = new Coordinator(value, origin, settings, hostUrl);
    this.exchange.totalCoordinators = Object.keys(this.coordinators).length;
    this.updateEnabledCoordinators();
    this.triggerHook('onFederationUpdate');
  };

  // Hooks
  registerHook = (hookName: FederationHooks, fn: () => void): void => {
    this.hooks[hookName].push(fn);
  };

  triggerHook = (hookName: FederationHooks): void => {
    this.hooks[hookName]?.forEach((fn) => {
      fn();
    });
  };

  onCoordinatorSaved = (): void => {
    if (this.connection === 'api') {
      this.book = Object.values(this.coordinators).reduce<Record<string, PublicOrder>>(
        (book, coordinator) => {
          return { ...book, ...coordinator.book };
        },
        {},
      );
    }
    this.exchange.loadingCoordinators =
      this.exchange.loadingCoordinators < 1 ? 0 : this.exchange.loadingCoordinators - 1;
    this.loading = this.exchange.loadingCache > 0 && this.exchange.loadingCoordinators > 0;
    this.updateExchange();
    this.triggerHook('onFederationUpdate');
  };

  updateUrl = async (origin: Origin, settings: Settings, hostUrl: string): Promise<void> => {
    const federationUrls = {};
    for (const coor of Object.values(this.coordinators)) {
      coor.updateUrl(origin, settings, hostUrl);
      federationUrls[coor.shortAlias] = coor.url;
    }
    systemClient.setCookie('federation', JSON.stringify(federationUrls));
  };

  loadInfo = async (): Promise<void> => {
    this.exchange.info = {
      num_public_buy_orders: 0,
      num_public_sell_orders: 0,
      book_liquidity: 0,
      active_robots_today: 0,
      last_day_nonkyc_btc_premium: 0,
      last_day_volume: 0,
      lifetime_volume: 0,
      version: { major: 0, minor: 0, patch: 0 },
    };
    this.updateEnabledCoordinators();

    for (const coor of Object.values(this.coordinators)) {
      void coor.loadInfo(() => {
        this.onCoordinatorSaved();
      });
    }
  };

  loadLimits = async (): Promise<void> => {
    this.loading = true;
    this.exchange.onlineCoordinators = 0;
    this.exchange.loadingCoordinators = Object.keys(this.coordinators).length;
    this.updateEnabledCoordinators();

    for (const coor of Object.values(this.coordinators)) {
      void coor.loadLimits(() => {
        this.exchange.onlineCoordinators = this.exchange.onlineCoordinators + 1;
        this.onCoordinatorSaved();
      });
    }
  };

  loadBook = async (): Promise<void> => {
    if (this.connection !== 'api') return;

    this.loading = true;
    this.book = {};
    this.triggerHook('onFederationUpdate');
    this.exchange.loadingCoordinators = Object.keys(this.coordinators).length;
    for (const coor of Object.values(this.coordinators)) {
      void coor.loadBook(() => {
        this.onCoordinatorSaved();
        this.triggerHook('onFederationUpdate');
      });
    }
  };

  updateExchange = (): void => {
    this.exchange.info = updateExchangeInfo(this);
    this.triggerHook('onFederationUpdate');
  };

  // Coordinators
  getCoordinator = (shortAlias: string): Coordinator => {
    return this.coordinators[shortAlias];
  };

  disableCoordinator = (shortAlias: string): void => {
    this.coordinators[shortAlias].disable();
    this.updateEnabledCoordinators();
    this.triggerHook('onFederationUpdate');
  };

  enableCoordinator = (shortAlias: string): void => {
    this.coordinators[shortAlias].enable(() => {
      this.updateEnabledCoordinators();
      this.triggerHook('onFederationUpdate');
    });
  };

  updateEnabledCoordinators = (): void => {
    this.exchange.enabledCoordinators = Object.values(this.coordinators).filter(
      (c) => c.enabled,
    ).length;
    this.triggerHook('onFederationUpdate');
  };
}

export default Federation;
